# Phase 04 — sync-neo4j 를 쓰기 전용으로 줄이고 reset-neo4j 를 만든다

**Execution profile**: standard
**Status**: pending

---

## 목표

`sync-neo4j` 에 남은 비적재 관심사를 걷어내 **Neo4j 쓰기 전용**으로 만든다.
그리고 지금까지 손으로 하던 초기화 절차에 이름을 준다.

`sync.ts` 는 시작 시점 875줄이었고 이 phase 이후 **330~360줄**이 목표다.

계획 초안은 200줄이라고 적었는데 도달 불가다. 쓰기 경로(`sync.ts` 595~875)만 281줄이고
여기에 import·타입·`loadGraph`·`writeGraphToNeo4j` 가 더해진다.
줄 수를 맞추려 쓰기 로직을 억지로 쪼개지 마라 — 목표는 관심사 분리이지 줄 수가 아니다.

**범위 외**

- 정규화 로직 변경 — 이번 plan 전체에서 하지 않는다
- Neo4j 스키마 변경 — 노드 라벨·관계 유형·제약·인덱스는 그대로다
- staging 인스턴스(7689) 신설 — 별도 계획의 몫이다

---

## 작업 항목 (4)

### 1. 죽은 마이그레이션 두 개를 삭제한다

`sync.ts` 의 `writeGraphToNeo4j` 가 매 적재마다 조건 없이 두 함수를 실행한다.

| 함수 | 목적 | 실측 |
| --- | --- | --- |
| `migrateTaskNumberType` | `Task.number` 를 문자열·소수에서 정수로 | 적재기가 `databaseKey` 로 **이미 정수를 쓴다.** 그래프 490건 전부 `INTEGER NOT NULL` |
| `removeLegacyUnknownTagDimensions` | `TAGGED{dimension:'unknown'}` 삭제 | `dimension` 이 `0`·`1`·`2` 뿐. `unknown` **0건** |

둘 다 옛 코드로 적재된 그래프를 고치려던 것이고 현재 적재기는 그 상태를 만들지 않는다.
**함수와 호출을 모두 삭제한다.**

삭제 전에 위 실측을 **직접 재확인하라.** 출력을 보고에 남긴다.

```cypher
MATCH (t:Task) RETURN valueType(t.number) AS type, count(*) AS c
MATCH ()-[r:TAGGED]->() RETURN r.dimension AS dim, count(*) AS c
```

**확인 대상은 운영 그래프(`bolt://localhost:7687`)다. 사용자가 이 건에 한해 승인했다.**
테스트 인스턴스가 없어 다른 곳에서는 확인할 수 없고, 빈 그래프에서 세어도 의미가 없기 때문이다.

지켜야 할 조건이다.

- **읽기 전용 Cypher 두 개만 실행한다.** 위 두 문장 외에는 아무것도 보내지 마라
- `CREATE`·`MERGE`·`SET`·`DELETE`·`DETACH`·`apply-schema`·`sync-neo4j` 는 **어떤 형태로도 금지**한다
- 실행한 쿼리문과 원본 출력을 보고에 그대로 남긴다

실측이 다르면(문자열 `number` 나 `unknown` dimension 이 있으면) **삭제하지 말고 보고하라.**

### 2. `apps/pipeline/src/neo4j/reset.ts` — 초기화 명령

```
pnpm --filter pipeline reset-neo4j --force [--project <code>]
```

동작 순서다.

1. 대상 URI 를 확인한다. **포트가 `7687`(운영)이면 즉시 예외로 중단한다**
2. `--force` 가 없으면 거부한다
3. 실행 전 대상 URI 와 현재 노드·관계 수를 출력한다
4. `MATCH (n) DETACH DELETE n` 을 실행한다
5. 삭제 후 노드 수가 0 인지 확인해 출력한다

**삭제 범위는 전체다.** 프로젝트 단위 삭제는 만들지 마라 —
`Task.number` 가 key 라서 프로젝트가 달라도 같은 번호는 같은 노드다. 부분 삭제가 안전하지 않다.
`--project` 인자는 출력 표기용으로만 받는다.

포트 가드는 기존 구현을 참고하라 — `apps/api/test/helpers/e2e-env.js` 의
`assertTestDatabaseUri` 와 `PRODUCTION_BOLT_PORT` 다 (`run-e2e.js` 에는 가드가 없다).

그 구현의 핵심은 `new URL(uri).port || PRODUCTION_BOLT_PORT` 다.
**포트를 생략한 URI(`bolt://localhost`)도 7687 로 간주해 거부한다.**
포트 문자열만 비교하면 이 경우가 빠져나간다.

### 3. `sync.ts` 를 쓰기 전용으로 정리한다

남길 것과 없앨 것이다.

| 대상 | 처리 |
| --- | --- |
| `mergeNodes`·`mergeRelationships` 계열, `prepareRelationshipRows`, `splitRowsByIdentity`, `mergeRowsWithIdentity`, `mergeRowsWithoutIdentity` | 남긴다 |
| `sanitizeProperties`·`stripResolverProperties` | 남긴다 (쓰기 직전 정리) |
| `collectStats` | 남긴다 |
| `databaseKey` | 남긴다 (적재 키 변환은 쓰기 관심사다) |
| 읽기 함수 | Phase 03 에서 `io.ts` 로 이동 완료. 잔재가 있으면 제거 |
| 자체 `parseArgs`·`readFlag` | Phase 03 에서 `cli-options.ts` 로 공용화 완료. 잔재 제거 |
| `NEO4J_URI` 기본값 | **그대로 둔다.** 파이프라인 설정 정리는 이번 범위가 아니다 |

### 4. 단계 등록과 문서 반영

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/package.json` | `reset-neo4j` 스크립트 추가 |
| `README.md` | 초기화 절차를 `reset-neo4j --force` 로 갱신 |

`reset-neo4j` 도 `sync-neo4j`·`resolve-graph` 와 같이 **독립 진입점**이다
(`node dist/neo4j/reset.js`). `main.ts` 의 `KNOWN_STAGES` 는 건드리지 않는다 —
그 상수는 `cli-options.ts` 가 아니라 `main.ts:26` 에 있고, 독립 진입점은 거기 등록되지 않는다.

`docs/` 는 이미 갱신돼 있다 (`docs/adr/0004-resolve-as-inspection-stage.md`,
`docs/flow.md`, `docs/data-schema.md`). **다시 쓰지 마라.**
문서와 구현이 어긋나는 곳만 찾아 보고하라.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/neo4j/reset.ts` | 신규 |
| `apps/pipeline/src/neo4j/sync.ts` | 수정 — 마이그레이션 삭제, 잔재 정리 |
| `apps/pipeline/package.json` | 수정 — 스크립트 |
| `README.md` | 수정 — 초기화 절차 |
| 테스트 | 추가 — 아래 검증 참조 |

---

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

`pnpm --filter api test` 는 쓰지 마라 — exit 0 으로 조용히 통과한다. 테스트 **개수**를 확인하라.
`format:check` 가 걸려도 포맷터를 파일 전체에 돌리지 마라. 손댄 줄만 고친다.

### 가드 테스트와 변이 검증 (필수)

- `--force` 없이 실행하면 거부하는지
- 대상 포트가 `7687` 이면 거부하는지
- **변이 검증** — 두 가드를 각각 무력화했을 때 해당 테스트가 실제로 실패하는지 확인하고 원복한다.
  `git status` 가 깨끗한지 보여라

가드 테스트는 **실제로 DB 에 접속하지 않고** 판정되어야 한다. 접속 전에 거부하는 것이 요점이다.

### 적재 결과 동등성 (이 plan 전체의 통과 조건)

`sync.ts` 에서 정규화·읽기·마이그레이션을 걷어냈으므로 적재 결과가 같은지 증명해야 한다.
**줄 수는 통과 조건이 아니다** — 위 목표의 330~360줄은 방향을 가리키는 값이다.

```bash
# cwd: 저장소 루트
# 1. 현재 통계 기록
# 2. reset-neo4j --force 로 초기화
# 3. apply-schema
# 4. sync-neo4j 로 재적재
# 5. 노드·관계 통계가 1번과 동일한지 확인
```

**대상 인스턴스를 반드시 명시하라.**

**대상은 `bolt://localhost:7690` 이다.** 조정자가 일회용 컨테이너를 띄워 뒀다
(`devloop-plan001-neo4j`, tmpfs, 인증 `neo4j/devloop-test-password`).

```bash
# cwd: 저장소 루트
export NEO4J_URI=bolt://localhost:7690
export NEO4J_USER=neo4j
export NEO4J_PASSWORD=devloop-test-password
pnpm --filter pipeline reset-neo4j --force
```

`NEO4J_AUTH` 대신 `NEO4J_USER`·`NEO4J_PASSWORD` 를 쓰는 이유는 Phase 02 와 같다 —
`neo4jCredentials()` 가 그 둘을 먼저 보고 `NEO4J_AUTH` 를 무시한다.

`NEO4J_URI` 를 지정하지 않으면 **운영 그래프(7687)** 로 간다.
`.env` 때문이 아니라 코드 기본값(`sync.ts` 의 `process.env.NEO4J_URI ?? "bolt://localhost:7687"`)
때문이다 — 파이프라인은 `.env` 를 읽지 않는다.
실제로 이 실수로 운영 그래프가 오염된 사례가 있다 — fixture 검증 중 기존 업무 노드가
같은 `number` 키로 병합됐다.

- 7688 은 다른 프로젝트가 점유 중이고 7687 은 운영이다. **둘 다 쓰지 마라**
- **운영 그래프에 쓰지 마라** — 1번 항목의 읽기 전용 확인만 예외다
- 7690 이 안 떠 있으면 직접 띄우지 말고 조정자에게 알려라

위 1~5번 절차의 "현재 통계" 는 운영 그래프 값이 아니라
**Phase 02 가 plan 착수 전 코드로 7690 에 적재해 뽑아 둔 값**이다.

`tasks/plan001-resolve-graph-stage/baseline-load-stats.{summary,nodes,rels}.txt` 세 파일을
그대로 재사용한다. plan 전체의 동등성을 보려면 기준값이 착수 전 값이어야 한다 —
Phase 03 종료 시점 값이 아니다.

컨테이너가 재기동됐으면 적재 전에 순서를 지켜라.

1. `pnpm apply-schema` 를 다시 돌린다 (tmpfs 라 제약·인덱스가 사라졌다)
2. `MATCH (n) RETURN count(n)` 이 0 인지 확인한다 (MERGE 전용이라 잔여 데이터가 통계를 부풀린다)
3. 적재한다

기준값 파일이 없어졌으면 plan 착수 커밋(`e708f47` 이전 구현 커밋 없음)을 체크아웃해 다시 뽑는다.
"기준값이 없으니 검증 불가" 로 가지 마라.

---

## 의도 메모 (왜)

- **마이그레이션을 분리하지 않고 삭제하는 이유** — 적재기가 그 상태를 만들지 않으므로 죽은 코드다.
  옛 그래프를 만나면 `reset-neo4j` 후 재적재로 다룬다. `jsonl` 이 남아 있어 항상 가능하다.
  마이그레이션 자리가 필요해지면 그때 만든다 — 지금 만들면 빈 껍데기다
- **`reset-neo4j` 를 만드는 이유** — 초기화가 이 저장소의 표준 절차인데 이름이 없어
  매번 손으로 Cypher 를 쳤다. 그 과정에서 대상을 잘못 지정하는 사고가 실제로 났다
- **프로젝트 단위 삭제를 만들지 않는 이유** — `Task.number` 가 프로젝트를 구분하지 않는다.
  부분 삭제는 다른 프로젝트 노드를 지울 수 있다
- **`NEO4J_URI` 기본값을 남기는 이유** — 파이프라인 설정을 config 로 모으는 것은 별개 관심사다.
  API 는 이미 정리했고(ADR 0003) 파이프라인은 후속 작업이다

근거 문서 — `docs/adr/0004-resolve-as-inspection-stage.md`, `docs/data-schema.md`

---

## Blocked 조건

- 테스트용 Neo4j 인스턴스(7690)가 없어 적재 동등성을 확인할 수 없으면
  `PHASE_BLOCKED: 테스트 Neo4j 부재로 적재 동등성 검증 불가` 를 출력하고,
  **가드 테스트와 단위 테스트까지는 완료한 상태로** 종료한다.
  7688·7687 로 대체하지 마라
- 1번의 실측이 문서와 다르면(문자열 `Task.number` 나 `unknown` dimension 존재)
  `PHASE_BLOCKED: 마이그레이션이 아직 필요한 데이터 발견` 을 출력하고 삭제하지 않는다
- 1번의 읽기 전용 확인 자체를 할 수 없으면(7687 접속 불가 등)
  `PHASE_BLOCKED: 마이그레이션 실측 확인 불가` 를 출력하고 **삭제하지 않는다.**
  확인 없이 지우지도, 다른 인스턴스로 대체하지도 마라 — 빈 그래프에서 센 값은 근거가 아니다.
  이때 나머지 작업(2·3·4번)은 그대로 완료한다

---

## 마지막 phase 마무리

이 plan 의 마지막 phase 다. 검증을 모두 통과한 뒤 다음을 처리한다.

- `tasks/plan001-resolve-graph-stage/index.json` 에서 이 phase 의 `status` 를 `completed` 로 바꾼다
- 네 phase 가 모두 `completed` 이면 최상위 `status` 도 `completed` 로 바꾼다
- 어느 phase 든 `PHASE_BLOCKED` 로 끝났으면 **`completed` 로 바꾸지 말고** 그 사유를 보고한다

**적재 동등성 미검증을 사유로 한 예외는 없다.** 7690 인스턴스가 있으므로 검증할 수 있다.

7690 이 죽어 검증을 못 하는 상황은 예외 사유가 아니라 **조정자가 컨테이너를 다시 띄워 풀 일**이다.
기준값도 잃지 않는다 — `baseline-load-stats.*` 는 컨테이너 밖 파일이고,
설령 지워져도 plan 착수 커밋을 체크아웃해 다시 적재하면 같은 값이 나온다. 잃는 것은 시간뿐이다.

그래도 무언가를 건너뛴 채 끝내야 하면 `index.json` 에 **두 곳**에 남긴다.
phase 항목에만 두면 최상위 `status` 만 읽는 사람에게 안 보인다 —
이 저장소는 부분 재측정을 전체로 단정한 사고를 겪었다.

```json
{
  "status": "completed",
  "blocked_checks": ["Phase 04: <무엇을 왜 못 봤는지>"],
  "phases": [
    { "number": 4, "status": "completed", "blocked_checks": ["<같은 내용>"] }
  ]
}
```

건너뛴 검증이 없으면 `blocked_checks` 필드 자체를 넣지 마라. 빈 배열도 두지 않는다.

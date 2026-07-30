# Phase 02 — Neo4j 변수를 이관하고 URI 를 필수로 만든다

**Execution profile**: standard
**Status**: pending

---

## 목표

`NEO4J_*` 네 종을 Phase 01 이 만든 설정 모듈로 옮긴다.
그리고 **`NEO4J_URI` 를 필수로 만들어 코드 기본값을 없앤다.**

**이 phase 는 의도된 동작 변경을 포함한다.** 아래 3번을 반드시 읽어라.

**범위 외**

- `LLM_*`·`PIPELINE_DATA_DIR` — Phase 03
- `reset-neo4j` 의 `--allow-production` 판정 로직. 이미 옳다. 건드리지 마라

---

## 이관 대상 (7곳)

| 파일·줄 | 현재 |
| --- | --- |
| `neo4j/neo4j-config.ts:2` | `NEO4J_USER` |
| `neo4j/neo4j-config.ts:3` | `NEO4J_PASSWORD` |
| `neo4j/neo4j-config.ts:8` | `NEO4J_AUTH`, 기본값 `neo4j/devloop-password` |
| `neo4j/sync.ts:286` | `NEO4J_URI`, 기본값 `bolt://localhost:7687` |
| `neo4j/apply-schema.ts:7` | `NEO4J_URI`, 기본값 `bolt://localhost:7687` |
| `concepts/audit.ts:84` | `NEO4J_URI`, 기본값 `bolt://localhost:7687` |
| `neo4j/reset.ts:107` | `NEO4J_URI`, **기본값 없음** |

줄 번호는 작성 시점 기준이다. 옮기기 전에 실제 위치를 다시 확인하라.

---

## 작업 항목 (4)

### 1. 스키마에 네 값을 더한다

| 값 | 필수 | 기본값 |
| --- | --- | --- |
| `NEO4J_URI` | **필수** | 두지 않는다 |
| `NEO4J_AUTH` | 선택 | `neo4j/devloop-password` |
| `NEO4J_USER` | 선택 | 없음 |
| `NEO4J_PASSWORD` | 선택 | 없음 |

`NEO4J_AUTH` 와 `NEO4J_USER`·`NEO4J_PASSWORD` 의 우선순위는 **현재 동작을 그대로 유지한다**
(`neo4j-config.ts` 를 읽고 어느 쪽이 이기는지 확인해 그대로 옮겨라). 이 우선순위를 바꾸지 마라.

### 2. 일곱 곳을 설정 인자로 바꾼다

각 명령이 설정을 인자로 받아 쓴다. `process.env` 직접 읽기를 남기지 마라.

`reset.ts` 는 이미 자체 필수 검사를 갖고 있다. 설정 쪽이 필수를 보장하면 그 검사가 중복이 되는데,
**중복을 지우지 말고 남겨라.** 이유는 아래 의도 메모에 있다.

### 3. `NEO4J_URI` 필수화 — 의도된 동작 변경

세 곳(`sync`·`apply-schema`·`audit`)이 기본값 `bolt://localhost:7687` 에 의존한다.
필수로 바꾸면 **`NEO4J_URI` 없이는 그 세 명령이 실패한다.**

이 변경을 택한 이유는 실제 사고다 — 대상을 지정하지 않은 실행이 운영 그래프에 적재해
기존 업무 노드가 같은 키로 병합됐다. `reset-neo4j` 는 그래서 이미 기본값을 없앴다.
이제 네 진입점의 정책을 같게 만든다.

반드시 함께 처리할 것이다.

- **`README.md` 의 명령 예시를 갱신한다** — `NEO4J_URI` 가 필요하다는 것이 드러나야 한다
- `.env` 에 `NEO4J_URI` 가 있으므로 Phase 01 의 로딩 덕에 **일반 사용 흐름은 깨지지 않는다.**
  그 사실을 실제로 확인하고 보고에 적어라
- 오류 메시지에 **어떤 변수가 없는지 이름을 밝힌다.** "설정이 잘못됐다" 류로 적지 마라

### 4. `docs/flow.md` 반영

`reset-neo4j` 행에 적힌 "`NEO4J_URI` 필수" 가 이제 네 명령 모두에 해당한다.
표를 실제 동작과 맞춰라. 문서와 구현이 어긋나는 곳만 고친다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/config/pipeline-config.schema.ts` | 수정 — 네 값 추가 |
| `apps/pipeline/src/neo4j/neo4j-config.ts` | 수정 |
| `apps/pipeline/src/neo4j/sync.ts` | 수정 |
| `apps/pipeline/src/neo4j/apply-schema.ts` | 수정 |
| `apps/pipeline/src/neo4j/reset.ts` | 수정 |
| `apps/pipeline/src/concepts/audit.ts` | 수정 |
| `apps/pipeline/src/main.ts` | 수정 — 설정 주입 |
| `README.md` | 수정 — 명령 예시 |
| `docs/flow.md` | 수정 — 필수 조건 |
| 테스트 | 추가 |

---

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

테스트 **개수**를 확인하라. api 51 불변, pipeline 은 Phase 01 결과에서 늘어야 한다.

### 필수화 가드 테스트 (필수)

- `NEO4J_URI` 가 없으면 기동이 실패하고 **변수 이름이 메시지에 나온다**
- 자격증명 우선순위(`NEO4J_AUTH` 대 `NEO4J_USER`·`NEO4J_PASSWORD`)가 이전과 같다
- **변이 검증** — 필수 판정을 무력화했을 때 그 테스트가 실제로 실패하는지 확인하고 원복한다.
  `git status` 가 깨끗한지 보여라

### 동작 불변 확인 (자격증명 경로)

`resolve-graph` 는 Neo4j 를 쓰지 않으므로 적재로 확인해야 한다.

```bash
# cwd: 저장소 루트
export NEO4J_URI=bolt://localhost:7690
export NEO4J_AUTH=neo4j/devloop-test-password
pnpm --filter pipeline sync-neo4j --project tc-ocr --data-dir "$(pwd)/apps/pipeline/data"
```

- **대상은 테스트 인스턴스다.** `docker compose --profile test up -d neo4j-test` 로 띄운다
- **7687 에 쓰지 마라.** 운영 그래프다
- 7688 은 다른 프로젝트 컨테이너가 점유할 수 있다. 점유돼 있으면 다른 포트로 일회용 컨테이너를 띄우고
  **어느 포트를 썼는지 보고에 적어라**
- 적재 후 노드·관계 통계를 이전 코드 결과와 비교한다. 같아야 한다

테스트 인스턴스를 띄울 수 없으면 `PHASE_BLOCKED` 로 남기고 단위 테스트까지 완료한 상태로 종료한다.

---

## 의도 메모 (왜)

- **`reset.ts` 의 중복 검사를 남기는 이유** — 그 검사는 삭제 명령의 안전 장치다.
  설정 계층을 나중에 누가 고쳐 필수를 풀어도 삭제만은 막혀야 한다.
  가드는 겹쳐도 손해가 없고, 없으면 되돌릴 수 없는 손실이 난다
- **기본값을 없애는 것이 동작 변경임을 phase 에 명시하는 이유** — 이 plan 의 나머지는 동작 불변이다.
  변경 지점을 한곳으로 좁혀 두면 회귀가 났을 때 원인을 바로 지목할 수 있다
- **Neo4j 를 먼저 옮기는 이유** — 사고가 났던 경로이고, `.env` 로딩이 실제로 동작하는지 검증하는
  가장 강한 실측이다

---

## Blocked 조건

- 테스트용 Neo4j 를 띄울 수 없어 적재 동등성을 확인할 수 없으면
  `PHASE_BLOCKED: 테스트 Neo4j 부재로 적재 동등성 검증 불가` 를 출력하고,
  **가드 테스트와 단위 테스트까지는 완료한 상태로** 종료한다. 7687 로 대체하지 마라

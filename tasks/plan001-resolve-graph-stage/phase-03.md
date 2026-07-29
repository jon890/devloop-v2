# Phase 03 — resolve-graph 명령과 입출력 계층을 붙인다

**Execution profile**: standard
**Status**: pending

---

## 목표

Phase 02 에서 만든 순수 함수 `resolveGraph` 에 **입출력을 붙여 CLI 단계로 만든다.**
정규화 결과를 파일로 내놓아 별칭 사전 변경 효과를 **적재 없이** 비교할 수 있게 한다.

```bash
# cwd: 저장소 루트
pnpm --filter pipeline resolve-graph --out /tmp/before.jsonl
# 사전 수정
pnpm --filter pipeline resolve-graph --out /tmp/after.jsonl
cmp /tmp/before.jsonl /tmp/after.jsonl
```

**범위 외**

- `sync-neo4j` 축소·`reset-neo4j` 신설·죽은 마이그레이션 삭제 — Phase 04
- `sync-neo4j` 가 `resolved.jsonl` 을 **읽게 만들지 마라.** 이건 설계 결정이다 (아래 의도 메모 참조)

---

## 작업 순서 (작업 항목보다 먼저 읽어라)

아래는 작업이 아니라 **순서 제약**이다. 실제 코드 변경은 전부 작업 항목 1번에 있다.

### 뒤집으면 워크트리가 깨진 채 남는다

`sync.ts` 의 `readJsonlRecords` 는 `graph/<project>/` 의 **`*.jsonl` 을 전부 읽고**,
`conceptSource` 는 `parsed.jsonl`·`inferred.jsonl` 이외의 파일명을 만나면 예외를 던진다.

즉 `resolved.jsonl` 을 기본 경로에 쓰는 순간 그다음 `sync-neo4j` 가 죽는다.
CLAUDE.md 에 적힌 e2e fixture 사고와 **같은 실패 방식**이다.

그래서 순서를 못박는다.

1. 먼저 `io.ts` 의 `readResolveInput` 을 **파일명을 명시해 읽는 방식**으로 만들고
   `sync.ts` 가 그것을 쓰게 바꾼다 (`readJsonlRecords` 의 디렉터리 훑기를 대체한다)
2. 그 뒤에야 `resolve-graph` 가 `resolved.jsonl` 을 쓰게 한다

1번을 건너뛰고 2번을 먼저 하면 그 시점부터 적재가 깨진다.

**회귀 테스트를 반드시 남겨라.** `graph/<project>/` 에 `resolved.jsonl` 이 있는 상태에서도
입력 읽기가 `parsed.jsonl`·`inferred.jsonl` 만 집어 오는지 단언한다.
이게 없으면 같은 사고가 조용히 재발한다.

순서 제약은 사람이 지키는 규율이라 그것만으로는 약하다. 기계 검증을 하나 붙인다.
완료 조건이며 **출력이 비어야 한다.**

```bash
# cwd: 저장소 루트
grep -n "readdir" apps/pipeline/src/resolve/io.ts apps/pipeline/src/neo4j/sync.ts
```

회귀 테스트가 "`resolved.jsonl` 이 안 딸려 온다" 를 보장한다면,
이 grep 은 "애초에 디렉터리를 훑지 않는다" 를 보장한다.

---

## 작업 항목 (4)

### 1. `apps/pipeline/src/resolve/io.ts` — 읽기·쓰기 계층

```ts
export async function readResolveInput(dataDir: string, project: string): Promise<ResolveInput>;
export async function writeResolved(outPath: string, result: ResolveResult): Promise<void>;
export async function writeResolveReport(outPath: string, result: ResolveResult): Promise<void>;
```

`readResolveInput` 은 다섯 입력을 읽는다. `ResolveInput` 의 필드와 일대일로 대응한다.

| 입력 | 경로 | 없을 때 |
| --- | --- | --- |
| `parsed.jsonl` | `<dataDir>/graph/<project>/` | **즉시 실패.** 필수 입력이다 |
| `inferred.jsonl` | 같은 위치 | **경고하고 빈 배열로 진행.** 구조만으로도 그래프가 성립한다 |
| Concept 사전 | `<dataDir>/concepts/<project>.json` | 코어 사전만으로 진행 (기존 동작) |
| raw 문서 (`endpointIndex` 재료) | `<dataDir>/raw/<project>/` | `io.ts` 는 **기존 동작 유지**. 엄격 판정은 `cli.ts` 가 한다 (아래) |
| `inference-dropped-relationships.json` | `<dataDir>/graph/<project>/` | 빈 배열 (`readDroppedRelationships` 의 기존 동작) |

뒤 두 입력은 Phase 02 에서 `sync.ts` 가 직접 챙기던 것이다. 이제 `readResolveInput` 한 곳으로 모은다.

**raw 부재를 경고로 넘기지 마라 — 조용히 빈 결과가 나온다.**

`readPostSummaries` 는 `posts.json` 이 없으면 빈 배열을 돌려주고 `buildEndpointIndex` 는 그대로 진행한다.
색인이 비면 `normalizeEndpoint` 가 Task·Wiki 끝점을 **전부 drop** 한다.
그러면 관계가 통째로 빠진 `resolved.jsonl` 이 정상 산출물처럼 나오고,
사전 변경 전후를 `cmp` 하면 **둘 다 똑같이 비어 "차이 없음" 이라는 틀린 결론**이 나온다.
이 단계의 존재 이유가 정확히 그 비교이므로 그냥 두면 안 된다.

**엄격 판정을 `io.ts` 에 넣지 마라. `resolve/cli.ts` 에 둔다.**

`readResolveInput` 은 시그니처가 하나인데 호출처가 둘이다 — `resolve-graph` 와 `sync-neo4j`.
여기서 던지게 만들면 **`sync-neo4j` 도 raw 없이는 못 돌게 되어 적재 동작이 조용히 바뀐다.**
`tc-ocr` 에는 raw 가 있으니 테스트도 검증도 전부 통과하고 바뀐 사실이 드러나지 않는다.
이 plan 이 막으려는 실패가 정확히 그것이다.

| 계층 | 책임 |
| --- | --- |
| `io.ts` `readResolveInput` | 기존 동작 그대로 읽는다. 색인이 비어도 그대로 돌려준다 |
| `resolve/cli.ts` | 받은 색인이 비었으면 **실패시킨다.** `resolve-graph` 에만 적용된다 |
| `sync.ts` | 검사하지 않는다. 기존 동작이 그대로 유지된다 |

정책을 명령 경계에 두면 플래그 인자가 필요 없다.
`readResolveInput` 에 `{ requireEndpointIndex: boolean }` 같은 것을 붙이지 마라 —
호출처가 둘뿐이고 정책이 명령마다 다르므로 `cli.ts` 쪽이 단순하다.

4번의 표준출력 요약에 색인 크기(Task·Wiki 끝점 수)를 넣어 빈 색인이 눈에 띄게 한다.

**검증** — `sync-neo4j` 가 여전히 raw 부재를 견디는지 테스트로 고정하라.
`cli.ts` 의 검사를 `io.ts` 로 잘못 내리면 이 테스트가 실패해야 한다.

**`readdir` 로 디렉터리를 훑지 마라.** 위 작업 순서 섹션의 이유다. 파일명을 명시해 읽는다.

읽기 함수를 옮겨 온다 — `sync.ts` 의 `readJsonlRecords`(197행)와 `loadConceptDictionary`(98행)다.
`readJsonlRecords` 는 옮기면서 **디렉터리 훑기를 명시 경로 읽기로 바꾼다.**
`SourcedRecord.sourceFile` 값은 그대로 유지해야 한다 — `conceptSource` 가 그 값으로 출처를 가른다.
**이 이동이 사전 로딩 중복을 없앤다.** 현재 `infer` 와 `sync` 가 각자 구현하고 있다.
`infer` 쪽(`llm-extractor.ts:108` `readProjectConcepts`)도 이 함수를 쓰게 바꿀 수 있는지 확인하고
결과를 보고하라. 시그니처가 어긋나 위험하면 바꾸지 말고 근거를 적어라.

### 2. 출력 순서를 고정한다

**같은 입력이면 바이트 동등해야 한다.** dry-run 비교의 전제다.

- 노드는 `라벨 → 키` 순
- 관계는 `유형 → 시작키 → 끝키` 순
- 정렬은 기존 `compareCodePoints` 를 재사용한다 (Phase 02 에서 `resolve/node-merge.ts` 로 옮겨진다)

`resolved.jsonl` 형식은 `parsed.jsonl`·`inferred.jsonl` 과 **같다.** 한 줄에 노드 하나 또는 관계 하나다.
기존 `graph-record.schema.ts` 를 재사용한다.

```jsonl
{"label":"Task","key":"483","properties":{"number":483,"subject":"..."}}
{"type":"MENTIONS","startKey":"Task:483","endKey":"Concept:api gateway","properties":{}}
```

**`resolved.jsonl` 첫 줄에 메타데이터를 넣지 마라.** 읽는 쪽이 모두 그 줄을 건너뛰어야 하고
그 규칙을 잊으면 조용히 깨진다. 리포트는 별도 파일이다.

### 3. `resolve-graph` 단계 등록

**독립 진입점으로 만든다. `main.ts` 스테이지 분기에는 넣지 마라.**

계획 초안은 `main.ts` 분기와 독립 스크립트를 둘 다 요구했는데 두 가지 이유로 독립 스크립트만 남긴다.

- 선례가 그렇다 — `sync-neo4j`·`apply-schema`·`audit-concepts` 는 전부 독립 진입점이고
  `main.ts` 의 `KNOWN_STAGES` 에 없다. `resolve-graph` 만 다르게 둘 이유가 없다
- `main.ts` 경로는 `NestFactory.createApplicationContext(AppModule)` 을 띄운다.
  파일만 읽고 정규화하는 명령에 Nest 부팅을 붙이게 된다

`KNOWN_STAGES` 는 `cli-options.ts` 가 아니라 `main.ts:26` 에 있다. **이 phase 에서 건드리지 않는다.**

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/resolve/cli.ts` | 신규 — CLI 진입점 |
| `apps/pipeline/src/cli-options.ts` | `readFlag` 를 `sync.ts` 에서 이곳으로 올려 공용화한다 |
| `apps/pipeline/package.json` | `"resolve-graph": "pnpm build && node dist/resolve/cli.js"` 추가 |

`cli-options.ts` 에는 이미 비슷한 `optionValue` 가 있다. **동작이 다르니 합치기 전에 확인하라.**

| 함수 | 값이 없을 때 |
| --- | --- |
| `optionValue` (`cli-options.ts`) | 예외를 던진다 |
| `readFlag` (`sync.ts`) | `undefined` 를 돌려준다 |

둘을 그대로 나란히 두면 다음 사람이 아무거나 고른다. 셋 중 하나를 골라 근거를 보고하라.

- 하나로 합친다 (호출처의 기대 동작이 바뀌지 않는지 확인해야 한다)
- 둘 다 남기되 이름으로 차이를 드러낸다 (예: `requiredOption`·`optionalOption`)
- 둘 다 남기고 각 함수에 왜 둘인지 주석을 남긴다

인자는 이렇다.

```
--project <code>      기본값은 기존 DEFAULT_PROJECT
--data-dir <절대경로>  기본값은 기존 sync-neo4j 와 동일
--out <경로>          기본값 <dataDir>/graph/<project>/resolved.jsonl
```

**`--data-dir` 은 절대 경로를 요구한다.** 상대 경로가 pipeline 패키지 기준으로 풀려
파일을 못 찾는 함정을 이미 겪었다. 상대 경로가 오면 거부하거나 명확히 해석하고 근거를 보고하라.

리포트 경로는 `--out` 과 같은 디렉터리에 `resolve-report.json` 으로 둔다.

### 4. 표준출력 요약

`sync-neo4j` 와 같은 형태의 JSON 요약을 낸다 — 노드·관계 수, 미매칭 Concept, 건너뛴 관계, 버린 관계.
Neo4j 통계는 없다.

**색인 크기를 함께 낸다** (Task 끝점 수·Wiki 끝점 수). 위 작업 항목 1번의 이유다 —
색인이 비면 관계가 전부 사라지는데 다른 숫자만 봐서는 그 사실이 드러나지 않는다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/resolve/io.ts` | 신규 |
| `apps/pipeline/src/resolve/cli.ts` | 신규 — CLI 진입점. `resolve.ts` 는 순수하게 남긴다 |
| `apps/pipeline/src/cli-options.ts` | 수정 — `readFlag` 공용화 |
| `apps/pipeline/src/neo4j/sync.ts` | 수정 — 읽기를 `io.ts` 로 넘기고 자체 `readFlag` 제거 |
| `apps/pipeline/package.json` | 수정 — 스크립트 추가, test glob 에 `dist/resolve/*.test.js` 확인 |
| `packages/shared/src/graph/graph.const.ts` | 수정 — `RESOLVED_GRAPH_FILE` 상수 추가 |
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

### 재현성 (이 phase 의 핵심 통과 조건)

```bash
# cwd: 저장소 루트
D=$(pwd)/apps/pipeline/data
pnpm --filter pipeline resolve-graph --project tc-ocr --data-dir "$D" --out /tmp/r1.jsonl
pnpm --filter pipeline resolve-graph --project tc-ocr --data-dir "$D" --out /tmp/r2.jsonl
cmp /tmp/r1.jsonl /tmp/r2.jsonl && echo "바이트 동등"
```

`--out` 을 `/tmp` 로 준다. 기본 경로(`graph/tc-ocr/resolved.jsonl`)에 쓰면 위 작업 순서 섹션이 경고한 함정 대상이 된다.
기본 경로 출력은 작업 순서 섹션이 요구한 명시 경로 읽기를 끝낸 뒤 **한 번만** 확인한다.

```bash
# cwd: 저장소 루트
pnpm --filter pipeline resolve-graph --project tc-ocr --data-dir "$D"
ls apps/pipeline/data/graph/tc-ocr/
# resolved.jsonl 이 생긴 상태에서 입력 읽기가 여전히 parsed·inferred 만 잡는지 확인
```

**차이가 나오면 이 단계의 존재 이유가 없다.** 정렬이 결정적이지 않은 지점을 찾아 고쳐라.

### 정렬 안정성 테스트 (필수)

`cmp` 통과는 우연일 수 있다. 테스트로 고정하라.

- 입력 레코드 순서를 뒤섞어도 출력이 같은지 단언한다
- **변이 검증** — 정렬 호출을 지웠을 때 그 테스트가 실제로 실패하는지 확인하고 원복한다.
  `git status` 가 깨끗한지 보여라

### 입력 부재 처리 테스트

- `parsed.jsonl` 없음 → 실패
- `inferred.jsonl` 없음 → 경고 후 진행, 구조 노드만 담긴 결과
- `data/raw/<project>/` 없음 → 실패 (색인이 비면 관계가 전부 사라지므로)
- `resolved.jsonl` 이 같은 디렉터리에 있어도 입력으로 딸려 들어오지 않는다 (위 작업 순서 섹션의 회귀 테스트)

---

## 의도 메모 (왜)

- **`sync-neo4j` 가 `resolved.jsonl` 을 읽지 않는 이유** — 정규화는 공짜다.
  결과를 캐싱해 적재에 먹여도 아끼는 것이 없고 **stale 위험만 생긴다.**
  앞 단계를 고치고 `resolve-graph` 를 안 돌리면 옛 결과로 적재된다.
  이 저장소는 같은 계열의 함정을 여러 번 겪었다 — Vite 사전 번들 캐시, 테스트 glob, 문서의 옛 참조
- **`--out` 을 둔 이유** — 사전 변경 전후를 비교하려면 두 파일이 필요하다
- **형식을 `parsed`·`inferred` 와 같게 두는 이유** — 기존 스키마를 재사용하고,
  사람이 나란히 놓고 무엇이 바뀌었는지 볼 수 있다
- 이 phase 가 Phase 04 의 무엇을 막아주나 — 읽기가 `io.ts` 로 빠지므로
  Phase 04 는 `sync.ts` 에서 **쓰기만 남기면** 된다

근거 문서 — `docs/adr/0004-resolve-as-inspection-stage.md`, `docs/data-schema.md`

---

## Blocked 조건

- 로컬 그래프 산출물이 없어 재현성을 확인할 수 없으면
  `PHASE_BLOCKED: 로컬 그래프 산출물 부재로 재현성 검증 불가` 를 출력하고 종료한다.
  `apps/pipeline/data/` 는 gitignore 대상이라 워크트리에 복제되지 않는다

  **이 작업 디렉터리에는 데이터가 이미 있다** (`tc-ocr`). 이 조건은 걸리지 않는다.

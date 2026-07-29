# Phase 01 — LLM 관계 정리를 순수 함수로 쪼갠다

**Execution profile**: standard
**Status**: pending

---

## 목표

`apps/pipeline/src/infer/llm-relationship-sanitizer.ts` 의 `sanitizeLlmGraphFile` 은
읽기·정리·쓰기를 한 함수에 담고 있다. 그 안의 **정리 로직만 순수 함수로 분리**한다.

왜 필요한가 — 다음 phase 에서 적재(`sync-neo4j`)가 이 정리 로직을 **파일을 건드리지 않고**
메모리에서 써야 한다. 현재는 적재 중 이 함수가 `inferred.jsonl` 을 `writeFile` 로 덮어쓴다.
"읽기만 할 입력" 이 적재 과정에서 바뀌는 구조다.

**범위 외**

- 정규화(`sync.ts` 의 `normalizeGraph` 계열) 이동 — Phase 02
- `resolve-graph` 명령 신설 — Phase 03
- `sync-neo4j` 축소·`reset-neo4j` 신설 — Phase 04
- 정리 로직의 **판정 규칙 변경** — 이번에는 옮기고 쪼개기만 한다

---

## 작업 항목 (3)

### 1. `apps/pipeline/src/infer/llm-relationship-sanitizer.ts` — 순수 함수 추출

파일 I/O 없이 레코드 배열만 다루는 함수를 새로 내보낸다. 이름과 시그니처는 이렇게 한다.

```ts
export interface SanitizeLlmRecordsResult {
  records: LlmGraphRecord[];
  droppedRelationships: DroppedRelationshipsReport;
  rewrittenRelationships: number;
}

export function sanitizeLlmRecords(
  records: readonly LlmGraphRecord[],
  previousDropped: readonly DroppedRelationship[],
  index: EndpointIndex,
): SanitizeLlmRecordsResult;
```

- `LlmGraphRecord`·`DroppedRelationship`·`DroppedRelationshipsReport` 는 이 파일에 이미 있다
- `previousDropped` 는 기존 리포트 파일에서 읽은 누적분이다. 순수 함수는 이 값을 **인자로 받는다**
- 판정 로직은 기존 `sanitizeLlmGraphFile` 본문에서 **그대로 옮긴다.** 조건을 바꾸지 마라

**`index` 인자가 반드시 있어야 한다.** 정리 판정은 `sanitizeRelationships(records, index)` 를 거치고,
그 `EndpointIndex` 는 `buildEndpointIndex(dataRoot, project)` 가 `data/raw/` 를 읽어 만든다.
색인을 인자로 받지 않으면 순수 함수가 판정을 할 수 없다 — 파일을 읽게 되어 순수성이 깨진다.

- `EndpointIndex` 타입과 `buildEndpointIndex` 를 **`export` 한다.** Phase 02·03 의 `resolveGraph` 가
  같은 색인을 만들어 넘겨야 한다
- `buildEndpointIndex` 는 파일을 읽으므로 순수 함수가 아니다. 그대로 두고 호출처만 밖으로 옮긴다

### 2. 같은 파일 — 기존 파일 함수를 순수 함수 위에 다시 얹는다

`sanitizeLlmGraphFile(dataRoot, project)` 의 시그니처와 반환 타입(`SanitizeLlmGraphFileResult`)을 **바꾸지 마라.**
내부만 이렇게 바꾼다.

1. 기존대로 `inferred.jsonl` 과 리포트 파일을 읽고 `buildEndpointIndex` 로 색인을 만든다
2. 파싱한 레코드·누적 dropped·색인을 `sanitizeLlmRecords` 에 넘긴다
3. 반환값을 기존과 같은 방식으로 두 파일에 쓴다

즉 파일 함수는 **읽기 → 순수 함수 → 쓰기** 세 단계를 잇는 껍데기가 된다.
`infer-knowledge` 단계의 동작은 그대로 유지된다.

### 3. `apps/pipeline/src/infer/llm-relationship-sanitizer.test.ts` — 순수 함수 테스트 추가

기존 테스트가 파일 함수를 검증한다면 그대로 두고, 순수 함수용 테스트를 더한다.
최소 다음을 덮어라.

- 스키마에 없는 관계 유형이 `droppedRelationships` 에 들어가고 `records` 에서 빠진다
- 재작성 대상 관계가 재작성되고 `rewrittenRelationships` 가 증가한다
- `previousDropped` 로 넘긴 누적분이 결과에 유지된다
- **파일을 만들지 않는다** — 순수 함수 테스트는 임시 디렉터리를 쓰지 않아야 한다

`apps/pipeline/package.json` 의 test glob 이 경로를 열거하는 방식이다.
현재 값에 `dist/infer/*.test.js` 가 **없다.**

```
dist/cli-options.test.js dist/fetch/*.test.js dist/neo4j/*.test.js test/*.test.cjs
```

**테스트는 소스 옆(`src/infer/`)에 두고 glob 에 `dist/infer/*.test.js` 를 추가한다.**
`src/neo4j/sync.test.ts` 가 이미 그 방식이라 관례에 맞고, Phase 02·03 의 `resolve/` 도 같은 방식으로 간다.

통과 표시가 아니라 **개수**를 확인하라.
개수가 안 늘면 테스트가 실패한 것이 아니라 **아예 안 돈 것**이다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/infer/llm-relationship-sanitizer.ts` | 수정 — 순수 함수 추출, 파일 함수는 그 위에 얹는다 |
| `apps/pipeline/test/*.test.cjs` 또는 신규 테스트 파일 | 추가 |
| `apps/pipeline/package.json` | 새 테스트 파일을 추가했다면 test glob 갱신 |

---

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

`pnpm --filter api test` 는 쓰지 마라 — `test` 스크립트가 없어 **exit 0 으로 조용히 통과**한다.
기대값 — api 51, pipeline 48 에서 **pipeline 이 늘어야 한다.**

`format:check` 가 걸려도 **포맷터를 파일 전체에 돌리지 마라.** 손댄 줄만 고친다.
이 저장소는 재포맷 316줄 diff 에 기능 변경 93줄이 묻힌 사고를 겪었다.

### 산출물 동등성 (필수)

정리 로직을 옮기기만 했으므로 `infer-knowledge` 산출물이 바이트 단위로 같아야 한다.

프로젝트 코드는 `tc-ocr` 이다. 데이터는 `apps/pipeline/data/` 에 이미 있다.

**실데이터 디렉터리에서 검증하지 마라.** `sanitizeLlmGraphFile` 은 `inferred.jsonl` 과 리포트를
`writeFile` 로 덮어쓴다. 사본을 만들어 그 위에서 돌린다.

```bash
# cwd: 저장소 루트
WORK=$(mktemp -d)
cp -R apps/pipeline/data/raw apps/pipeline/data/graph "$WORK"/
cp "$WORK"/graph/tc-ocr/inferred.jsonl /tmp/inferred-before.jsonl
cp "$WORK"/graph/tc-ocr/inference-dropped-relationships.json /tmp/dropped-before.json
# 파일 함수를 직접 호출하는 최소 스크립트로 sanitizeLlmGraphFile("$WORK", "tc-ocr") 를 1회 실행한다
cmp /tmp/inferred-before.jsonl "$WORK"/graph/tc-ocr/inferred.jsonl
cmp /tmp/dropped-before.json "$WORK"/graph/tc-ocr/inference-dropped-relationships.json
```

**`infer-knowledge` 단계 전체를 실행하지 마라** — LLM 을 537회 호출한다.
정리 함수만 따로 부르는 스크립트를 쓴다.

`cmp` 에 차이가 나오면 옮기는 과정에서 판정이 바뀐 것이다. 원인을 찾아 보고하라.
검증이 끝나면 `apps/pipeline/data/` 가 `git status` 와 파일 시각 기준으로 손대지지 않았는지 확인하라.

### 변이 검증 (필수)

이 저장소에는 가드를 무력화해도 테스트 32건이 전부 통과한 전례가 있다.
새 테스트가 실제로 무언가를 보호하는지 확인하라.

- 순수 함수의 관계 유형 검증을 의도적으로 무력화한다 → 새 테스트가 실패하는지 확인
- 확인 후 원복하고 `git status` 가 깨끗한지 보여라

---

## 의도 메모 (왜)

- **파일 함수를 지우지 않는 이유** — `infer-knowledge` 는 자기 산출물을 갱신하는 것이 맞는 관심사다.
  없애면 추출 직후 정리 결과가 파일에 반영되지 않는다
- **정리 판정을 바꾸지 않는 이유** — 이번 plan 은 동작 불변 리팩토링이다. 판정을 함께 바꾸면
  이후 phase 에서 회귀 원인을 정규화 이동과 정리 변경 중 어느 쪽인지 가릴 수 없다
- 이 phase 가 Phase 04 의 무엇을 막아주나 — `sync-neo4j` 가 순수 함수만 쓰게 되어
  **적재가 추출 산출물을 덮어쓰는 문제가 사라진다**

근거 문서 — `docs/adr/0004-resolve-as-inspection-stage.md`

---

## Blocked 조건

- `apps/pipeline/data/graph/` 아래에 데이터가 없어 산출물 동등성을 확인할 수 없으면
  `PHASE_BLOCKED: 로컬 그래프 산출물 부재로 동등성 검증 불가` 를 출력하고 종료한다.
  데이터는 gitignore 대상이라 워크트리에 복제되지 않는다

  **이 작업 디렉터리에는 데이터가 이미 복사돼 있다** (`apps/pipeline/data/graph/tc-ocr/` 에
  `parsed.jsonl`·`inferred.jsonl`·`inference-dropped-relationships.json`). 이 조건은 걸리지 않는다.
  데이터를 다시 만들지 마라.

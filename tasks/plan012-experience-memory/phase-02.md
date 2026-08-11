# Phase 02 — Luna 고정 추출과 증분 cache를 구현한다

**Execution profile**: standard
**Status**: completed

---

## 목표

evidence packet에서 코드로 재구성하기 어려운 경험만 추출한다.
모든 지식 추출 호출은 `gpt-5.6-luna`와 low reasoning effort를 사용하며 다른 모델이나 provider로 fallback할 수 없게 한다.

**범위 외**

- GraphRAG의 `infer-knowledge`, `LLM_MODEL`, `QUERY_LLM_MODEL` 변경
- 검색 중 LLM 호출
- 현재 class, symbol, caller·callee 같은 코드 사실 추출
- 자동 curation, Memory 삭제 또는 merge

---

## 작업 항목 (5)

### 1. pipeline LLM 계약에 structured output을 연결한다

`apps/pipeline/src/llm/llm-cli.ts`의 `LlmOptionsSchema`에 `outputSchema: z.record(z.string(), z.unknown()).optional()`을 추가한다.
`ResponsesCliAdapter`와 `AppServerCliAdapter`는 이를 `@devloop/llm` transport에 전달한다.
기존 호출에서 값이 없을 때 request가 바뀌지 않는 테스트를 유지하고, 전달 테스트를 추가한다.

Memory extractor는 `ResponsesCliAdapter`를 직접 생성한다.
일반 pipeline config의 provider·transport·model 값을 읽어 Memory 호출을 바꾸지 않는다.

### 2. Experience 전용 prompt와 출력 schema를 만든다

`apps/pipeline/src/memory/experience-prompt.ts`에 versioned prompt와 JSON Schema literal을 둔다.

- 출력 kind는 `decision`, `constraint`, `incident`, `failed-attempt`, `lesson`뿐이다.
- 현재 source에서 다시 찾을 class·symbol·호출 관계는 제외한다.
- 원문 인용을 복제하지 않고 `sourceRefKeys`만 선택하게 한다.
- title은 개행 없는 한 줄이어야 한다.
- 직접 근거가 없으면 생성하지 않으며 현재 유효성이 불명확하면 status는 `uncertain`이다.
- repair prompt로 추가 호출하지 않고 strict structured output 한 번을 기본으로 한다.

`apps/pipeline/src/memory/experience-extraction.schema.ts`가 LLM draft를 Zod로 검증한다.

### 3. 모델과 provenance를 코드에서 강제한다

`apps/pipeline/src/memory/experience-extractor.ts`에 다음 상수를 private 또는 domain constant로 둔다.

```ts
const MEMORY_EXTRACTION_MODEL = "gpt-5.6-luna";
const MEMORY_EXTRACTION_EFFORT = "low";
```

CLI에 model·provider·effort option을 만들지 않는다.
LLM이 반환한 `sourceRefKeys`는 `sourceRefKey()`로 계산한 현재 EvidencePacket의 SourceRef만 resolve하고, 알 수 없는 key가 하나라도 있으면 그 packet을 실패 처리한다.
Memory ID는 kind, 정규화 title, 정렬한 sourceRefKey의 SHA-256으로 계산하며 LLM 값을 받지 않는다.

### 4. 증분 cache와 실패 report를 구현한다

cache key와 envelope에 `contentHash`, prompt version, Memory schema version, exact model, exact effort를 모두 넣는다.
cache hit에서는 LLM을 호출하지 않고 Zod·provenance를 다시 검증한다.

`extraction-generations/<extractionGenerationId>/`에 `extracted.jsonl`과 deterministic `extraction-manifest.json`을 함께 쓰고 디렉터리를 rename한다.
manifest에는 source generation ID·manifest hash·selection·성공·실패 packet ID·결과 content hash·model·effort·prompt version·complete만 기록한다.
두 파일 검증 후 `current-extraction.json` pointer만 원자적으로 교체한다.
calls·cache hits·elapsed time·원래 오류 문자열은 `extraction-runs/<runId>/extraction-run-report.json`에 기록하고 `latest-extraction-run.json`을 원자적으로 교체한다.
같은 generation의 cache 재실행은 generation byte를 바꾸지 않고 새 run report에 calls 0을 기록한다.
실패가 있거나 `--limit`·`--ids`·`--sample-per-source`를 사용하면 `complete: false`다.

### 5. extract 명령과 테스트를 추가한다

`extract [--project <name>] [--data-dir <path>] [--limit <n>] [--ids <comma-list>] [--sample-per-source <n>]`를 `memory/cli.ts`에 추가하고 package script `extract-memory`를 만든다.
세 선택 option은 상호 배타다. `--sample-per-source`는 sourceKind별 ID 정렬 후 앞에서 n개를 고른다.
concurrency는 CLI로 노출하지 않고 1로 고정한다.

fake `LlmCli`로 다음을 검증한다.

- 모든 호출 model=`gpt-5.6-luna`, effort=`low`, structured schema 전달
- CLI·환경변수로 다른 모델을 주입할 수 없음
- cache hit 0 calls와 prompt/schema/model/effort 변화 시 miss
- 모르는 source ref, invalid enum, 빈 summary 거부
- 일부 실패와 부분 실행의 `complete: false`
- 첫 실행과 cache 재실행이 같은 extraction generation을 가리키면서 run 통계만 달라짐

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/llm/llm-cli.ts` | 수정 — outputSchema option |
| `apps/pipeline/src/llm/responses.adapter.ts` | 수정 — structured output 전달 |
| `apps/pipeline/src/llm/app-server.adapter.ts` | 수정 — 기존 전송 계약 유지 |
| `apps/pipeline/src/memory/experience-prompt.ts` | 신규 — prompt와 JSON schema |
| `apps/pipeline/src/memory/experience-extraction.schema.ts` | 신규 — LLM draft 검증 |
| `apps/pipeline/src/memory/experience-extractor.ts` | 신규 — Luna 호출, cache, report |
| `apps/pipeline/src/memory/cli.ts` | 수정 — extract 명령 |
| `apps/pipeline/package.json` | 수정 — `extract-memory` script |
| `apps/pipeline/src/llm/*.test.ts` | 수정 — outputSchema 전달 회귀 |
| `apps/pipeline/src/memory/*.test.ts` | 신규 — model, cache, provenance 검증 |

## 검증

```bash
# cwd: 저장소 루트
pnpm --filter @devloop/llm test
pnpm --filter pipeline test
pnpm -r build
pnpm format:check
git diff --check
```

테스트 spy에서 `complete` 호출의 model과 effort 집합이 각각 정확히 하나인지 assert한다.
Memory 경로에서 `LLM_MODEL`, `QUERY_LLM_MODEL`, `gpt-5.6-terra`, `gpt-5.5`를 참조하는 코드가 0건인지 확인한다.

## 의도 메모 (왜)

- 작은 모델과 low effort를 cache identity까지 고정해야 제한된 token 예산과 비교 조건이 흔들리지 않는다.
- source ref를 LLM이 만들지 못하게 해야 모든 Memory의 원문 link가 실제 evidence로 제한된다.
- 부분 결과를 정상 index처럼 쓰지 않게 complete 상태를 파일 계약으로 둔다.

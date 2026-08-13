# Phase 02 — source-backed Graph context 조건을 반복 실행한다

**Execution profile**: standard
**Status**: completed

---

## 목표

고정한 두 task에서 Memory와 source-backed Graph 이웃을 함께 제공하는 조건을 각각 3회 실행하고 Graph 호출 비용과 task 결과를 수집한다.

**범위 외**: GraphRAG 답변 API, Cypher 생성 LLM, Graph 쓰기, task·Memory 수정.

---

## 작업 항목 (5)

### 1. Graph context adapter를 구현한다

`.claude/skills/kg-eval/scripts/memory/graph-context.mjs`는 고정 anchor를 기존 Graph API에서 resolve하고 bounded depth 이웃을 읽는다.
HTTP argv나 URL은 `URL` API로 만들고 응답 schema를 검증한다.
매 attempt 전에 label/key를 exact re-resolve하고 resolved elementId와 graph stats hash가 lock과 다르면 Agent를 실행하지 않는다.

### 2. current source 우선 context를 만든다

Graph context에는 source key, relationship type, 원문 link만 넣고 current code 사실을 덮어쓰는 지시를 넣지 않는다.
없는 anchor, stale source, 관계 불일치는 경고와 failure boundary로 남긴다.

### 3. LLM 없는 Graph 검색을 강제한다

adapter는 `/api/query`, `QUERY_LLM_MODEL`, `packages/llm`을 호출하거나 import하지 않는다.
raw attempt에는 `graphContextCalls`, `agentGraphCalls`, 합계 `graphCalls`, `graphLlmCalls`, `graphLatencyMs`를 flat field로 기록한다.
Graph LLM calls는 항상 0이고 실제 HTTP call 수와 latency만 기록한다.

### 4. 두 task를 각각 3회 실행한다

Codex model과 effort는 plan014와 같게 유지한다.
`memory-graph` run 6개를 직렬 실행하고 timeout·validation 실패도 raw run으로 보존한다.
`condition.mjs`의 기존 세 기준선 조건 목록과 동일성 검사는 유지하고, 별도 experimental condition 목록·builder로 `memory-graph`를 추가한다.
`run-memory.mjs`는 `--graph-lock`과 `--graph-base-url`이 함께 있을 때만 이 condition을 허용하고 oracle Memory와 Graph context를 prompt에 주입한다.

### 5. 관계 증거 사용 여부를 기록한다

Agent event에서 Graph가 제공한 source key나 관계를 실제로 읽거나 변경 근거로 언급했는지 기록한다.
task success만으로 Graph가 원인이라고 단정하지 않는다.
provided key·relationship의 event/text match는 `graphEvidenceUsed: true|false|null`로 남기며 event 근거가 없으면 null이다.

다음 명령으로 고정한 두 task를 3회 실행한다.

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/run-memory.mjs \
  --suite eval/suites/tc-ocr-memory.json \
  --source-lock eval/runs/plan014-memory-source-lock.json \
  --source-repository-root /Users/nhn/projects/OCR \
  --out eval/runs/plan016-memory-graph.json \
  --data-dir apps/pipeline/data \
  --agent codex \
  --model gpt-5.6-luna \
  --effort low \
  --permission-mode workspace-write \
  --tasks MEM-EXP-001,MEM-EXP-002 \
  --conditions memory-graph \
  --repeats 3 \
  --schedule interleaved \
  --graph-lock eval/runs/plan016-graph-lock.json \
  --graph-base-url http://127.0.0.1:3016 \
  --timeout-ms 600000 \
  --max-output-bytes 4194304
```

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/scripts/memory/graph-context.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/graph-evidence.mjs` | 제공 관계의 실제 사용 판정 신규 |
| `.claude/skills/kg-eval/scripts/memory/condition.mjs` | 기존 기준선과 분리된 `memory-graph` builder 추가 |
| `.claude/skills/kg-eval/scripts/run-memory.mjs` | Graph lock·context 조건 실행과 flat 계측 보강 |
| `.claude/skills/kg-eval/scripts/memory/telemetry.mjs` | Agent 직접 Graph call 계측 분리 보강 |
| `.claude/skills/kg-eval/references/result-contract.md` | memory-graph attempt flat field 계약 보강 |
| `.claude/skills/kg-eval/tests/memory-graph.test.mjs` | 신규 |
| `eval/runs/plan016-memory-graph.json` | raw 6회, commit하지 않음 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/memory-graph.test.mjs
test "$(rg -c 'api/query|QUERY_LLM_MODEL|packages/llm' .claude/skills/kg-eval/scripts/memory/graph-context.mjs || true)" = "0"
jq '.attempts | length' eval/runs/plan016-memory-graph.json
jq '[.attempts[] | select(.graphLlmCalls != 0)] | length' eval/runs/plan016-memory-graph.json
jq '[.attempts[] | select(.condition != "memory-graph" or .graphContextCalls < 1)] | length' eval/runs/plan016-memory-graph.json
jq '[.attempts[] | has("graphEvidenceUsed")] | all' eval/runs/plan016-memory-graph.json
```

금지 문자열 count는 0이고 네 `jq` 결과는 각각 6, 0, 0, `true`여야 한다.
검증 성공·실패와 관계없이 이 plan이 띄운 3016 API process를 종료하고 포트가 닫혔는지 확인한다.

## 의도 메모 (왜)

- deterministic Graph 이웃만 쓰면 Memory에 대한 Graph 구조의 추가 가치와 질의 LLM 효과를 섞지 않는다.
- 증거 사용 여부를 따로 보는 이유는 우연히 성공한 run을 Graph 이득으로 오판하지 않기 위해서다.

## Blocked 조건

- plan014와 model·revision·Memory index hash가 다르면 `PHASE_BLOCKED: Graph 비교 조건 불일치`로 종료한다.
- API graph stats hash나 label/key→elementId가 lock과 다르면 `PHASE_BLOCKED: Graph snapshot 변경`으로 종료한다.
- `--source-repository-root`의 real path·basename·base/target commit 검증이 하나라도 실패하면 `PHASE_BLOCKED: source snapshot 재현 불가`로 종료한다.

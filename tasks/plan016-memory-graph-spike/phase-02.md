# Phase 02 — source-backed Graph context 조건을 반복 실행한다

**Execution profile**: standard
**Status**: pending

---

## 목표

고정한 두 task에서 Memory와 source-backed Graph 이웃을 함께 제공하는 조건을 각각 3회 실행하고 Graph 호출 비용과 task 결과를 수집한다.

**범위 외**: GraphRAG 답변 API, Cypher 생성 LLM, Graph 쓰기, task·Memory 수정.

---

## 작업 항목 (5)

### 1. Graph context adapter를 구현한다

`.claude/skills/kg-eval/scripts/memory/graph-context.mjs`는 고정 anchor를 기존 Graph API에서 resolve하고 bounded depth 이웃을 읽는다.
HTTP argv나 URL은 `URL` API로 만들고 응답 schema를 검증한다.

### 2. current source 우선 context를 만든다

Graph context에는 source key, relationship type, 원문 link만 넣고 current code 사실을 덮어쓰는 지시를 넣지 않는다.
없는 anchor, stale source, 관계 불일치는 경고와 failure boundary로 남긴다.

### 3. LLM 없는 Graph 검색을 강제한다

adapter는 `/api/query`, `QUERY_LLM_MODEL`, `packages/llm`을 호출하거나 import하지 않는다.
Graph LLM calls는 항상 0이고 실제 HTTP graphCalls와 latency만 기록한다.

### 4. 두 task를 각각 3회 실행한다

Codex model과 effort는 plan014와 같게 유지한다.
`memory-graph` run 6개를 직렬 실행하고 timeout·validation 실패도 raw run으로 보존한다.

### 5. 관계 증거 사용 여부를 기록한다

Agent event에서 Graph가 제공한 source key나 관계를 실제로 읽거나 변경 근거로 언급했는지 기록한다.
task success만으로 Graph가 원인이라고 단정하지 않는다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/scripts/memory/graph-context.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/condition.mjs` | `memory-graph` 추가 |
| `.claude/skills/kg-eval/tests/memory-graph.test.mjs` | 신규 |
| `eval/runs/plan016-memory-graph.json` | raw 6회, commit하지 않음 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/memory-graph.test.mjs
rg -n "api/query|QUERY_LLM_MODEL|packages/llm" .claude/skills/kg-eval/scripts/memory/graph-context.mjs
jq '.runs | length' eval/runs/plan016-memory-graph.json
jq '[.runs[] | select(.telemetry.graphLlmCalls != 0)] | length' eval/runs/plan016-memory-graph.json
```

`rg` 결과는 0줄이고 JSON 결과는 각각 6과 0이어야 한다.

## 의도 메모 (왜)

- deterministic Graph 이웃만 쓰면 Memory에 대한 Graph 구조의 추가 가치와 질의 LLM 효과를 섞지 않는다.
- 증거 사용 여부를 따로 보는 이유는 우연히 성공한 run을 Graph 이득으로 오판하지 않기 위해서다.

## Blocked 조건

- plan014와 model·revision·Memory index hash가 다르면 `PHASE_BLOCKED: Graph 비교 조건 불일치`로 종료한다.

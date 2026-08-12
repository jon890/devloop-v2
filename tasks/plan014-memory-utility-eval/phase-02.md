# Phase 02 — 세 조건을 task별 3회 직렬 실행한다

**Execution profile**: standard
**Status**: pending

---

## 목표

네 task를 no-memory, agent-triggered, oracle-memory 조건에서 각각 3회 실행해 최소 36개 독립 run을 수집한다.

**범위 외**: 실패 attempt 삭제, repetition 축소, 실행 중 prompt·index·validation 변경, 동시 실행, Agent 결과를 성공으로 만들기 위한 재시도.

---

## 작업 항목 (4)

### 1. task와 condition을 교차 순서로 실행한다

한 조건을 모두 몰아 실행하지 않는다.
각 task에서 `no-memory-1 → agent-triggered-1 → oracle-memory-1 → no-memory-2 ...` 순서로 교차하고 한 번에 Agent 하나만 실행한다.
기본 schedule은 plan013 호환을 위해 task → condition → repetition 순서를 유지하고, `--schedule interleaved`는 task → repetition → condition 순서로만 바꾼다.
`run-memory.mjs`에는 두 순서를 모두 결정적으로 만드는 순수 함수를 두고, interleaved를 명시한 실행만 새 순서를 사용한다.

각 attempt의 Agent가 시작될 때 파일시스템에는 현재 attempt의 source-locked workspace만 있어야 한다.
현재 workspace는 private run artifact의 상위·형제 경로가 아닌 OS 임시 디렉터리의 고유 `mkdtemp` root에 만들고, 성공·실패·availability failure와 관계없이 attempt 종료 시 `finally`에서 제거한다.
Agent prompt는 현재 repository 밖의 파일을 읽지 않도록 명시하되 제공된 Experience Memory 검색 명령만 예외로 둔다.
Agent command telemetry에서 다른 `MEM-*` workspace 또는 benchmark transcript·diff를 읽은 흔적이 발견되면 그 raw run은 독립 실행 근거로 사용할 수 없다.
transcript와 diff는 Agent가 종료된 뒤 active workspace 밖의 private run artifact로만 보존한다.

### 2. 실패 보존과 재개 경계를 분리한다

중단되면 같은 명령으로 재개하고 이미 완료된 유일 키를 호출하지 않는다.
한 번 Agent task가 시작된 뒤의 `status`, `timedOut`, `validationStatus`, `taskSuccess`는 immutable한 관측값이며 `(taskId, condition, repetition)` attempt를 소비한다.
이 started attempt는 성공 여부와 무관하게 raw result에 그대로 보존하고 다시 실행하거나 덮어쓰지 않는다.
이 값들만으로 utility command 전체를 실패시키지 않는다. utility command를 실패로 만드는 것은 runner contract 위반, condition contamination, 또는 required oracle failure뿐이다.

process spawn 실패 또는 첫 Agent command/tool event 전에 구조화된 pre-tool error가 발생한 경우만 `availabilityFailures`에 append하고 repetition을 소비하지 않는다.
process spawn 자체가 실패하면 `normalizedCode=agent_spawn_failed`로 기록한다.
그 외 availability detector는 fail-closed여야 하며, 구조화된 pre-tool error의 normalized code가 `subscription_limit_exceeded`, `usage_limit_exceeded`, `rate_limit_exceeded` 중 하나일 때만 availability failure로 인정한다.
stderr, free text, generic non-zero exit, timeout으로는 availability failure를 추론하지 않는다.
`availabilityFailures`에는 정확히 `{ taskId, condition, repetition, normalizedCode }`만 저장하고, append 직후 즉시 stop한다. 같은 invocation에서 tight retry를 하지 않으며 이후 같은 명령은 비어 있는 key부터 재개한다.
`result.mjs`는 attempt key upsert를 제거하고 `appendAttempt` append-only insert로 바꾸며 중복 key는 throw로 fail-close한다.
timeout과 일반 non-zero exit는 started attempt의 관측값이며 availability failure로 재분류하지 않는다.
`oracle-memory`에서 고정 Memory를 확보하지 못하면 그것은 required oracle failure로 처리하고, started attempt 없이 utility command를 실패시킨다.

### 3. condition 위반을 실패로 기록한다

no-memory에서 memoryCalls가 1 이상이면 조건 오염이다.
oracle에서 고정 Memory 누락도 조건 오염이다.
code-only voluntary에서 불필요한 검색과 experience-needed voluntary에서 miss는 runner acceptance를 실패시키지 않고 `triggerOutcome`으로 기록한다.
`--require-expected-trigger`가 있을 때만 agent-triggered mismatch를 smoke acceptance failure로 다루며, 본 plan의 36회 명령에는 이 flag를 쓰지 않는다.

실제 Memory 검색이 발생하면 Codex/Claude command와 tool result event에서 retrieval observation을 구조화한다.
Codex는 `item.completed`의 `command_execution` command와 같은 item의 output을 사용한다.
Claude는 `assistant.message.content[].tool_use`의 `id`와 뒤따르는 `user.message.content[].tool_result.tool_use_id`를 짝지어 사용한다.
`turn.completed`와 `result` usage event는 token telemetry에만 사용하고 retrieval output으로 해석하지 않는다.
각 agent-triggered attempt는 `retrievalObservations` 배열을 가지며 관측 항목은 `sourceRunKey`, 실제 `query`, 확정 `topK`, `requiredMemoryIds`, `retrievedMemoryIds`, `memoryIndexHash`, `outcome`을 담는다.
command argv에서 실제 `--query` 값을 복원하고 `--top-k`가 없으면 `topK=10`으로 확정한다.
`retrievedMemoryIds`는 parsed JSON의 `results[].id`로 채우고, `requiredMemoryIds`는 같은 고정 index에서 task의 oracle query를 실행한 결과 ID로 만든다.
같은 memory index hash가 아닌 결과는 required memory로 인정하지 않는다.
Memory call은 있었지만 command, query, argv, result JSON output을 복원할 수 없으면 `outcome=unobserved`로 남기고 hit/miss를 추론하지 않는다.

### 4. raw 결과 무결성을 검사한다

36개 attempt의 task·condition·repetition 조합이 모두 유일해야 한다.
suite/source lock/revision/index/validation hash가 전부 같고 token null과 0을 구분해야 한다.
동일 입력으로 재실행하면 Agent 호출 0회이며 raw 결과 바이트가 바뀌지 않아야 한다.
두 attempt를 연속 실행하는 fixture는 두 번째 Agent가 첫 번째 workspace를 찾을 수 없고, 일반 오류와 availability failure 뒤에도 active workspace가 남지 않음을 증명해야 한다.

paid run 전에 `node --test`와 `git diff --check`를 먼저 통과시켜 fixture drift와 parser drift를 막는다. Codex/Claude event fixtures가 바뀌면 retrieval-observation 테스트도 같은 change에서 함께 갱신한다.
runner 변경 후 `MEM-CODE-001`을 세 조건에서 1회 실행해 taskSuccess, wrongEditCount, turns, toolCalls, sourceReads, memoryCalls, 실제 token usage가 raw attempt에 남는지 pilot으로 먼저 확인한다.
pilot부터 아래와 같은 options를 사용하고 `--require-expected-trigger`는 전달하지 않는다.
code-only skip과 experience-needed search는 runner가 주입하는 정답이 아니라 Agent의 자발적 결정이어야 한다.

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/run-memory.mjs \
  --suite eval/suites/tc-ocr-memory.json \
  --source-lock eval/runs/plan014-memory-source-lock.json \
  --out eval/runs/plan014-pilot.json \
  --data-dir apps/pipeline/data \
  --agent codex \
  --model gpt-5.6-luna \
  --effort low \
  --permission-mode workspace-write \
  --tasks MEM-CODE-001 \
  --conditions no-memory,agent-triggered,oracle-memory \
  --repeats 1 \
  --schedule interleaved \
  --timeout-ms 600000 \
  --max-output-bytes 4194304
```

pilot 3개 attempt가 모두 저장되고 필수 telemetry key가 있음을 확인한 뒤, 다음 명령으로 독립된 utility raw 36개를 채운다.
중단 후에도 같은 명령으로 재개한다.

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/run-memory.mjs \
  --suite eval/suites/tc-ocr-memory.json \
  --source-lock eval/runs/plan014-memory-source-lock.json \
  --out eval/runs/plan014-utility.json \
  --data-dir apps/pipeline/data \
  --agent codex \
  --model gpt-5.6-luna \
  --effort low \
  --permission-mode workspace-write \
  --conditions no-memory,agent-triggered,oracle-memory \
  --repeats 3 \
  --schedule interleaved \
  --timeout-ms 600000 \
  --max-output-bytes 4194304
```

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/scripts/run-memory.mjs` | interleaved schedule·voluntary 관측·availability 경계 수정 |
| `.claude/skills/kg-eval/scripts/memory/result.mjs` | appendAttempt·duplicate-key throw·availability failure 저장 계약 수정 |
| `.claude/skills/kg-eval/scripts/memory/agent-runner.mjs` | Agent 시작 전 구조화된 usage rejection 분류 보강 |
| `.claude/skills/kg-eval/scripts/memory/retrieval-observation.mjs` | Codex·Claude event pair retrieval observation 정규화 |
| `.claude/skills/kg-eval/tests/run-memory.test.mjs` | schedule·재개·voluntary acceptance 회귀 보강 |
| `.claude/skills/kg-eval/tests/memory-foundation.test.mjs` | started attempt·availability failure 저장 회귀 보강 |
| `.claude/skills/kg-eval/tests/memory-agent.test.mjs` | `agent_spawn_failed`와 구조화된 pre-tool subscription·usage rejection 분류 회귀 보강 |
| `.claude/skills/kg-eval/tests/retrieval-observation.test.mjs` | Codex·Claude 검색 argv/output·기본 topK=10·results[].id·unobserved 회귀 신규 |
| `.claude/skills/kg-eval/tests/memory-utility.test.mjs` | default/interleaved schedule와 pre-paid-run fixture drift 회귀 보강 |
| `.claude/skills/kg-eval/tests/fixtures/memory/codex-command.jsonl` | Codex event pair fixture 갱신 |
| `.claude/skills/kg-eval/tests/fixtures/memory/claude-command.jsonl` | Claude event pair fixture 갱신 |
| `.claude/skills/kg-eval/tests/fixtures/memory/usage-missing.jsonl` | token null fixture 갱신 |
| `eval/runs/plan014-pilot.json` | 세 조건 pilot 3개, commit하지 않음 |
| `eval/runs/plan014-utility.json` | 36개 raw run, commit하지 않음 |
| `eval/runs/workspaces/**` | 회차별 workspace, commit하지 않음 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/memory-utility.test.mjs .claude/skills/kg-eval/tests/run-memory.test.mjs .claude/skills/kg-eval/tests/memory-foundation.test.mjs .claude/skills/kg-eval/tests/memory-agent.test.mjs .claude/skills/kg-eval/tests/retrieval-observation.test.mjs
jq '.attempts | length' eval/runs/plan014-pilot.json
jq '[.attempts[] | has("taskSuccess") and has("memoryCalls") and has("sourceReads") and has("inputTokens") and has("outputTokens")] | all' eval/runs/plan014-pilot.json
jq '.attempts | length' eval/runs/plan014-utility.json
jq '[.attempts | group_by([.taskId,.condition,.repetition])[] | select(length != 1)] | length' eval/runs/plan014-utility.json
jq '[.attempts[] | select(.condition == "no-memory" and .memoryCalls != 0)] | length' eval/runs/plan014-utility.json
jq '[.attempts[] | select(.condition == "agent-triggered") | has("triggerOutcome")] | all' eval/runs/plan014-utility.json
jq '[.attempts[] | select(.condition == "agent-triggered") | (.retrievalObservations | type == "array")] | all' eval/runs/plan014-utility.json
jq '(.availabilityFailures // []) | length' eval/runs/plan014-utility.json
git status --short
```

여덟 `jq` 결과는 각각 3, `true`, 36, 0, 0, `true`, `true`, 0이어야 한다.

## 의도 메모 (왜)

- 교차 실행은 시간대와 서비스 경쟁을 특정 조건에 몰지 않기 위한 통제다.
- 시작된 실패 attempt를 덮어쓰지 않는 이유는 Memory가 만든 실패도 결과이기 때문이다.
- availability failure가 repetition을 소비하지 않는 이유는 Agent 품질이 아니라 실행 가능성 장애이기 때문이다.

## Blocked 조건

- `availabilityFailures`가 생기거나 36개 attempt가 채워지지 않으면 완료 회차를 보존하고 `PHASE_BLOCKED: Agent 사용량 제한`으로 종료한다.

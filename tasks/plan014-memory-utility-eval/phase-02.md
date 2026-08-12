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
`run-memory.mjs`에 `--schedule interleaved`를 추가하고 task → repetition → condition 순서의 결정적 schedule을 만드는 순수 함수를 둔다.
기존 기본 schedule은 plan013 호환을 위해 유지하고, interleaved를 명시한 실행만 새 순서를 사용한다.

### 2. 실패 보존과 재개 경계를 분리한다

중단되면 같은 명령으로 재개하고 이미 완료된 유일 키를 호출하지 않는다.
한 번 Agent task가 시작된 뒤의 timeout, 비정상 종료, validation 실패, task 실패는 유효한 관측값이며 `(taskId, condition, repetition)` attempt를 소비한다.
이 attempt는 성공 여부와 무관하게 immutable하게 보존하고 다시 실행하거나 덮어쓰지 않는다.

process spawn 실패 또는 첫 Agent command/tool event 전에 구조화된 subscription·usage rejection이 발생한 경우만 `availabilityFailures`에 append하고 repetition을 소비하지 않는다.
이 경우 같은 invocation에서 tight retry하지 않고 즉시 중단하며, 이후 같은 명령이 비어 있는 key부터 재개한다.
timeout과 일반 non-zero exit는 availability failure로 재분류하지 않는다.
`result.mjs`는 attempt key upsert를 제거하고 append-only insert로 바꾸며 중복 key를 fail-close한다.

### 3. condition 위반을 실패로 기록한다

no-memory에서 memoryCalls가 1 이상이면 조건 오염이다.
oracle에서 고정 Memory 누락도 조건 오염이다.
code-only voluntary에서 불필요한 검색과 experience-needed voluntary에서 miss는 runner acceptance를 실패시키지 않고 `triggerOutcome`으로 기록한다.
`--require-expected-trigger`가 있을 때만 agent-triggered mismatch를 smoke acceptance failure로 다루며, 본 plan의 36회 명령에는 이 flag를 쓰지 않는다.

### 4. raw 결과 무결성을 검사한다

36개 attempt의 task·condition·repetition 조합이 모두 유일해야 한다.
suite/source lock/revision/index/validation hash가 전부 같고 token null과 0을 구분해야 한다.
동일 입력으로 재실행하면 Agent 호출 0회이며 raw 결과 바이트가 바뀌지 않아야 한다.

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
| `.claude/skills/kg-eval/scripts/memory/result.mjs` | append-only attempt·availability failure 저장 계약 수정 |
| `.claude/skills/kg-eval/scripts/memory/agent-runner.mjs` | Agent 시작 전 구조화된 usage rejection 분류 보강 |
| `.claude/skills/kg-eval/tests/run-memory.test.mjs` | schedule·재개·voluntary acceptance 회귀 보강 |
| `.claude/skills/kg-eval/tests/memory-foundation.test.mjs` | immutable attempt·availability failure 저장 회귀 보강 |
| `.claude/skills/kg-eval/tests/memory-agent.test.mjs` | 구조화된 pre-Agent subscription·usage rejection 분류 회귀 보강 |
| `eval/runs/plan014-pilot.json` | 세 조건 pilot 3개, commit하지 않음 |
| `eval/runs/plan014-utility.json` | 36개 raw run, commit하지 않음 |
| `eval/runs/workspaces/**` | 회차별 workspace, commit하지 않음 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/run-memory.test.mjs .claude/skills/kg-eval/tests/memory-foundation.test.mjs .claude/skills/kg-eval/tests/memory-agent.test.mjs
jq '.attempts | length' eval/runs/plan014-pilot.json
jq '[.attempts[] | has("taskSuccess") and has("memoryCalls") and has("sourceReads") and has("inputTokens") and has("outputTokens")] | all' eval/runs/plan014-pilot.json
jq '.attempts | length' eval/runs/plan014-utility.json
jq '[.attempts | group_by([.taskId,.condition,.repetition])[] | select(length != 1)] | length' eval/runs/plan014-utility.json
jq '[.attempts[] | select(.condition == "no-memory" and .memoryCalls != 0)] | length' eval/runs/plan014-utility.json
jq '[.attempts[] | select(.condition == "agent-triggered") | has("triggerOutcome")] | all' eval/runs/plan014-utility.json
jq '(.availabilityFailures // []) | length' eval/runs/plan014-utility.json
git status --short
```

일곱 `jq` 결과는 각각 3, `true`, 36, 0, 0, `true`, 0이어야 한다.

## 의도 메모 (왜)

- 교차 실행은 시간대와 서비스 경쟁을 특정 조건에 몰지 않기 위한 통제다.
- 시작된 실패 attempt를 덮어쓰지 않는 이유는 Memory가 만든 실패도 결과이기 때문이다.
- availability failure가 repetition을 소비하지 않는 이유는 Agent 품질이 아니라 실행 가능성 장애이기 때문이다.

## Blocked 조건

- `availabilityFailures`가 생기거나 36개 attempt가 채워지지 않으면 완료 회차를 보존하고 `PHASE_BLOCKED: Agent 사용량 제한`으로 종료한다.

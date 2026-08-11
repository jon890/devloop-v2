# Phase 02 — 세 조건을 task별 3회 직렬 실행한다

**Execution profile**: standard
**Status**: pending

---

## 목표

네 task를 no-memory, agent-triggered, oracle-memory 조건에서 각각 3회 실행해 최소 36개 독립 run을 수집한다.

**범위 외**: 실패 run 삭제, repetition 축소, 실행 중 prompt·index·validation 변경, 동시 실행.

---

## 작업 항목 (4)

### 1. task와 condition을 교차 순서로 실행한다

한 조건을 모두 몰아 실행하지 않는다.
각 task에서 `no-memory-1 → agent-triggered-1 → oracle-memory-1 → no-memory-2 ...` 순서로 교차하고 한 번에 Agent 하나만 실행한다.

### 2. 완료 회차를 재개한다

중단되면 같은 명령으로 재개하고 이미 완료된 유일 키를 호출하지 않는다.
timeout, Agent 비정상 종료, validation 실패도 유효한 run으로 남기며 성공할 때까지 재시도해 덮어쓰지 않는다.

### 3. condition 위반을 실패로 기록한다

no-memory에서 memoryCalls가 1 이상이면 조건 오염이다.
code-only voluntary에서 불필요한 검색, experience-needed voluntary에서 miss, oracle에서 고정 Memory 누락을 각각 Agent decision 또는 retrieval 실패로 분류한다.

### 4. raw 결과 무결성을 검사한다

36개 run의 task·condition·repetition 조합이 모두 유일해야 한다.
suite/source lock/revision/index/validation hash가 전부 같고 token null과 0을 구분해야 한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/runs/plan014-utility.json` | 36개 raw run, commit하지 않음 |
| `eval/runs/workspaces/**` | 회차별 workspace, commit하지 않음 |

## 검증

```bash
# cwd: 저장소 루트
jq '.runs | length' eval/runs/plan014-utility.json
jq '[.runs | group_by([.taskId,.condition,.repetition])[] | select(length != 1)] | length' eval/runs/plan014-utility.json
jq '[.runs[] | select(.condition == "no-memory" and .telemetry.memoryCalls != 0)] | length' eval/runs/plan014-utility.json
git status --short
```

결과는 각각 36, 0, 0이어야 한다.

## 의도 메모 (왜)

- 교차 실행은 시간대와 서비스 경쟁을 특정 조건에 몰지 않기 위한 통제다.
- 실패 run을 덮어쓰지 않는 이유는 Memory가 만든 실패도 결과이기 때문이다.

## Blocked 조건

- 36회 중 사용량 제한으로 미완료가 남으면 완료 회차를 보존하고 `PHASE_BLOCKED: Agent 사용량 제한`으로 종료한다.

# Phase 02 — 같은 task에서 automatic 조건을 3회 실행한다

**Execution profile**: standard
**Status**: completed

---

## 목표

plan014의 네 task, revision, index, validation, Codex model을 그대로 사용해 automatic 조건 12회를 직렬 실행한다.

**전제**: phase 01의 automatic 회귀 테스트와 `run-memory.mjs --conditions automatic --dry-run`이 통과하고, plan016에서 구현·병합한 `--source-repository-root` opt-in 재연결이 이 branch에 있어야 한다. 하나라도 없으면 오래된 runner로 우회하지 않는다.

**범위 외**: voluntary 재실행, task·query 변경, 실패 run 삭제, 동시 실행.

---

## 작업 항목 (4)

### 1. 조건 동일성을 검사한다

automatic과 plan014 agent-triggered의 task prompt, base revision, allowed paths, validation commands, Memory index hash, model, effort가 같아야 한다.
차이는 task 시작 전 자동 검색과 안전 필터뿐이다.

### 2. 네 task를 각각 3회 실행한다

task 순서 안에서 repetition을 교차하고 한 번에 Agent 하나만 실행한다.
완료한 유일 키는 재개 시 다시 호출하지 않는다.
Plan014와 같은 Codex `gpt-5.6-luna`, effort `low`, workspace-write를 쓰고 fallback하지 않는다.

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/run-memory.mjs \
  --suite eval/suites/tc-ocr-memory.json \
  --source-lock eval/runs/plan014-memory-source-lock.json \
  --source-repository-root /Users/nhn/projects/OCR \
  --out eval/runs/plan017-memory-automatic.json \
  --data-dir apps/pipeline/data \
  --agent codex \
  --model gpt-5.6-luna \
  --effort low \
  --permission-mode workspace-write \
  --conditions automatic \
  --repeats 3 \
  --schedule interleaved \
  --timeout-ms 600000 \
  --max-output-bytes 4194304
```

### 3. 불필요한 조회와 추가 회수를 표시한다

code-only task의 automatic memory call은 불필요한 조회 후보로 기록한다.
voluntary miss를 automatic이 회수한 experience-needed task는 별도 플래그로 남긴다.
voluntary miss는 plan014의 `triggerOutcome=missed_search` 또는 `retrievalObservations[].outcome=miss`인 attempt로만 판정한다.
automatic 회수는 같은 task에서 validation·taskSuccess가 true이고 wrongEditCount=0인 attempt로만 센다.

### 4. raw run 무결성을 검사한다

12개 attempt에서 memoryCalls는 각각 1이어야 한다.
retrieved, injected, warned, skipped 수의 합과 원본 결과 수가 일치하고 contextBytes가 실제 주입과 맞아야 한다.
staleInjectionCount는 항상 0이어야 한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/runs/plan017-memory-automatic.json` | raw 12회, commit하지 않음 |
| `eval/runs/workspaces/**` | 회차별 workspace, commit하지 않음 |

## 검증

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/run-memory.mjs --suite eval/suites/tc-ocr-memory.json --source-lock eval/runs/plan014-memory-source-lock.json --source-repository-root /Users/nhn/projects/OCR --out /tmp/plan017-dry.json --data-dir apps/pipeline/data --agent codex --model gpt-5.6-luna --effort low --permission-mode workspace-write --conditions automatic --repeats 3 --schedule interleaved --dry-run
jq '.attempts | length' eval/runs/plan017-memory-automatic.json
jq '[.attempts[] | select(.condition != "automatic" or .memoryCalls != 1)] | length' eval/runs/plan017-memory-automatic.json
jq '[.attempts[] | select(.retrievedCount != (.injectedCount + .warnedCount + .skippedStaleCount))] | length' eval/runs/plan017-memory-automatic.json
jq '[.attempts[] | select(.staleInjectionCount != 0)] | length' eval/runs/plan017-memory-automatic.json
git status --short
```

결과는 각각 12, 0, 0, 0이어야 하고 raw run은 `git status`에 나타나지 않아야 한다.

## 의도 메모 (왜)

- automatic은 모든 task에서 검색하므로 code-only 비용을 숨기면 안 된다.
- voluntary raw를 재사용하면 같은 기준선에서 추가 조건만 측정할 수 있다.

## Blocked 조건

- Luna 사용량 제한으로 12회가 끝나지 않으면 완료 회차를 보존하고 `PHASE_BLOCKED: Agent 사용량 제한`으로 종료한다.
- source root real path·basename·base/target commit 검증이 실패하면 `PHASE_BLOCKED: source snapshot 재현 불가`로 종료한다.

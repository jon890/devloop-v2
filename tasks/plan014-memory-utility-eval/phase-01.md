# Phase 01 — source lock과 조건 동일성을 사전 검증한다

**Execution profile**: standard
**Status**: pending

---

## 목표

plan013이 만든 runner와 private source lock을 받아 #9의 세 조건을 비교할 수 있는지 실제 한 task로 사전 검증한다.

**전제**: plan013이 `main`에 병합돼 `.claude/skills/kg-eval/scripts/run-memory.mjs`와 `eval/suites/tc-ocr-memory.json`이 있어야 한다. 없으면 구현하지 말고 중단한다.

**범위 외**: Agent나 Memory 구현 수정, retrieval·Graph·automatic 조건, 반복 수 축소.

---

## 작업 항목 (4)

### 1. 실행 대상을 고정한다

plan013의 private source lock과 benchmark index를 worktree의 ignored `eval/runs/`에 복사한다.
public suite hash, source lock hash, 네 base revision, Memory index hash를 raw run header에 고정한다.

### 2. 판정 명령을 독립 실행한다

각 task workspace를 Agent 없이 materialize한 뒤 validation command가 base에서 실패하고 target patch 적용 상태에서 통과하는지 확인한다.
처음부터 통과하거나 target에서도 실패하는 task는 suite에서 조용히 빼지 않고 source lock 결함으로 보고한다.

### 3. 세 조건 입력의 동일성을 검사한다

동일 task에서 `no-memory`, `agent-triggered`, `oracle-memory`의 prompt, base revision, allowed paths, validation commands가 byte-identical인지 검사한다.
조건별 차이는 Memory policy와 제공 context뿐이어야 한다.

### 4. 한 task를 조건별 1회 pilot 실행한다

Codex `gpt-5.6-luna`, effort `low`를 세 조건에 동일하게 사용한다.
Luna를 사용할 수 없으면 fallback하지 않는다.
taskSuccess, wrongEditCount, turns, toolCalls, sourceReads, memoryCalls, 실제 token usage가 raw run에 남는지 확인한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/runs/plan014-memory-source-lock.json` | private lock 복사, commit하지 않음 |
| `eval/runs/plan014-utility.json` | pilot부터 누적, commit하지 않음 |
| `.claude/skills/kg-eval/tests/memory-utility.test.mjs` | 조건 동일성·판정 회귀 신규 |

## 검증

```bash
# cwd: 저장소 루트
test -f .claude/skills/kg-eval/scripts/run-memory.mjs
node --test .claude/skills/kg-eval/tests/memory-utility.test.mjs
jq '.runs | length' eval/runs/plan014-utility.json
git status --short
```

pilot raw run과 private lock은 `git status`에 나타나지 않아야 한다.

## 의도 메모 (왜)

- base에서도 통과하는 task는 Memory가 아니라 이미 구현된 동작을 재는 것이므로 제외가 아니라 suite 결함이다.
- Agent 모델을 조건마다 바꾸면 Memory 효과와 모델 차이를 분리할 수 없다.

## Blocked 조건

- plan013 산출물이 `main`에 없으면 `PHASE_BLOCKED: plan013 미병합`으로 종료한다.
- Luna를 사용할 수 없으면 `PHASE_BLOCKED: Luna unavailable`로 종료한다.

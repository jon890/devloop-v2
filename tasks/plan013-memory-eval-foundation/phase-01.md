# Phase 01 — Memory 평가 suite와 private source lock 계약을 구현한다

**Execution profile**: deep
**Status**: pending

---

## 목표

기존 `kg-eval`의 반복·재개·hash 관례를 재사용해 Coding Agent 변경 task를 고정하는 공개 suite와 private source lock 계약을 구현한다.

**범위 외**: Agent 실행, #9 세 조건 반복, retrieval·Graph·automatic 비교, production DB 추가.

---

## 작업 항목 (5)

### 1. 기존 skill 계약을 Memory task까지 확장한다

`.claude/skills/kg-eval/SKILL.md`와 `references/result-contract.md`에 `memory-eval-suite/v1`, private source lock, raw run 계약을 추가한다.
기존 HTTP 질문 평가 형식은 바꾸지 않고 suite type별 분기를 명시한다.

### 2. suite와 source lock 검증을 분리한다

`.claude/skills/kg-eval/scripts/memory/suite.mjs`는 공개 suite를 검증한다.
`source-lock.mjs`는 내부 URL, 절대 repository path, 40자 base·target revision, prompt, 허용 경로, 검증 명령, oracle query를 검증한다.
두 파일의 canonical hash를 함께 반환하고 task id·sourceLockKey의 전단사 대응을 강제한다.
`loadMemoryEvaluationInputs({ suitePath, sourceLockPath })` import API를 제공하고,
`validate-memory-suite.mjs --suite <public> --source-lock <private>` CLI는 private 값을 포함하지 않는 한 줄 JSON
`{ schemaVersion, suiteHash, sourceLockHash, taskCount }`만 stdout에 출력한다.

### 3. 원천 저장소를 건드리지 않는 workspace를 만든다

`.claude/skills/kg-eval/scripts/memory/workspace.mjs`는 `git archive <baseRevision>`만 읽어 `eval/runs/workspaces/<run-key>/`에 materialize한다.
그 디렉터리에 평가용 로컬 Git 저장소를 새로 만들어 기준 commit과 최종 diff hash를 계산한다.
원천 repository에서 checkout, fetch, reset, clean, worktree 명령을 실행하면 안 된다.

### 4. raw result의 저장과 판정을 분리한다

`.claude/skills/kg-eval/scripts/memory/result.mjs`는 `(taskId, condition, repetition)`을 유일 키로 사용한다.
suite hash, source lock hash, base revision, validation command, Memory index hash가 다르면 이어 쓰기를 거부한다.
임시 파일 검증 뒤 rename하고 lock 충돌과 중단 뒤 재개를 테스트한다.
`judge.mjs`는 validation 결과, 허용 경로 밖 변경, 최종 diff와 실행 event를 받아
`taskSuccess`, `wrongEditCount`, `reworkCount`를 판정하며 저장 계층이나 Agent process를 직접 호출하지 않는다.

### 5. 공개 suite metadata와 단위 테스트를 추가한다

`eval/suites/tc-ocr-memory.json`에는 내부 prompt·revision·URL 없이 네 task의 안정 ID, 분류, task type, sourceLockKey, expectedTrigger만 둔다.
code-only와 experience-needed를 각각 2개, relationship-heavy를 최소 1개 포함한다.
테스트 fixture는 임시 Git repo를 사용하고 실제 OCR 경로와 ID를 복제하지 않는다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/SKILL.md` | Memory 평가 절차 추가 |
| `.claude/skills/kg-eval/references/result-contract.md` | suite·lock·run 계약 추가 |
| `.claude/skills/kg-eval/scripts/memory/suite.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/source-lock.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/validate-memory-suite.mjs` | 검증 CLI 신규 |
| `.claude/skills/kg-eval/scripts/memory/workspace.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/result.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/judge.mjs` | task 성공·오수정·재작업 판정 신규 |
| `.claude/skills/kg-eval/tests/memory-foundation.test.mjs` | 신규 |
| `.claude/skills/kg-eval/tests/memory-judge.test.mjs` | 신규 |
| `eval/suites/tc-ocr-memory.json` | 신규 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/memory-foundation.test.mjs
node --test .claude/skills/kg-eval/tests/memory-judge.test.mjs
node .claude/skills/kg-eval/scripts/validate-memory-suite.mjs --suite eval/suites/tc-ocr-memory.json --source-lock eval/runs/plan013-memory-source-lock.json
python3 /Users/nhn/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/kg-eval
git diff --check
```

테스트는 원천 repo의 branch, HEAD, tracked·untracked status를 실행 전후 비교하고 모두 같아야 한다.

## 의도 메모 (왜)

- 공개 suite와 private lock 분리는 내부 원문을 공개하지 않으면서 같은 snapshot을 재현하기 위한 경계다.
- 원천에 `git worktree`를 만들지 않는 이유는 읽기 전용 수집 계약을 지키기 위해서다.
- 새 앱이나 package 대신 기존 평가 skill을 확장하는 이유는 ADR 0006의 단일 평가 실행기 결정을 유지하기 위해서다.

## Blocked 조건

- Node가 raw event와 원자 저장 계약을 지원하지 않으면 `PHASE_BLOCKED: Node 평가 runtime 계약 불일치`로 종료한다.

# Phase 03 — 추가 회수와 불필요한 주입으로 채택 여부를 판정한다

**Execution profile**: deep
**Status**: pending

---

## 목표

voluntary와 automatic을 같은 task·revision·index에서 비교해 추가 회수, 불필요한 조회, stale 방어, 전체 효용으로 automatic 채택 여부를 결정한다.

**범위 외**: hook 배포, production 기본값 변경, 검색 backend 교체.

---

## 작업 항목 (5)

### 1. voluntary와 automatic 동일성을 검증한다

plan014 `attempts`의 agent-triggered 12회와 plan017 `attempts`의 automatic 12회가 task, repetition, revision, validation, model, index hash에서 일치해야 한다.

### 2. 추가 회수와 오염을 분리한다

voluntary에서 실패하거나 검색하지 못한 experience-needed task를 automatic이 안정적으로 회복한 경우와,
code-only·무관 result 조회·주입으로 비용 또는 wrong edit를 만든 경우를 별도 표로 만든다.
`recoveredTask`는 voluntary 3회 중 `triggerOutcome=miss` 또는 `retrievalObservations[].outcome=miss` 증거가 최소 1개 있고 성공이 3회 미만이며, automatic 3회가 모두 성공·wrong edit 0인 experience-needed task다.
miss 증거가 없는 Agent·implementation·validation 실패는 recovery로 세지 않는다.
`unnecessaryCodeOnlyAttemptCount`와 `emptyRetrievalAttemptCount`를 각각 기록한다.
판정에 쓰는 `unnecessaryRetrievalAttemptCount`는 두 집합의 attempt key 합집합 크기라 같은 attempt를 두 번 세지 않는다.

### 3. trigger와 비용을 계산한다

precision, recall, task success, wrong edit, memoryCalls, contextBytes, tokens, wallTime, sourceReads를 보고한다.
token null은 분모에서 제외하고 문자 수로 추정하지 않는다.

### 4. 채택 규칙을 적용한다

다음 순서의 결정적 판정표를 적용한다.

| 우선순위 | 조건 | 판정 |
| ---: | --- | --- |
| 1 | staleInjectionCount > 0, automatic wrong edit > voluntary, 또는 task success가 한 task라도 회귀 | `REJECT_AUTOMATIC` |
| 2 | recoveredTask = 0이고 unnecessaryRetrievalAttemptCount > 0 | `REJECT_AUTOMATIC` |
| 3 | recoveredTask >= 1, 회귀·오염 0, task별 automatic median wallTime과 input/output tokens 증가가 모두 voluntary 대비 25% 이하 | `ADOPT_CANDIDATE` |
| 4 | recoveredTask >= 1이지만 어느 비용 증가라도 25% 초과 | `REJECT_AUTOMATIC` |
| 5 | token이 null이거나 3회 결과가 섞여 위 조건을 결정할 수 없음 | `INCONCLUSIVE` |

25%는 자동 조회가 task outcome을 회복해도 실행 비용을 과도하게 늘리지 않는 보수적 상한이다.
문자 수를 token으로 바꾸지 않고 null은 판정 불가로 둔다.

### 5. 공개 report와 전체 완료 상태를 남긴다

`eval/reports/2026-08-12-plan017-memory-automatic.json`과 `.md`에 내부 prompt·URL·Agent 전문 없이 hash·집계·사례 분류·결론을 남긴다.
독립 verifier 두 lane이 raw 24회와 report를 대조한다.
`tasks/plan017-memory-automatic-eval/index.json`과 phase status를 `completed`로 바꾸고 실행 기록을 추가한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/scripts/report-memory-automatic.mjs` | 신규 |
| `.claude/skills/kg-eval/tests/report-memory-automatic.test.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/privacy.mjs` | automatic private input needle 지원 보강 |
| `.claude/skills/kg-eval/tests/memory-privacy.test.mjs` | prompt·revision·URL·context 누출 회귀 보강 |
| `eval/reports/2026-08-12-plan017-memory-automatic.json` | 신규 |
| `eval/reports/2026-08-12-plan017-memory-automatic.md` | 신규 |
| `tasks/plan017-memory-automatic-eval/index.json` | 완료 마킹 |
| `tasks/plan017-memory-automatic-eval/phase-*.md` | 완료 마킹 |
| `docs/retrospectives/RUNS.md` | 실행 기록 추가 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/*.test.mjs
node .claude/skills/kg-eval/scripts/report-memory-automatic.mjs --voluntary eval/runs/plan014-utility.json --automatic eval/runs/plan017-memory-automatic.json --json-out /tmp/plan017-report.json --markdown-out /tmp/plan017-report.md
cmp /tmp/plan017-report.json eval/reports/2026-08-12-plan017-memory-automatic.json
cmp /tmp/plan017-report.md eval/reports/2026-08-12-plan017-memory-automatic.md
node .claude/skills/kg-eval/scripts/memory/privacy.mjs --private-inputs eval/runs/plan014-utility.json,eval/runs/plan017-memory-automatic.json --paths eval/reports/2026-08-12-plan017-memory-automatic.json,eval/reports/2026-08-12-plan017-memory-automatic.md
pnpm -r build
pnpm format:check
git diff --check
git status --short
```

automatic raw run은 `git status`에 나타나지 않아야 한다.

## 의도 메모 (왜)

- automatic 구현 여부가 아니라 end-to-end utility가 최종 판정이다.
- `ADOPT_CANDIDATE`도 바로 배포하지 않고 별도 production 변경이 필요하다.

## Blocked 조건

- raw 24회 또는 조건 hash가 불완전하면 `PHASE_BLOCKED: automatic 비교 입력 불완전`으로 종료한다.

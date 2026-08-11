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

plan014 agent-triggered 12회와 plan017 automatic 12회의 task, revision, validation, model, index hash가 일치해야 한다.

### 2. 추가 회수와 오염을 분리한다

voluntary에서 실패하거나 검색하지 못한 experience-needed task를 automatic이 안정적으로 회복한 경우와,
code-only·무관 result 조회·주입으로 비용 또는 wrong edit를 만든 경우를 별도 표로 만든다.

### 3. trigger와 비용을 계산한다

precision, recall, task success, wrong edit, memoryCalls, contextBytes, tokens, wallTime, sourceReads를 보고한다.
token null은 분모에서 제외하고 문자 수로 추정하지 않는다.

### 4. 채택 규칙을 적용한다

추가 회수 없이 비용만 늘거나 wrong edit·stale 오염이 생기면 `REJECT_AUTOMATIC`이다.
추가 회수가 안정적이고 task success 이득이 Retrieval Tax보다 명확할 때만 `ADOPT_CANDIDATE`로 둔다.
혼합 결과는 `INCONCLUSIVE`다.

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
| `eval/reports/2026-08-12-plan017-memory-automatic.json` | 신규 |
| `eval/reports/2026-08-12-plan017-memory-automatic.md` | 신규 |
| `tasks/plan017-memory-automatic-eval/index.json` | 완료 마킹 |
| `tasks/plan017-memory-automatic-eval/phase-*.md` | 완료 마킹 |
| `docs/retrospectives/RUNS.md` | 실행 기록 추가 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/*.test.mjs
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

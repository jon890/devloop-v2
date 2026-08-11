# Phase 04 — 완료 증거와 문서 정합성을 검증한다

**Execution profile**: standard
**Status**: pending

---

## 목표

plan013의 구현과 실제 smoke가 #3·#8 기반 및 #4~#7 완료 증거를 충족하는지 독립 검토하고 다음 utility 평가가 재사용할 계약을 닫는다.

**범위 외**: #9~#12 결론, 이슈 댓글·종료, 새 관리 문서.

---

## 작업 항목 (4)

### 1. 계약과 구현 정합성을 검증한다

`docs/prd.md`, `docs/flow.md`, `docs/code-architecture.md`, `docs/data-schema.md`, ADR 0012, `docs/IMPROVEMENT.md`와 코드의 명령·필드·경로를 대조한다.
실제 source detail은 문서나 tracked fixture로 이동시키지 않는다.

### 2. skill을 검증한다

`skill-creator`의 `quick_validate.py`와 전체 `kg-eval` 테스트를 실행한다.
기존 HTTP 질문 평가 test가 줄지 않고 Memory 평가 test가 별도로 늘어야 한다.

### 3. 통합 검증과 독립 리뷰를 수행한다

pipeline, LLM, workspace build, format, diff check를 실행한다.
작성자와 다른 code-reviewer와 docs-verifier가 각각 PASS를 내야 한다.
review가 docs를 바꾸면 docs-verifier를 다시 실행한다.

### 4. plan 상태와 실행 기록을 완료한다

`tasks/plan013-memory-eval-foundation/index.json`과 네 phase status를 `completed`로 바꾼다.
`docs/retrospectives/RUNS.md`에 build-with-teams 실행 한 줄을 추가한다.
private source lock과 raw run은 보존하되 commit하지 않는다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/reports/2026-08-12-plan013-memory-foundation.md` | 최종 집계 보강 |
| `tasks/plan013-memory-eval-foundation/index.json` | 완료 마킹 |
| `tasks/plan013-memory-eval-foundation/phase-*.md` | 완료 마킹 |
| `docs/retrospectives/RUNS.md` | 실행 기록 추가 |

## 검증

```bash
# cwd: 저장소 루트
pnpm --filter @devloop/llm test
pnpm --filter pipeline test
node --test .claude/skills/kg-eval/tests/*.test.mjs
python3 /Users/nhn/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/kg-eval
pnpm -r build
pnpm format:check
git diff --check
git status --short
```

실행된 test 수와 skip 수를 보고하고 plan012보다 test 수가 줄면 완료하지 않는다.

## 의도 메모 (왜)

- #3의 전체 utility 결론은 plan014가 소유하지만 재현 가능한 task·조건·계측은 이 plan에서 닫는다.
- Issue 상태 변경을 분리하는 이유는 외부 본문 미리보기와 모든 checkbox 증거를 함께 제공하기 위해서다.

## Blocked 조건

- 독립 reviewer가 acceptance 증거 누락을 발견하면 완료 마킹하지 않고 해당 phase로 돌아간다.

# Phase 03 — task 유형별 Graph 추가 가치와 비용을 판정한다

**Execution profile**: deep
**Status**: pending

---

## 목표

no-memory, oracle-memory, oracle-memory+Graph 결과를 관계형·일반 task별로 비교해 Graph 유지·축소 판단의 근거를 남긴다.

**범위 외**: Neo4j 제거, ontology 재설계, production route 변경.

---

## 작업 항목 (5)

### 1. 세 조건 동일성을 검증한다

task, base revision, validation, Agent model, Memory index가 같은지 검사한다.
Memory+Graph만 source-backed Graph context가 추가돼야 한다.

### 2. task 결과와 비용을 함께 비교한다

task success, wrong edit, validation, wallTime, turns, toolCalls, sourceReads, memoryCalls, graphCalls, Graph latency를 task type별로 표로 만든다.

### 3. 인과 근거를 판정한다

Graph 관계가 성공 run에서 실제 사용됐고 oracle-memory 실패를 안정적으로 회복했을 때만 추가 가치로 판정한다.
혼합 결과는 `INCONCLUSIVE`, 비용만 늘면 `NO_ADDED_VALUE`로 둔다.

### 4. 공개 report를 생성한다

`eval/reports/2026-08-12-plan016-memory-graph.json`과 `.md`에는 내부 anchor·URL·Agent 전문·Graph node property 없이 task ID, type, hash, 집계, 판정만 남긴다.

### 5. 독립 검증과 완료 마킹을 수행한다

verifier 두 lane이 raw 6회와 재사용한 plan014 12회를 report 표에 대조한다.
`tasks/plan016-memory-graph-spike/index.json`과 phase status를 `completed`로 바꾸고 실행 기록을 추가한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/scripts/report-memory-graph.mjs` | 신규 |
| `.claude/skills/kg-eval/tests/report-memory-graph.test.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/privacy.mjs` | `originalRepositoryPath`와 private Graph lock 전체 민감 필드 needle 수집 보강 |
| `.claude/skills/kg-eval/tests/memory-privacy.test.mjs` | Graph anchor·URL 누출 회귀 보강 |
| `eval/reports/2026-08-12-plan016-memory-graph.json` | 신규 |
| `eval/reports/2026-08-12-plan016-memory-graph.md` | 신규 |
| `tasks/plan016-memory-graph-spike/index.json` | 완료 마킹 |
| `tasks/plan016-memory-graph-spike/phase-*.md` | 완료 마킹 |
| `docs/retrospectives/RUNS.md` | 실행 기록 추가 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/*.test.mjs
node .claude/skills/kg-eval/scripts/report-memory-graph.mjs --baseline eval/runs/plan014-utility.json --graph-run eval/runs/plan016-memory-graph.json --graph-lock eval/runs/plan016-graph-lock.json --json-out /tmp/plan016-report.json --markdown-out /tmp/plan016-report.md
cmp /tmp/plan016-report.json eval/reports/2026-08-12-plan016-memory-graph.json
cmp /tmp/plan016-report.md eval/reports/2026-08-12-plan016-memory-graph.md
node .claude/skills/kg-eval/scripts/memory/privacy.mjs --source-lock eval/runs/plan014-memory-source-lock.json --private-inputs eval/runs/plan014-utility.json,eval/runs/plan016-graph-lock.json,eval/runs/plan016-memory-graph.json --paths eval/reports/2026-08-12-plan016-memory-graph.json,eval/reports/2026-08-12-plan016-memory-graph.md
pnpm -r build
pnpm format:check
git diff --check
git status --short
```

Graph 평가 raw와 private lock은 `git status`에 나타나지 않아야 한다.

## 의도 메모 (왜)

- task 유형별 결론을 내리면 일부 관계형 이득을 전체 Graph 유지 또는 제거 결론으로 과장하지 않는다.
- production 변경은 별도 채택 결정이 소유한다.

## Blocked 조건

- Graph context가 실제 사용됐는지 판정할 event 근거가 없으면 `INCONCLUSIVE`로 보고하되 결과를 숨기지 않는다.

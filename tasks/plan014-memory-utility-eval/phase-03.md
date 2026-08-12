# Phase 03 — Memory Benefit과 Retrieval Tax를 분리해 판정한다

**Execution profile**: deep
**Status**: pending

---

## 목표

36개 raw attempt를 task success와 wrong edit 우선으로 판정하고 Memory Benefit, Retrieval Tax, trigger 품질, 실패 경계를 공개 가능한 report로 만든다.

**범위 외**: 단일 종합 점수, retrieval backend 채택, Graph 제거, automatic 배포.

---

## 작업 항목 (5)

### 1. 요약기를 구현한다

`.claude/skills/kg-eval/scripts/report-memory.mjs`는 raw run의 `attempts`를 읽어 task·condition별 안정성을 계산한다.
3회 판정이 섞이면 개선·회귀로 세지 않고 `INCONCLUSIVE`로 둔다.

### 2. Memory Benefit을 별도 표로 만든다

agent-triggered와 oracle이 no-memory보다 task success를 회복하거나 wrong edit·rework·sourceReads를 줄인 task를 표시한다.
성공률보다 task별 변화가 먼저 보이게 한다.

### 3. Retrieval Tax를 별도 표로 만든다

memoryCalls, 추가 sourceReads, turns, toolCalls, wallTime, input/output tokens를 조건별로 보고한다.
token null을 0이나 문자 추정치로 바꾸지 않는다.

### 4. trigger와 실패 경계를 판정한다

code-only skip과 experience-needed trigger를 기준으로 precision·recall을 계산한다.
실패를 SOURCE, MEMORY, RETRIEVAL, AGENT, IMPLEMENTATION, VALIDATION으로 나누고 실제 lexical miss query를 private raw run에 표시한다.
실제 검색 observation에서 `requiredMemoryIds`가 `retrievedMemoryIds` top-k에 하나도 없는 경우만 lexical miss로 센다.
공개 JSON에는 query·Memory ID 대신 `lexicalMissCount`, `retrievalObservationComplete`, canonical private miss lock의 SHA-256만 기록한다.
Memory call 중 `outcome=unobserved`가 하나라도 있으면 `retrievalObservationComplete=false`로 남겨 plan015가 fail-close할 수 있게 한다.

### 5. 공개 report와 완료 상태를 남긴다

`eval/reports/2026-08-12-plan014-memory-utility.json`과 `.md`는 내부 URL, 실제 SHA, prompt, Agent 전문 없이 hash·task ID·집계·판정만 담는다.
독립 verifier 두 lane이 raw attempt와 report 집계를 대조한다.
`tasks/plan014-memory-utility-eval/index.json`과 phase status를 `completed`로 바꾸고 실행 기록을 추가한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/scripts/report-memory.mjs` | 신규 |
| `.claude/skills/kg-eval/tests/report-memory.test.mjs` | 신규 |
| `eval/reports/2026-08-12-plan014-memory-utility.json` | 신규 |
| `eval/reports/2026-08-12-plan014-memory-utility.md` | 신규 |
| `tasks/plan014-memory-utility-eval/index.json` | 완료 마킹 |
| `tasks/plan014-memory-utility-eval/phase-*.md` | 완료 마킹 |
| `docs/retrospectives/RUNS.md` | 실행 기록 추가 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/*.test.mjs
node .claude/skills/kg-eval/scripts/validate-memory-suite.mjs --suite eval/suites/tc-ocr-memory.json --source-lock eval/runs/plan014-memory-source-lock.json
node .claude/skills/kg-eval/scripts/report-memory.mjs --run eval/runs/plan014-utility.json --json-out /tmp/plan014-report.json --markdown-out /tmp/plan014-report.md
cmp /tmp/plan014-report.json eval/reports/2026-08-12-plan014-memory-utility.json
cmp /tmp/plan014-report.md eval/reports/2026-08-12-plan014-memory-utility.md
node .claude/skills/kg-eval/scripts/memory/privacy.mjs --source-lock eval/runs/plan014-memory-source-lock.json --paths eval/reports/2026-08-12-plan014-memory-utility.json,eval/reports/2026-08-12-plan014-memory-utility.md
pnpm -r build
git diff --check
```

동일 raw run에서 report가 byte-identical이어야 한다.
privacy 검사는 private path·URL·revision·prompt·diff·transcript·내부 domain을 출력하지 않고 누출 0건으로 끝나야 한다.

## 의도 메모 (왜)

- 이 report가 #10, #11, #12의 선행 근거이므로 miss와 불확실성을 숨기지 않는다.
- 집계가 아니라 task별 변화를 우선하는 이유는 네 task 표본에서 평균이 실패를 가릴 수 있기 때문이다.

## Blocked 조건

- 36개 run이 없거나 조건 hash가 다르면 `PHASE_BLOCKED: utility 비교 입력 불완전`으로 종료하고 report를 확정하지 않는다.

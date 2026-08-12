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
report는 taskId와 condition 단위로 3회 반복을 묶어 판정하고, 3회가 모두 같은 결과일 때만 안정 상태로 본다.

- `STABLE_SUCCESS`: 3/3이 clean success다. 각 attempt는 `taskSuccess=true`, `wrongEditCount=0`, `failureBoundary=NONE`이어야 하고, agent-triggered attempt라면 retrieval observation도 `unobserved`가 아니어야 한다.
- `STABLE_FAILURE`: 3/3이 clean failure다. 각 attempt는 같은 `failureBoundary`를 가져야 하고 `wrongEditCount=0`이어야 한다.
- `REGRESSION`: 한 번이라도 `wrongEditCount>0`이면 이 상태다. wrong edit가 있으면 stable failure로 숨기지 않는다.
- `UNSTABLE`: 3회가 섞이거나, clean success/failure 규칙을 만족하지 못한 경우다. `unobserved`가 섞인 경우도 여기로 둔다.

`stability`는 `status`, `cleanSuccessCount`, `cleanFailureCount`, `wrongEditCount`, `unobservedCount`를 가진다. stable 판정은 3/3만 인정하고, 2/3 또는 섞인 결과는 개선·회귀로 합산하지 않는다.
`REGRESSION`은 안정 기준값이 아니므로 comparative delta를 만들지 않고, 리포트에는 raw `wrongEditCount` 총합만 별도로 보여 준다.

### 2. Memory Benefit을 별도 표로 만든다

agent-triggered와 oracle이 no-memory보다 task success를 회복하거나 wrong edit·rework·sourceReads를 줄인 task를 표시한다.
성공률보다 task별 변화가 먼저 보이게 한다.

task-level deltas는 no-memory의 안정 기준값을 기준으로 raw difference로 계산한다.
비교 대상이 불안정하면 delta를 만들지 않고 `noMemoryStableUnavailable=true`로 표시한다.
표에는 최소한 `taskSuccessDelta`, `wrongEditCountDelta`, `reworkCountDelta`, `sourceReadsDelta`, `memoryCallsDelta`, `wallTimeMsDelta`, `turnsDelta`, `toolCallsDelta`, `inputTokensDelta`, `outputTokensDelta`를 포함한다.
이 delta는 task별로 먼저 보여 주고, 그 다음에 condition 집계를 붙인다.
stable group의 조건 집계는 모든 attempt를 포함해 계산하고, unstable group의 조건 집계는 별도 표로 보여 주되 comparative delta 계산에는 쓰지 않는다.

### 3. Retrieval Tax를 별도 표로 만든다

memoryCalls, 추가 sourceReads, turns, toolCalls, wallTime, input/output tokens를 조건별로 보고한다.
null 값은 0이나 문자 추정치로 바꾸지 않는다.

조건 집계는 non-null sample의 median을 기본값으로 쓴다.
`wallTimeMs`, `turns`, `toolCalls`, `sourceReads`, `memoryCalls`, `inputTokens`, `outputTokens`는 각각 median으로 보고하고, count형 지표는 sum으로 보고한다.
`inputTokens` 또는 `outputTokens`가 전부 null이면 그 median도 null로 남긴다.
unstable attempt는 median 계산과 delta 계산에서 제외하지만, `unstableCount`에는 포함한다.
stable group 집계와 unstable group 집계는 각각 따로 계산하고, stable group만 비교와 delta의 기준으로 사용한다.

### 4. trigger와 실패 경계를 판정한다

code-only skip과 experience-needed trigger를 기준으로 attempt-level `TP`, `FN`, `FP`, `TN`을 계산한다.
`TP`는 experience-needed task에서 agent-triggered search가 실제로 발생한 경우, `FN`은 experience-needed task에서 search가 발생하지 않은 경우, `FP`는 code-only task에서 불필요한 search가 발생한 경우, `TN`은 code-only task에서 search가 발생하지 않은 경우다.
`unobserved` retrieval은 혼동표에서 제외하고 별도 `unobservedCount`로 남긴다.
precision과 recall은 분모가 0이면 null로 둔다.

실제 검색 observation에서 `requiredMemoryIds`가 `retrievedMemoryIds` top-k에 하나도 없는 경우만 lexical miss로 센다.
lexical miss는 clean success attempt에서만 진단으로 노출한다. attempt가 실패하거나 wrong edit가 있으면 failure boundary가 우선이고 lexical miss는 secondary diagnostic으로만 남긴다.
실패를 `SOURCE`, `MEMORY`, `RETRIEVAL`, `AGENT`, `IMPLEMENTATION`, `VALIDATION`, `NONE`으로 나누되, `failureBoundary`가 lexical miss보다 우선한다.
`outcome=unobserved`가 하나라도 있으면 `retrievalObservationComplete=false`로 남기고 lexical miss를 추론하지 않는다.
failure boundary는 아래 순서로 결정한다.

- `SOURCE`: report 전제 조건 실패, run hash 불일치, task input 불일치, generation 생성 실패
- `MEMORY`: oracle required 실패, condition contamination, `no-memory`에서 `memoryCalls>0`, `oracle-memory`에서 expected memory missing, required oracle failure
- `AGENT`: `status!=0`, `timedOut=true`, `outputOverflow` 존재
- `RETRIEVAL`: agent-triggered attempt가 실패했고, 더 높은 boundary가 없으며, complete proven miss가 입증된 경우
- `IMPLEMENTATION`: `wrongEditCount>0` 또는 `taskSuccess=false`이면서 `validationStatus===0`
- `VALIDATION`: `validationStatus!=0`
- `NONE`: 위 조건이 모두 아니면

private ignored `eval/runs/plan014-private-miss-lock.json`는 canonical sorted JSON으로 저장하고 SHA-256을 계산한다.
최상위 object는 `schemaVersion`, `suiteHash`, `sourceLockHash`, `memoryIndexHash`, `attempts`를 가진다.
`attempts`는 `taskId`, `condition`, `repetition` 순으로 정렬하고, 각 항목은 `sourceRunKey`, `triggerOutcome`, `query`, `topK`, `requiredMemoryIds`, `retrievedMemoryIds`, `outcome`, `lexicalMiss`, `failureBoundary`를 가진다.
`requiredMemoryIds`와 `retrievedMemoryIds`는 각각 정렬된 배열로 저장한다.
공개 JSON에는 query나 Memory ID를 쓰지 않고 `lexicalMissCount`, `retrievalObservationComplete`, `privateMissLockHash`만 기록한다.
canonical bytes는 객체 키를 재귀적으로 사전순 정렬하고, 배열은 명시적으로 정렬해야 하는 `attempts`와 ID 배열만 정렬한 뒤 `JSON.stringify(value, null, 2) + "\n"` 형식으로 UTF-8 인코딩해 SHA-256을 계산한다.

### 5. 공개 report와 완료 상태를 남긴다

`eval/reports/2026-08-12-plan014-memory-utility.json`과 `.md`는 내부 URL, 실제 SHA, prompt, Agent 전문, query, Memory ID 없이 hash·task ID·집계·판정만 담는다.
집계에는 condition별 stability, task-level deltas, Retrieval Tax median, trigger 혼동표, `lexicalMissCount`, `retrievalObservationComplete`, `privateMissLockHash`가 들어간다.
독립 verifier 두 lane이 raw attempt와 report 집계를 대조한다.
`tasks/plan014-memory-utility-eval/index.json`과 phase status를 `completed`로 바꾸고 실행 기록을 추가한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/scripts/report-memory.mjs` | 신규 |
| `.claude/skills/kg-eval/tests/report-memory.test.mjs` | 신규 |
| `.claude/skills/kg-eval/tests/memory-utility.test.mjs` | report stability·delta·trigger 회귀 보강 |
| `.claude/skills/kg-eval/tests/fixtures/memory/report/*.jsonl` | Codex·Claude event pair·unobserved·lexical miss fixture 신규 |
| `eval/runs/plan014-private-miss-lock.json` | private miss lock, commit하지 않음 |
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
fixture는 3/3 clean success, 3/3 clean failure, mixed unstable, unobserved retrieval, TP/FN/FP/TN, lexical miss vs failure boundary precedence를 모두 덮어야 한다.

## 의도 메모 (왜)

- 이 report가 #10, #11, #12의 선행 근거이므로 miss와 불확실성을 숨기지 않는다.
- 집계가 아니라 task별 변화를 우선하는 이유는 네 task 표본에서 평균이 실패를 가릴 수 있기 때문이다.

## Blocked 조건

- 36개 run이 없거나 조건 hash가 다르면 `PHASE_BLOCKED: utility 비교 입력 불완전`으로 종료하고 report를 확정하지 않는다.

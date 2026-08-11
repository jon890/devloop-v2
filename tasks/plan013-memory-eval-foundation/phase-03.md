# Phase 03 — 실제 OCR task와 Memory index로 수직 smoke를 검증한다

**Execution profile**: deep
**Status**: pending

---

## 목표

실제 OCR Git 이력에서 고정한 네 task와 실제 Experience Memory index로 source lock, Agent trigger, telemetry를 검증하고 #4~#7의 완료 증거를 보강한다.

**범위 외**: #9의 task별 3회 전체 실행, 실제 source detail 공개, Graph·automatic 조건.

---

## 작업 항목 (5)

### 1. private source lock을 만든다

ignored `eval/runs/plan013-memory-source-lock.json`에 네 task의 실제 OCR repository path·URL, base·target revision, prompt, 허용 경로, 검증 명령, source URL, oracle query를 넣는다.
두 code-only, 두 experience-needed, relationship-heavy 최소 하나를 유지한다.

### 2. 필요한 evidence packet을 한 generation으로 추출한다

기존 `extract-memory --ids <comma-list>`를 사용해 여러 packet을 하나의 partial extraction generation으로 만든다.
제품 CLI나 model/provider/effort override는 추가하지 않고 기존 `gpt-5.6-luna`·`low`를 유지한다.
같은 packet 집합의 순서가 달라도 generation과 cache identity가 같음을 기존 extractor 경계의 회귀 테스트로 고정한다.

### 3. benchmark index를 만들고 고정한다

네 target commit packet을 추출하고 `--allow-incomplete`로 benchmark Wiki를 만든다.
동일 재실행에서 `calls=0`, 실패 0건을 확인하고 index hash를 private lock에 기록한다.
모든 oracle query가 예상 Memory와 HTTP SourceRef를 반환해야 한다.

### 4. #4~#7 acceptance를 다시 점검한다

normalize 전후 OCR repo의 branch, HEAD, tracked status와 `.omc/`를 제외한 source status를 비교한다.
같은 normalize byte/hash, 같은 Wiki tree/hash, 같은 query 순서, 원문 link 누락 0건을 확인한다.
`.omc/` runtime 변화는 source status에서 제외한 이유와 raw 수치를 공개 report에 익명화해 남긴다.
`privacy.mjs`는 private lock에서 민감 문자열과 내부 domain을 읽어 tracked suite·report를 검사한다.
실제 repository path, repository URL·sourceUrl, prompt, diff, Agent transcript, 내부 domain이 발견되면 실패하되
stdout과 오류에는 일치한 비공개 값을 출력하지 않는다.

### 5. Agent별 한 회차 smoke를 실행한다

code-only task는 voluntary 검색 0회, experience-needed task는 검색 1회 이상을 기대한다.
Codex와 Claude를 각각 최소 한 task에 실행하고 memoryCalls·sourceReads·token availability가 raw run에 기록되는지 확인한다.
내부 prompt, diff, URL, Agent 전문은 커밋하지 않는다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/memory/experience-extractor.test.ts` | 기존 `--ids` 순서·generation 동일성 회귀 보강 |
| `.claude/skills/kg-eval/scripts/run-memory.mjs` | 수직 실행 entrypoint 신규 |
| `.claude/skills/kg-eval/scripts/memory/privacy.mjs` | tracked 산출물 비공개 정보 누출 검사 신규 |
| `.claude/skills/kg-eval/tests/run-memory.test.mjs` | 재개·동일성·실패 테스트 신규 |
| `.claude/skills/kg-eval/tests/memory-privacy.test.mjs` | path·URL·prompt·diff·전문·domain 누출 검사 신규 |
| `eval/runs/plan013-memory-source-lock.json` | 생성하지만 커밋하지 않음 |
| `eval/reports/2026-08-12-plan013-memory-foundation.md` | 공개 가능한 집계 신규 |

## 검증

```bash
# cwd: 저장소 루트
pnpm --filter pipeline test
node --test .claude/skills/kg-eval/tests/*.test.mjs
node .claude/skills/kg-eval/scripts/run-memory.mjs --help
jq '.tasks | length' eval/runs/plan013-memory-source-lock.json
node .claude/skills/kg-eval/scripts/memory/privacy.mjs --source-lock eval/runs/plan013-memory-source-lock.json --paths eval/suites/tc-ocr-memory.json,eval/reports/2026-08-12-plan013-memory-foundation.md
git status --short
```

private lock과 raw run은 `git status`에 나타나지 않아야 한다.
privacy 검사는 비공개 값을 출력하지 않으면서 실제 OCR root path, repository URL·sourceUrl, prompt, diff, Agent transcript, 모든 내부 domain 누출 0건을 증명해야 한다.

## 의도 메모 (왜)

- 기존 `--ids` 선택은 benchmark가 같은 index를 공유하면서 전체 corpus 추출 비용을 피한다.
- `.omc/`는 source repo 내용이 아니라 Orca runtime이므로 별도 계측하고 source status에서 제외한다.
- smoke는 runner 계약 검증이며 #9의 효용 결론을 대신하지 않는다.

## Blocked 조건

- 실제 source lock의 revision이나 HTTP 원문 URL을 확인할 수 없으면 `PHASE_BLOCKED: benchmark 원천 고정 실패`로 종료한다.
- `gpt-5.6-luna`를 사용할 수 없으면 fallback 없이 `PHASE_BLOCKED: Luna unavailable`로 종료한다.

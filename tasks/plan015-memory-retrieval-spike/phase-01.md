# Phase 01 — utility 평가의 실제 lexical miss를 고정한다

**Execution profile**: standard
**Status**: completed

---

## 목표

plan014 raw run에서 Agent가 필요한 Memory를 lexical 검색으로 찾지 못한 실제 query만 #10 비교 입력으로 고정한다.

**전제**: plan014가 `main`에 병합되고 공개 report와 ignored `eval/runs/plan014-utility.json`이 이 worktree에 복사돼 있어야 한다. private raw가 없으면 공개 report만으로 query를 추정하지 않고 중단한다.

**범위 외**: synthetic query 추가, production 검색 변경, miss 없이 기술 비교 강행.

---

## 작업 항목 (4)

### 1. miss 판정 기준을 검증한다

experience-needed task에서 voluntary memory call이 있었지만 required oracle Memory가 top-k에 없었던 run만 lexical false negative로 센다.
Agent가 검색하지 않은 경우는 AGENT boundary이며 retrieval miss에 넣지 않는다.
`plan014-utility.json.attempts[].retrievalObservations[]`만 입력으로 사용한다.
필수 필드는 `sourceRunKey`, `query`, `topK`, `requiredMemoryIds`, `retrievedMemoryIds`, `memoryIndexHash`, `outcome`이며 `outcome=unobserved`는 miss가 아니라 불완전 handoff로 차단한다.

### 2. private query lock을 만든다

ignored `eval/runs/plan015-retrieval-misses.json`에 taskId, query, requiredMemoryIds, retrievedMemoryIds, sourceRunKeys, topK, memoryIndexHash, wikiGenerationId, corpusIndexPath, corpusIndexHash를 넣는다.
sourceRunKey는 `${taskId}:${condition}:${repetition}` 형식이며 각 query는 plan014의 실제 attempt에 추적돼야 한다.
모든 miss의 topK는 production 기본값 10이어야 하고, current Wiki pointer가 가리키는 immutable `memory/<project>/wiki-generations/<wikiGenerationId>/index.json`의 바이트 hash를 잠근다.

### 3. 공개 입력 hash를 기록한다

내부 query와 Memory title을 공개 report에 복제하지 않고 miss 수, task 분류, canonical query lock hash, corpus index hash만 남긴다.
plan014 공개 JSON의 `lexicalMissCount`, `retrievalObservationComplete`, private miss lock hash와 새로 추출한 값이 모두 일치해야 한다.

### 4. miss 0건 분기를 처리한다

실제 miss가 0건이면 adapter를 구현하지 않는다.
`no change`가 유효한 결론인 report를 만들고 Phase 02를 `not-triggered`로 기록한 뒤 Phase 03의 완료 감사로 간다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/runs/plan014-utility.json` | plan014 private handoff 입력, 수정·commit하지 않음 |
| `eval/runs/plan015-retrieval-misses.json` | 생성하지만 commit하지 않음 |
| `.claude/skills/kg-eval/scripts/memory/retrieval-misses.mjs` | miss 추출 신규 |
| `.claude/skills/kg-eval/tests/retrieval-misses.test.mjs` | 경계 분류 신규 |

## 검증

```bash
# cwd: 저장소 루트
test -f eval/reports/2026-08-12-plan014-memory-utility.json
test -f eval/runs/plan014-utility.json
node --test .claude/skills/kg-eval/tests/retrieval-misses.test.mjs
jq '[.misses[] | select((.sourceRunKeys | length) == 0)] | length' eval/runs/plan015-retrieval-misses.json
jq '[.misses[] | select(.topK != 10)] | length' eval/runs/plan015-retrieval-misses.json
jq '[.misses[] | .memoryIndexHash] | unique | length' eval/runs/plan015-retrieval-misses.json
git status --short
```

세 `jq` 결과는 각각 0, 0, 1이어야 한다.
miss가 0건이면 마지막 unique count는 0이 정상이며 private query lock은 `git status`에 나타나지 않아야 한다.

## 의도 메모 (왜)

- Agent가 검색하지 않은 실패를 retrieval 결함으로 세면 더 복잡한 backend가 잘못 채택된다.
- miss가 없을 때 구현하지 않는 것이 Issue #10의 acceptance와 ADR 0011에 맞는다.

## Blocked 조건

- plan014 raw run과 공개 report의 miss count·observation complete·lock hash가 다르면 `PHASE_BLOCKED: lexical miss 근거 불일치`로 종료한다.
- plan014 Memory index의 current pointer·wiki generation·index hash가 private observation과 다르면 `PHASE_BLOCKED: retrieval corpus 변경`으로 종료한다.

## 실행 결과

- Plan014 raw 36개와 공개 report, private miss lock의 hash를 교차 검증했다.
- `missCount=0`, `retrievalObservationComplete=true`, private lock hash 일치를 확인했다.
- 검색이 실행된 attempt가 없어 query·corpus 세부를 추정하지 않고 빈 miss lock을 결정적으로 생성했다.
- 실행 형태는 `BOUNDED`, 실제 구현은 team-lead 직접 수행했으며 승격은 없었다.
- targeted test 3개와 실제 ignored handoff 생성, 세 `jq` 검증을 통과했다.
- 신규 회고, pre-existing 문제, 신규 deprecation, 미검증, 범위 외 발견은 없다.

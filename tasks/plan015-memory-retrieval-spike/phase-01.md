# Phase 01 — utility 평가의 실제 lexical miss를 고정한다

**Execution profile**: standard
**Status**: pending

---

## 목표

plan014 raw run에서 Agent가 필요한 Memory를 lexical 검색으로 찾지 못한 실제 query만 #10 비교 입력으로 고정한다.

**전제**: plan014가 `main`에 병합되고 `eval/reports/2026-08-12-plan014-memory-utility.json`이 있어야 한다. 없으면 중단한다.

**범위 외**: synthetic query 추가, production 검색 변경, miss 없이 기술 비교 강행.

---

## 작업 항목 (4)

### 1. miss 판정 기준을 검증한다

experience-needed task에서 voluntary memory call이 있었지만 required oracle Memory가 top-k에 없었던 run만 lexical false negative로 센다.
Agent가 검색하지 않은 경우는 AGENT boundary이며 retrieval miss에 넣지 않는다.

### 2. private query lock을 만든다

ignored `eval/runs/plan015-retrieval-misses.json`에 taskId, query, requiredMemoryIds, indexHash, sourceRunKeys를 넣는다.
각 query는 plan014의 실제 run key로 추적돼야 한다.

### 3. 공개 입력 hash를 기록한다

내부 query와 Memory title을 공개 report에 복제하지 않고 miss 수, task 분류, query lock hash, corpus/index hash만 남긴다.

### 4. miss 0건 분기를 처리한다

실제 miss가 0건이면 adapter를 구현하지 않는다.
`no change`가 유효한 결론인 report를 만들고 Phase 02를 `not-triggered`로 기록한 뒤 Phase 03의 완료 감사로 간다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/runs/plan015-retrieval-misses.json` | 생성하지만 commit하지 않음 |
| `.claude/skills/kg-eval/scripts/memory/retrieval-misses.mjs` | miss 추출 신규 |
| `.claude/skills/kg-eval/tests/retrieval-misses.test.mjs` | 경계 분류 신규 |

## 검증

```bash
# cwd: 저장소 루트
test -f eval/reports/2026-08-12-plan014-memory-utility.json
node --test .claude/skills/kg-eval/tests/retrieval-misses.test.mjs
jq '[.misses[] | select((.sourceRunKeys | length) == 0)] | length' eval/runs/plan015-retrieval-misses.json
git status --short
```

추적 없는 miss는 0건이어야 하고 private query lock은 `git status`에 나타나지 않아야 한다.

## 의도 메모 (왜)

- Agent가 검색하지 않은 실패를 retrieval 결함으로 세면 더 복잡한 backend가 잘못 채택된다.
- miss가 없을 때 구현하지 않는 것이 Issue #10의 acceptance와 ADR 0011에 맞는다.

## Blocked 조건

- plan014 raw run과 공개 report 집계가 다르면 `PHASE_BLOCKED: lexical miss 근거 불일치`로 종료한다.

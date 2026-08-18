# Phase 01 — 관계형·일반 task와 Graph anchor를 고정한다

**Execution profile**: deep
**Status**: completed

---

## 목표

plan014의 같은 source-locked task 중 관계형 후보 하나와 일반 구현 task 하나를 선택하고 현재 Graph에서 확인할 source-backed anchor를 고정한다.

**전제**: plan013 runner와 plan014 utility 구현·report가 `main`에 병합되고, plan014 private source lock과 `eval/runs/plan014-utility.json`이 이 worktree에 복사돼 있어야 한다. 선행 파일이 없으면 현재 branch의 오래된 코드로 대체하지 않고 중단한다. plan014가 고정한 Wiki index 원문은 이전 실행 기록에서 복구한 뒤 exact byte hash `sha256:8709e0a8f3443eb067f30c9a535ccd489ac4fdc0528278ce1c671e838bac00fd`를 확인해 ignored `apps/pipeline/data/memory/tc-ocr/`에 배치한다. hash가 다르면 재추출하거나 새 corpus로 대체하지 않는다.

**범위 외**: ontology 변경, Neo4j 재적재·삭제, Graph 결과를 Memory 추출 입력으로 사용, 질의 LLM 호출.

---

## 작업 항목 (5)

### 1. task 두 개를 선택한다

public suite의 `tags`에 `relationship-heavy`가 있는 `MEM-EXP-001`을 관계형 task로 고정한다.
같은 experience-needed category이면서 해당 tag가 없는 `MEM-EXP-002`를 일반 task로 고정한다.
새 task나 revision을 만들지 않고 두 task의 plan014 완료 attempt를 재사용한다.

### 2. source lock의 실행 위치를 안전하게 재연결한다

plan014 source lock 자체와 그 hash는 수정하지 않는다.
`run-memory.mjs --source-repository-root /Users/nhn/projects/OCR`를 명시했을 때만 각 task의 `originalRepositoryPath` basename을 이 root 아래의 read-only Git repository로 resolve한다.
resolved real path가 root 밖이거나, basename이 source lock과 다르거나, base·target commit이 없으면 Agent 실행 전에 fail-close한다.
`repositoryPath`가 가리키던 삭제된 plan014 worktree를 묵시적으로 fallback하지 않고 opt-in 실행 위치와 검증 결과만 private graph lock에 남긴다.
OCR 원본 저장소에는 `git archive`, `git cat-file`, `git show`만 실행하고 checkout·reset·clean·commit을 하지 않는다.

### 3. private Graph anchor를 고정한다

ignored `eval/runs/plan016-graph-lock.json`에 taskId, taskType, sourceRef, label, key, resolvedElementId, depth, requiredRelationshipType, API base URL, graphStatsHash, sourceLockHash, plan014RunKeys를 기록한다.
anchor는 해당 source-locked Git commit의 subject·body·oracleQuery에 실제로 등장하는 개념을 사용하고, exact source commit URL을 원문 link로 둔다.
`MEM-EXP-001`은 commit body와 oracleQuery에 공통으로 존재하는 Concept `LB`, `MEM-EXP-002`는 commit subject와 oracleQuery에 공통으로 존재하는 Concept `cab api`를 사용한다.
둘 다 source lock의 `sourceUrl`과 target revision을 exact match하고, 개념 문자열이 commit text와 oracleQuery 양쪽에서 발견되지 않으면 fail-close한다.
Dooray task 504·464는 Graph 연결의 보조 이웃일 뿐 anchor provenance로 주장하지 않는다.
`label`과 `key`를 `/api/graph/samples` pagination으로 exact match해 `resolvedElementId`를 얻고, 그 ID를 `/api/graph/nodes/:id/neighbors`에 넘긴다.
element ID만 lock에 직접 적거나 search 순위 첫 항목을 anchor로 쓰지 않는다.

### 4. 현재 Graph 도달성을 사전 검증한다

기존 `/api/graph/samples`, `/api/graph/search`, `/api/graph/nodes/:id/neighbors`만 읽기 전용으로 호출한다.
anchor와 required relationship이 없으면 Graph가 유리하다고 추정하지 않고 GRAPH boundary 실패로 기록한다.
`pnpm -r build` 후 별도 실행 세션에서 `.env`를 적재하고 `PORT=3016 node apps/api/dist/main.js`를 직접 기동한다.
`http://127.0.0.1:3016/api/graph/stats`의 schema와 canonical hash를 preflight로 고정하고, 측정 중 같은 API에 다른 질의를 보내지 않는다.
이 plan이 시작한 정확한 API process만 phase 01·02의 성공, 중간 실패, 차단 종료 모두에서 정리하며 기존 3000·5173·7687·15434 process와 container는 건드리지 않는다.

### 5. 비교 조건을 잠근다

이 plan에서 말하는 `Memory`는 plan014의 `oracle-memory`로 고정한다.
두 task 각각의 `no-memory`, `oracle-memory` attempt 3회씩 총 12개 sourceRunKey를 고정한다.
새 `memory-graph` 조건은 같은 prompt, revision, validation, Memory IDs를 쓰고 Graph context만 추가한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/runs/plan016-graph-lock.json` | 생성하지만 commit하지 않음 |
| `eval/runs/plan014-utility.json` | plan014 private handoff 입력, 수정·commit하지 않음 |
| `.claude/skills/kg-eval/scripts/memory/graph-lock.mjs` | anchor·동일성 검증 신규 |
| `.claude/skills/kg-eval/scripts/memory/source-repository-root.mjs` | private source lock hash를 바꾸지 않는 명시적 실행 위치 resolve 신규 |
| `.claude/skills/kg-eval/scripts/run-memory.mjs` | `--source-repository-root` opt-in 전달 |
| `.claude/skills/kg-eval/tests/memory-graph-lock.test.mjs` | 회귀 테스트 신규 |

## 검증

```bash
# cwd: 저장소 루트
test -f eval/reports/2026-08-12-plan014-memory-utility.json
test -f eval/runs/plan014-utility.json
test "$(shasum -a 256 apps/pipeline/data/memory/tc-ocr/wiki-generations/wiki-9df083959e2b83b7324eabb67197cbcaacd1797f32e77b148cfc47c9969909eb/index.json | awk '{print $1}')" = "8709e0a8f3443eb067f30c9a535ccd489ac4fdc0528278ce1c671e838bac00fd"
node --test .claude/skills/kg-eval/tests/memory-graph-lock.test.mjs
jq '.tasks | length' eval/runs/plan016-graph-lock.json
jq '[.tasks[] | .taskType] | unique | length' eval/runs/plan016-graph-lock.json
jq '[.tasks[].plan014RunKeys[]] | length' eval/runs/plan016-graph-lock.json
jq '[.tasks[] | select((.resolvedElementId | length) == 0 or (.requiredRelationshipType | length) == 0)] | length' eval/runs/plan016-graph-lock.json
git status --short
```

네 `jq` 출력은 각각 2, 2, 12, 0이어야 하고 private lock은 `git status`에 나타나지 않아야 한다.
Phase 01이 어느 경로로 끝나든 3016 process를 종료하고 포트가 닫혔는지 확인한다.

## 의도 메모 (왜)

- no-memory와 Memory를 다시 실행하지 않는 이유는 같은 plan014 조건을 직접 재사용해 Agent 변동 비용을 줄이기 위해서다.
- Graph anchor는 주제 유사성이 아니라 원문 참조로 고정해야 순환 검증을 피할 수 있다.
- 복구한 index의 exact byte hash가 같으므로 새 Memory 추출 LLM 호출 없이 plan014 조건을 재현한다.

## Blocked 조건

- 현재 Graph API가 읽기 전용으로 응답하지 않으면 `PHASE_BLOCKED: Graph 비교 대상 부재`로 종료한다.
- plan014 attempt 12개의 task·condition·repetition·revision·validation·Memory index가 맞지 않으면 `PHASE_BLOCKED: Graph 기준선 불완전`으로 종료한다.
- 복구한 Wiki index hash가 plan014와 다르거나 OCR root의 base·target commit을 read-only로 확인할 수 없으면 `PHASE_BLOCKED: source snapshot 재현 불가`로 종료한다.

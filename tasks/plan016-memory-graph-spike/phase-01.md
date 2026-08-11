# Phase 01 — 관계형·일반 task와 Graph anchor를 고정한다

**Execution profile**: deep
**Status**: pending

---

## 목표

plan014의 같은 source-locked task 중 관계형 후보 하나와 일반 구현 task 하나를 선택하고 현재 Graph에서 확인할 source-backed anchor를 고정한다.

**전제**: plan014가 `main`에 병합되고 private source lock과 raw utility run을 worktree에 복사할 수 있어야 한다.

**범위 외**: ontology 변경, Neo4j 재적재·삭제, Graph 결과를 Memory 추출 입력으로 사용, 질의 LLM 호출.

---

## 작업 항목 (4)

### 1. task 두 개를 선택한다

public suite의 `relationship-heavy` task 최소 하나와 `ordinary` task 최소 하나를 고른다.
새 task나 revision을 만들지 않고 plan014에서 완료한 run을 재사용한다.

### 2. private Graph anchor를 고정한다

ignored `eval/runs/plan016-graph-lock.json`에 taskId, source-backed Task·Comment key, depth, required relationship type을 기록한다.
anchor는 Dooray 원문 또는 task의 Git commit message가 실제로 참조하는 업무에서만 만든다.

### 3. 현재 Graph 도달성을 사전 검증한다

기존 `/api/graph/samples`, `/api/graph/search`, `/api/graph/nodes/:id/neighbors`만 읽기 전용으로 호출한다.
anchor와 required relationship이 없으면 Graph가 유리하다고 추정하지 않고 GRAPH boundary 실패로 기록한다.

### 4. 비교 조건을 잠근다

plan014의 `no-memory`, `oracle-memory` run 중 선택 task의 3회 결과를 고정한다.
새 `memory-graph` 조건은 같은 prompt, revision, validation, Memory IDs를 쓰고 Graph context만 추가한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/runs/plan016-graph-lock.json` | 생성하지만 commit하지 않음 |
| `.claude/skills/kg-eval/scripts/memory/graph-lock.mjs` | anchor·동일성 검증 신규 |
| `.claude/skills/kg-eval/tests/memory-graph-lock.test.mjs` | 회귀 테스트 신규 |

## 검증

```bash
# cwd: 저장소 루트
test -f eval/reports/2026-08-12-plan014-memory-utility.json
node --test .claude/skills/kg-eval/tests/memory-graph-lock.test.mjs
jq '.tasks | length' eval/runs/plan016-graph-lock.json
jq '[.tasks[] | .taskType] | unique | length' eval/runs/plan016-graph-lock.json
git status --short
```

두 출력은 각각 2와 2여야 하고 private lock은 `git status`에 나타나지 않아야 한다.

## 의도 메모 (왜)

- no-memory와 Memory를 다시 실행하지 않는 이유는 같은 plan014 조건을 직접 재사용해 Agent 변동 비용을 줄이기 위해서다.
- Graph anchor는 주제 유사성이 아니라 원문 참조로 고정해야 순환 검증을 피할 수 있다.

## Blocked 조건

- 현재 Graph API가 읽기 전용으로 응답하지 않으면 `PHASE_BLOCKED: Graph 비교 대상 부재`로 종료한다.

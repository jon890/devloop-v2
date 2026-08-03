# Phase 04 — gold 를 보강으로 낮추고 새 기준선을 남긴다

**Execution profile**: standard
**Status**: completed

---

## 목표

평가 세트가 **구조 관계로 이미 증명된 사실을 댓글로도 요구**하는 곳이 있다. 엔진 결함이 아니라
기준의 문제다. 그 요구를 필수에서 보강으로 낮추고, 그 시점의 새 기준선을 남긴다.

실측 사례가 `AGW-A01` 이다. 질문은 "Task 496~499가 Task 483의 Phase B 하위 업무라는 근거를
찾아라" 이고, 엔진은 이런 Cypher 로 답했다.

```cypher
MATCH (parent:Task {number: 483})<-[:CHILD_OF]-(task:Task)
WHERE task.number IN [496, 497, 498, 499]
```

필수 근거 5개 중 업무 4건을 다 물어왔고 댓글 1건만 없다. 그 댓글은 483 에 달린
"Phase B 하위 업무다" 라는 서술이다. **`CHILD_OF` 관계로 증명한 것이 그 서술보다 강한 근거다.**

**이 phase 는 Phase 03 의 측정이 끝난 뒤에만 실행한다.** 순서를 바꾸면 엔진 효과를 영영
비교할 수 없다 — `compare.mjs:73-75` 가 세트 해시 불일치에 예외를 던진다.

**범위 외**

- 코드 변경 — Phase 01·02 에서 끝난다
- 엔진 효과 측정 — Phase 03
- 새 문항 추가나 질문 문구 수정 — 이 plan 의 범위가 아니다

---

## 작업 항목 (4)

### 1. `AGW-A01` 의 댓글 근거를 보강으로 낮춘다

`eval/suites/tc-ocr-api-gateway.json` 에서 `AGW-A01` 의 `comment-483-phase-b` 를
`requiredEvidence` 에서 빼고 `supportingEvidence` 에 넣는다.

`sourceRefs` 항목 자체는 지우지 마라. 보강 근거도 참조 정의가 필요하다.

세트를 고친 뒤 검증기를 돌린다.

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/validate-suite.mjs \
  --suite eval/suites/tc-ocr-api-gateway.json \
  --data-root apps/pipeline/data
```

### 2. 다른 문항의 같은 유형을 조사만 하고 보고한다

Phase 03 결과에서 **구조 관계로 증명 가능한데 댓글을 필수로 요구하는** 문항이 더 있는지 본다.
판정 기준은 하나다 — 그 댓글이 주장하는 사실이 `CHILD_OF`·`DECIDED_IN`·`REFERENCES` 같은
관계로 그래프에 이미 표현돼 있는가.

**후보를 찾아도 직접 고치지 마라.** 문항 id·해당 댓글·대체하는 관계를 근거로 정리해 조정자에게
보고한다. 평가 기준을 무엇으로 볼지는 사람이 정할 판단이다.

### 3. 새 기준선을 측정한다

세트 해시가 바뀌어 재개가 되지 않으므로 처음부터 36회를 돌린다.

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/run.mjs \
  --suite eval/suites/tc-ocr-api-gateway.json \
  --stage plan006-baseline \
  --api-base-url http://localhost:3000 \
  --query-model gpt-5.6-terra \
  --repeats 3 \
  --out eval/runs/plan006-baseline.json
```

### 4. 리포트에 비교 불가를 명시한다

새 기준선 리포트에 아래를 반드시 적는다.

- **`compare.mjs` 로 이전 기준선과 비교할 수 없다.** 세트 해시가 달라졌기 때문이다
- 바뀐 문항과 무엇을 필수에서 보강으로 옮겼는지
- Phase 03 결과와의 차이 중 **기준 변경 몫과 그 밖의 몫을 문항 단위로 구분**한다
- 그래프 스냅샷과 실제 측정 문항 수

이 리포트가 다음 개선의 기준선이 된다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/suites/tc-ocr-api-gateway.json` | 수정 |
| `eval/reports/<실행일>-plan006-baseline.json` | 신규 |
| `eval/reports/<실행일>-plan006-baseline.md` | 신규 |
| `tasks/plan006-evidence-retrieval/index.json` | 수정 — `status` 를 `completed` 로 |

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

판단 저장소를 건드리지 않으므로 pipeline 테스트는 5건 건너뜀이 정상이다.

세트와 리포트를 확인한다.

- `validate-suite.mjs` 가 통과한다
- `AGW-A01` 의 `requiredEvidence` 가 4개, `supportingEvidence` 에 `comment-483-phase-b` 가 있다
- 새 기준선 리포트에 비교 불가 사실이 적혀 있다
- `index.json` 의 `status` 와 모든 phase `status` 가 `completed` 다

마지막으로 띄운 것을 정리한다. 테스트 컨테이너를 띄웠다면
`docker compose rm -sf <서비스>` 로 지운다. **`docker compose --profile test down` 을 쓰지 마라** —
프로필과 무관하게 compose 프로젝트 전체를 지운다. 실제로 그 명령으로 운영 Neo4j 가 지워졌다.
개발 인스턴스(Neo4j 7687·Postgres 15434)는 유지하고, 무엇을 남기고 무엇을 지웠는지 보고에 적는다.

## 의도 메모 (왜)

- **필수를 보강으로 낮추는 이유** — 구조 관계로 증명한 답을 실패로 판정하면 엔진이 더 나은 경로를
  찾았을 때 벌을 준다. 이 저장소는 gold 3문항을 같은 방식으로 처리하기로 이미 결정한 선례가 있다
- **Phase 03 뒤에 두는 이유** — 엔진 개선과 기준 완화를 한 번에 반영하면 회수 실패가 줄어도
  어느 쪽 덕인지 못 읽는다
- **다른 후보를 직접 고치지 않는 이유** — 무엇을 근거로 인정할지는 코드 판단이 아니라 사람 판단이다

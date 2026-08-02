# Phase 02 — 반복 실행·재개·비교 스크립트를 구현한다

**Execution profile**: standard
**Status**: pending

---

## 목표

현재 `/api/graph/*`와 `/api/query`만 사용해 평가를 직렬 반복하고,
중단 후 재개하며, 결정적 결과와 이전 기준선의 차이를 기계적으로 기록한다.

Phase 01의 `.claude/skills/kg-eval/references/result-contract.md`를 입력·출력 계약으로 사용한다.

**범위 외**

- 새 HTTP 엔드포인트와 `apps/evaluator`
- 의미 판정을 LLM API로 자동 호출하는 기능
- 추출·질의 모델 변경
- 그래프나 원천 데이터 쓰기

---

## 작업 항목 (5)

### 1. `run.mjs`의 실행·재개 계약을 구현한다

명령 계약은 다음과 같다.

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/run.mjs \
  --suite eval/suites/tc-ocr-api-gateway.json \
  --stage plan005-baseline \
  --api-base-url http://localhost:3000 \
  --query-model gpt-5.6-terra \
  --repeats 3 \
  --out eval/runs/plan005-baseline.json
```

- 시작 전에 `validate-suite.mjs`와 `GET /api/graph/stats`를 통과해야 한다.
- 한 실행 안에서는 문항과 회차를 직렬 처리한다. 동시 요청 옵션을 만들지 않는다.
- 세트 내용 해시, 대상 git 커밋, stage, API URL, 호출자가 선언한 모델, 반복 횟수를 기록한다.
- `--out`이 있으면 같은 세트 해시·조건에서 완료된 문항 회차를 건너뛴다.
- 조건이 다른 기존 파일에는 이어 쓰지 않고 종료 코드 1로 거부한다.
- 같은 출력 경로의 잠금 파일이 있으면 두 평가가 섞이지 않도록 거부한다.
- 정상 종료와 실패 종료 모두 잠금 파일을 정리한다.
- Ctrl-C 뒤에도 완료된 회차는 유효한 JSON으로 남아 다음 실행에서 재개할 수 있어야 한다.

### 2. 그래프·검색 경계를 결정적으로 검사한다

문항의 `graphChecks`는 다음 기존 API만 사용한다.

- `/api/graph/samples?label=<Task|Comment>&offset=<n>&limit=100` 페이지를 순회해 기준 노드의 `label`·`key`를 정확히 찾는다.
- `/api/graph/nodes/:id/neighbors?depth=N`으로 필요한 노드와 관계가 존재하는지 검사한다.
- `/api/query` 응답의 evidence 노드 `label`·`key`와 관계 유형을 `requiredEvidence`에 대조한다.

검색 결과의 Neo4j `elementId`는 재적재 시 바뀌므로 gold에 저장하지 않는다.
gold 식별자는 `label`과 도메인 key 조합을 사용한다.
`/api/graph/search`는 fulltext 전용이라 숫자 `Task.number`나 `Comment.commentId` 해석에 쓰지 않는다.
앞 경계가 실패하면 뒤 경계를 `NOT_EVALUATED`로 기록한다.

### 3. `compare.mjs`를 구현한다

두 요약 JSON을 받아 문항별 판정과 축 차이를 출력한다.

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/compare.mjs \
  --baseline eval/reports/2026-07-31-plan005-baseline.json \
  --candidate eval/reports/2026-08-01-candidate.json
```

출력은 `improved`, `regressed`, `unchanged`, `review` 문항 id와 실패 경계 변화를 포함한다.
질문 세트 해시가 다르면 회귀 비교를 거부하고 차이를 설명한다.

### 4. 실행기 테스트를 만든다

`.claude/skills/kg-eval/tests/run.test.mjs`와 `compare.test.mjs`에서 로컬 임시 HTTP 서버를 사용한다.
다음을 검증한다.

- 정확히 문항 수 × 반복 수만큼 직렬 호출
- 사전 점검 실패 시 질의 0회
- 중간 실패 파일에서 완료 회차를 건너뛰고 재개
- 조건 불일치와 잠금 충돌 거부
- elementId가 달라도 `label`·`key` 기준으로 같은 근거 판정
- 세트 해시가 다른 비교 거부와 회귀 분류

### 5. 스킬 통합을 마무리한다

- `.claude/skills/kg-eval-human/`과 `.claude/skills/kg-eval-ai/`를 삭제한다.
- `docs/EVAL-RUBRIC.md`와 저장소 문서에 옛 스킬 이름이 남지 않게 한다.
- `kg-model-bench`의 검색 품질 평가 참조만 `kg-eval`로 바꾼다.
  모델 후보·판정 규칙·기본 모델은 바꾸지 않는다.
- `.gitignore`에 `eval/runs/`를 추가한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/scripts/run.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/compare.mjs` | 신규 |
| `.claude/skills/kg-eval/tests/run.test.mjs` | 신규 |
| `.claude/skills/kg-eval/tests/compare.test.mjs` | 신규 |
| `.claude/skills/kg-eval-human/**` | 삭제 |
| `.claude/skills/kg-eval-ai/**` | 삭제 |
| `.claude/skills/kg-model-bench/SKILL.md` | 참조 이름만 수정 |
| `.gitignore` | `eval/runs/` 추가 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/*.test.mjs
python3 /Users/nhn/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/kg-eval
rg -n --glob '!eval/reports/**' "kg-eval-human|kg-eval-ai|apps/evaluator|eval:kg" .claude docs eval package.json
git diff --check
```

`rg` 결과는 0줄이어야 한다. 과거 평가 리포트는 명령의 glob으로 제외한다.

## 의도 메모 (왜)

- 직렬 실행은 질의 엔진의 비결정성과 실행기의 동시성 영향을 섞지 않기 위한 통제 조건이다.
- elementId를 gold에 넣지 않는 이유는 그래프 재적재 때 식별자가 바뀌기 때문이다.
- 의미 판정을 스크립트가 하지 않는 이유는 문자열 포함 검사가 인과의 옳고 그름을 판정할 수 없기 때문이다.
- 모델 벤치의 동작을 바꾸지 않는 이유는 모델 선택이 이 plan과 다른 관심사이기 때문이다.

## Blocked 조건

- 기존 API 응답이 `packages/shared/src/api/api.schema.ts` 계약과 다르면
  `PHASE_BLOCKED: 현재 API 계약 불일치`를 출력하고 새 엔드포인트를 만들지 않는다.

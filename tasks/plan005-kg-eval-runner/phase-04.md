# Phase 04 — 현재 그래프 기준선을 측정하고 통합 검증한다

**Execution profile**: standard
**Status**: pending

---

## 목표

완성된 `kg-eval` 스킬을 현재 tc-ocr 그래프에 실행해 12문항 × 3회의 재현 가능한 기준선을 만들고,
저장소 테스트와 잔재 검사를 끝낸다.

**범위 외**

- 평가 결과가 낮다는 이유로 질의 엔진·온톨로지·추출기까지 고치기
- 그래프 재적재와 판단 저장소 변경
- 모델 후보 비교와 모델 설정 변경
- 원시 응답과 스크린샷 커밋

---

## 작업 항목 (5)

### 1. 실행 환경을 읽기 전용으로 점검한다

현재 API의 `GET /api/graph/stats`가 응답하고 대상 그래프 건수가 의도한 개발 인스턴스인지 확인한다.
평가 실행기는 API를 자동 기동하지 않는다.

plan 시작 시 확인한 기준은 노드 3,082개, 관계 13,002개, Concept 968개다.
셋 중 하나라도 다르면 다른 그래프를 평가할 수 있으므로 기준선 실행을 멈추고 실제 응답값을 보고한다.

질의 모델 표기는 `.env`의 `QUERY_LLM_MODEL` 값을 읽어 명령에 명시한다.
API 응답이 실제 모델 id를 증명하지 않는다는 한계를 리포트에 남긴다.

### 2. 36회 기준선을 실행한다

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

문항 12개 × 3회인 질의 응답 36개가 있어야 한다.
중단되면 같은 명령으로 재개하고 이미 완료한 회차가 다시 호출되지 않았는지 기록한다.

### 3. 두 독립 의미 판정을 받는다

서로의 결과를 보지 않는 `verifier` 또는 `code-reviewer` 두 lane에 같은 원시 실행 파일과
`eval/suites/tc-ocr-api-gateway.json`, `docs/EVAL-RUBRIC.md`만 제공한다.

각 판정자는 문항·회차별로 다음만 반환한다.

- `expectedClaims` 충족 여부
- `forbiddenClaims` 위반 여부
- 원인·결정·조치·검증 순서의 정확성
- `PASS`, `FAIL`, `REVIEW`와 한 줄 근거

판정자에게 다른 판정자의 결과나 의도한 최종 답을 주지 않는다.
두 결과가 갈리면 평균내지 않고 최종 `REVIEW`로 둔다.

### 4. 기준선 리포트를 만든다

다음 두 파일을 같은 내용 계약으로 만든다.

- `eval/reports/2026-07-31-plan005-baseline.json`
- `eval/reports/2026-07-31-plan005-baseline.md`

리포트에는 실행 조건, 36회 완료 여부, 질문별 경계·축·안정성, 음성 대조 결과,
두 판정자의 일치 여부, `PASS|FAIL|REVIEW` 집계, 다음에 손볼 실패 경계 하나를 기록한다.
원시 답변 전문과 조직 내부 이름은 요약 리포트에 복사하지 않는다.

### 5. 저장소 검증과 완료 마킹을 한다

테스트 컨테이너만 사용해 기존 테스트 수가 줄지 않았음을 확인한다.

```bash
# cwd: 저장소 루트
docker compose --profile test up -d postgres-test
REGISTRY_DATABASE_URL=postgresql://devloop:devloop-test-password@localhost:15435/devloop_registry \
  pnpm --filter pipeline test
pnpm --filter api test:unit
node --test .claude/skills/kg-eval/tests/*.test.mjs
python3 /Users/nhn/.codex/skills/.system/skill-creator/scripts/quick_validate.py .claude/skills/kg-eval
pnpm format:check
git diff --check
```

pipeline 140개, api 51개를 확인하고 pipeline `skipped 0`을 기록한다.
테스트 뒤 `docker compose rm -sf postgres-test`만 사용한다.
`docker compose --profile test down`은 사용하지 않는다.

앱 제품 코드를 바꾸지 않았으므로 dev 서버 재시작이 필요 없음을 보고한다.
`tasks/plan005-kg-eval-runner/index.json`과 모든 phase의 status를 `completed`로 바꾼다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/runs/plan005-baseline.json` | 생성하지만 커밋하지 않음 |
| `eval/reports/2026-07-31-plan005-baseline.json` | 신규 — 기계 판독 요약 |
| `eval/reports/2026-07-31-plan005-baseline.md` | 신규 — 사람이 읽는 기준선 |
| `tasks/plan005-kg-eval-runner/index.json` | 완료 상태로 수정 |
| `tasks/plan005-kg-eval-runner/phase-*.md` | 완료 상태로 수정 |

## 검증

```bash
# cwd: 저장소 루트
jq '.attempts | length' eval/runs/plan005-baseline.json
jq '[.questions[] | select(.finalVerdict == "REVIEW")] | length' eval/reports/2026-07-31-plan005-baseline.json
rg -n --glob '!eval/reports/**' "kg-eval-human|kg-eval-ai|apps/evaluator|eval:kg" .claude docs eval package.json
git status --short
```

첫 `jq` 결과는 36이어야 한다.
`REVIEW` 수는 숨기지 않고 Markdown 리포트와 일치해야 한다.
잔재 `rg` 결과는 0줄이어야 한다. 과거 평가 리포트는 명령의 glob으로 제외한다.
`git status`에는 `eval/runs/`가 나타나지 않아야 한다.

## 의도 메모 (왜)

- 이번 phase는 측정까지가 범위다. 결과를 보고 질의 엔진을 함께 고치면 기준선이 사라진다.
- 독립 판정을 두는 이유는 한 판정자의 해석을 정답처럼 굳히지 않기 위해서다.
- 운영 Neo4j와 개발 Postgres를 바꾸지 않는 이유는 평가가 읽기 전용 품질 게이트이기 때문이다.

## Blocked 조건

- API가 기동하지 않거나 현재 그래프가 기대한 개발 인스턴스인지 확인할 수 없으면
  `PHASE_BLOCKED: 평가 대상 API 또는 그래프 부재`를 출력하고 코드·세트 검증까지만 완료한다.
- 구독 CLI 사용량 제한으로 36회가 끝나지 않으면 완료 회차를 보존하고
  `PHASE_BLOCKED: 질의 모델 사용량 제한`을 출력한다. 반복 수를 줄여 통과시키지 않는다.

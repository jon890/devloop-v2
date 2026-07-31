---
name: kg-eval
description: 지식그래프 검색 품질을 원천 근거 기반 gold 세트로 반복 측정하는 저장소 전용 평가 스킬. 대표 업무 흐름 평가, kg 평가, 지식그래프 품질 게이트, 검색 품질 회귀 확인, human/ai audience 통합 평가, /api/query 반복 실행과 의미 판정 리포트가 필요할 때 사용한다.
---

# kg-eval

원천 Dooray 기록으로 확정한 gold 세트를 검증하고, 같은 문항을 반복 실행해 지식그래프 검색 품질을 축별로 판정한다.
사람형 질문과 AI 에이전트형 질문은 별도 절차로 나누지 않고 `audience=human` 또는 `audience=ai`로 구분한다.

## 절차

1. 사전 점검을 수행한다.
   `references/result-contract.md`를 읽고 평가 세트, 원시 실행 결과, 요약 결과 계약을 확인한다.
   실행 전 `scripts/validate-suite.mjs`로 세트를 검증한다.

   ```bash
   node .claude/skills/kg-eval/scripts/validate-suite.mjs \
     --suite eval/suites/<suite>.json \
     --data-root apps/pipeline/data
   ```

2. 문항별로 같은 조건에서 3회 직렬 실행한다.
   `/api/query` 호출은 문항 단위로 기록하고, 중단되면 이미 성공한 문항·회차를 원시 실행 결과의 `attempts`에서 찾아 이어서 실행한다.

3. 원천, 그래프, 검색, 답변 경계를 분리한다.
   원천 직접 근거가 없는 문항은 `answerability=insufficient-source`로 유지하고 검색 실패 분모에 넣지 않는다.
   그래프에서 만든 정답으로 gold를 고치지 않는다.

4. 결정적 검사와 의미 판정을 분리한다.
   근거 식별자 존재, 필수 근거 회수, 순서, HTTP 상태, 지연 시간은 번들 스크립트나 명시적 확인으로 판정한다.
   원인, 결정, 조치, 검증 의미와 인과 절제는 서로 결과를 보지 않은 두 판정자가 독립적으로 판정한다.

5. 최종 판정을 `PASS`, `FAIL`, `REVIEW` 중 하나로 기록한다.
   3회 판정이 흔들리거나 두 의미 판정이 갈리면 평균내지 않고 `REVIEW`로 보낸다.

6. JSON 요약과 Markdown 리포트를 남기고 이전 기준선과 비교한다.
   비교는 문항별 축 판정과 실패 경계 기준으로 수행한다.

## 경계

- 모델 비교 절차, 후보 모델 목록, 기본 모델 변경은 포함하지 않는다. 해당 관심사는 `kg-model-bench`가 소유한다.
- 원시 실행 결과에는 조직 내부 원문과 응답 전문이 들어갈 수 있으므로 커밋하지 않는다.
- 평가 기준은 `docs/EVAL-RUBRIC.md` 섹션 3을 단일 소스로 사용한다.
- 데이터 구조는 `docs/data-schema.md`의 "평가 gold 의 구조"와 `references/result-contract.md`를 따른다.

## 자원

- `references/result-contract.md`: 평가 세트, 원시 실행 결과, 요약 결과 JSON 계약.
- `scripts/validate-suite.mjs`: 평가 세트가 원천 데이터와 자기 참조 계약을 만족하는지 검증한다.

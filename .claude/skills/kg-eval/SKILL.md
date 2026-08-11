---
name: kg-eval
description: 지식그래프 검색 품질을 원천 근거 기반 gold 세트로 반복 측정하는 저장소 전용 평가 스킬. 대표 업무 흐름 평가, kg 평가, 지식그래프 품질 기준, 검색 품질 회귀 확인, human/ai audience 통합 평가, /api/query 반복 실행과 의미 판정 리포트가 필요할 때 사용한다.
---

# kg-eval

원천 Dooray 기록으로 확정한 gold 세트를 검증하고, 같은 문항을 반복 실행해 지식그래프 검색 품질을 축별로 판정한다.
사람형 질문과 AI 에이전트형 질문은 별도 절차로 나누지 않고 `audience=human` 또는 `audience=ai`로 구분한다.

## 절차

1. 사전 점검을 수행한다.
   `references/result-contract.md`를 읽고 평가 세트, 원시 실행 결과, 요약 결과 계약을 확인한다.
   HTTP 질문 평가는 실행 전 `scripts/validate-suite.mjs`로 세트를 검증한다.

   ```bash
   node .claude/skills/kg-eval/scripts/validate-suite.mjs \
     --suite eval/suites/<suite>.json \
     --data-root apps/pipeline/data
   ```

   Coding Agent Memory 평가는 공개 suite와 private source lock을 분리한다.
   공개 suite는 커밋할 수 있지만 source lock은 내부 URL, 절대 repository path, revision, prompt, oracle query를 포함하므로 커밋하지 않는다.

   ```bash
   node .claude/skills/kg-eval/scripts/validate-memory-suite.mjs \
     --suite eval/suites/<suite>.json \
     --source-lock <private-source-lock>.json
   ```

   Memory 검증 CLI의 stdout은 private 값을 포함하지 않는 한 줄 JSON만 허용한다.

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
- Memory 평가는 원천 Git 저장소에 checkout, fetch, reset, clean, worktree 명령을 실행하지 않는다.
  원천 저장소는 `git archive <baseRevision>`의 읽기 대상으로만 사용하고, 평가 작업공간은 `eval/runs/workspaces/` 아래 새 로컬 Git 저장소로 만든다.

## 자원

- `references/result-contract.md`: 평가 세트, 원시 실행 결과, 요약 결과 JSON 계약.
- `scripts/validate-suite.mjs`: 평가 세트가 원천 데이터와 자기 참조 계약을 만족하는지 검증한다.
- `scripts/run.mjs`: 평가 세트를 직렬 반복 실행하고, 조건이 같은 기존 원시 결과에서 완료 회차를 건너뛰어 재개한다.
- `scripts/compare.mjs`: 요약 JSON 두 개를 **문항 id 교집합**으로 비교한다. 세트가 자라도 비교선이 끊기지 않고, 추가·삭제 문항과 gold 가 바뀐 문항을 따로 나열한다.
- `tests/*.test.mjs`: 세트 검증, 실행·재개·잠금·중단 저장, 비교 분류 계약을 검증한다.
- `scripts/validate-memory-suite.mjs`: Memory 공개 suite와 private source lock을 함께 검증하고 canonical hash를 출력한다.
- `scripts/memory/*.mjs`: Memory suite·source lock 검증, archive workspace, raw result 저장, pure judge 계약을 담당한다.

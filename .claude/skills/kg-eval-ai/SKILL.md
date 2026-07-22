---
name: kg-eval-ai
description: 지식그래프 검색 품질을 "AI 에이전트형 정형 질의"(명시적 개체·관계, multi-hop, 집계, 근거 id 요구)로 채점하는 평가 스킬. stage commit·phase 병합 직후, 질의 엔진·스키마 변경 뒤, 또는 "kg ai 평가", "ai eval", "정형 질의 품질", "에이전트 질의 평가", "품질 게이트" 언급 시 반드시 사용. 채점표·통과선은 docs/EVAL-RUBRIC.md 가 단일 소스. 사람형 질문 평가는 kg-eval-human, 모델별 비용 비교는 kg-model-bench 를 사용.
---

# kg-eval-ai — AI 에이전트형 질의 품질 평가

미래의 소비자인 AI 에이전트가 묻는 방식(EVAL-RUBRIC 섹션 2의 A1~A5 패턴)으로 채점한다.
정형 질의는 anchor 모호성이 없으므로 낮은 점수는 곧 그래프·질의 엔진의 결함이다 — 통과선이 human 보다 높다.

## 전제

kg-eval-human 과 동일 (Neo4j + api 기동, 프로젝트 지정).
질문 은행: `eval/questions-ai-<project>.json` — 없으면 EVAL-RUBRIC 섹션 6으로 부트스트랩.

## 절차

kg-eval-human 의 절차와 같되, 다음이 다르다:

1. 정적 점검은 kg-eval-human 과 같은 커밋에서 이미 돌렸으면 결과를 재사용한다 (중복 실행 불필요).
2. **ground truth 대조** — 질문에 `groundTruthCypher` 가 있으면(집계·목록형) 그 쿼리를 직접 실행한 결과와 답변을 대조한다.
   불일치 항목은 R(재현율) 감점이 아니라 G(그래프 정합) 0점으로 처리한다 — 정형 질의에서 집계가 틀리면 경로 해석 자체가 잘못된 것이다.
3. **근거 id 검사** — A4 패턴 질문은 응답 evidence 의 노드 id 가 실제 그래프에 존재하는지 표본 확인한다 (P 축).
4. 리포트: `eval/reports/<YYYY-MM-DD>-ai-<stage>.md`, 판정은 EVAL-RUBRIC 섹션 4의 ai 통과선.

## 주의

- 체이닝 패턴(A5)은 두 번의 /api/query 호출로 진행한다 — 1차 답의 노드를 2차 질문에 명시적으로 넣는다.
  1차가 fail 이면 2차는 채점하지 않고 "선행 실패"로 기록한다.
- 질의문을 Cypher 로 직접 쓰지 않는다 — 평가 대상은 자연어→그래프 질의 엔진이다.

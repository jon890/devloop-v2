---
name: kg-eval-human
description: 지식그래프 검색 품질을 "사람형 질문"(모호한 지칭·별칭·상대 시간)으로 채점하는 평가 스킬. stage commit·phase 병합 직후, 추출 프롬프트·사전·질의 엔진을 바꾼 뒤, 또는 "kg 평가", "지식그래프 품질 평가", "human eval", "검색 품질 점수", "품질 게이트" 언급 시 반드시 사용. 채점표·통과선은 docs/EVAL-RUBRIC.md 가 단일 소스. AI 정형 질의 평가는 kg-eval-ai, 모델별 비용 비교는 kg-model-bench 를 사용.
---

# kg-eval-human — 사람형 질문 검색 품질 평가

사람이 실제로 묻는 방식(EVAL-RUBRIC 섹션 2의 H1~H5 패턴)으로 지식그래프 질의응답을 채점한다.

## 전제

- Neo4j(docker compose)와 apps/api 가 떠 있어야 한다. `GET /api/graph/stats` 가 응답하면 준비 완료.
- 평가 대상 프로젝트를 정한다 (기본 tc-ocr).
- 질문 은행: `eval/questions-human-<project>.json`.
  없으면 EVAL-RUBRIC 섹션 6(gold set 부트스트랩)을 먼저 수행해 만든다.

## 절차

1. **정적 점검** — `eval/static-checks.cypher` 의 쿼리를 실행하고 EVAL-RUBRIC 섹션 1 통과선과 비교한다.
   S1(스키마 정합)·S6(근거 추적) 위반이 있으면 동적 평가 전에 먼저 보고한다.
2. **질의 실행** — 질문 은행의 각 질문을 `POST /api/query` 로 보낸다 (curl, `{"question": "..."}`).
   응답의 answer·evidence·cypher 를 질문 id 별로 기록한다.
3. **채점** — EVAL-RUBRIC 섹션 3 채점표(A 앵커 2 / R 재현율 3 / P 무환각 2 / G 그래프 정합 2 / U 유용성 1)로 질문당 10점 채점.
    - 순서 중요: 답변 텍스트만 보고 A·R·P·U 를 먼저 채점한 뒤, G 는 답의 핵심 연결 주장을 Cypher 로 직접 재현해 검증한다 (거꾸로 하면 그래프에 맞춰 후하게 채점하는 편향이 생긴다).
    - P 위반(존재하지 않는 업무·문서·사람 인용)은 해당 질문 0점 + fail 집계.
    - gold 는 원본 Dooray 데이터 기준이다 — 그래프에 없다고 gold 를 고치지 않는다 (그건 추출 결함 발견이다).
4. **리포트** — `eval/reports/<YYYY-MM-DD>-human-<stage>.md` 에 기록:
   질문별 점수표, 세트 점수(%), fail 목록, 실패 원인 분류(EVAL-RUBRIC 섹션 5의 4개 축).
5. **판정** — EVAL-RUBRIC 섹션 4 통과선과 비교해 PASS / FAIL 을 선언한다.
   FAIL 이면 최다 원인 축 1개에 대한 구체적 수정 제안을 함께 출력한다 (한 번에 한 축만 수정).

## 주의

- 같은 stage 에서 재평가할 때는 질문 은행을 바꾸지 않는다 — 점수 추이 비교가 깨진다.
  질문 추가는 stage 경계에서만 하고 리포트에 명시한다.
- 세트 점수와 별개로 질문별 점수를 반드시 남긴다 — 개선 루프의 원인 분류가 질문 단위로 이뤄진다.

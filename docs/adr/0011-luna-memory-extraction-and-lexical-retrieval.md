# ADR 0011 — Memory 추출은 Luna로 고정하고 검색은 lexical로 시작한다

- 상태: 채택
- 결정일: 2026-08-11

## 맥락

Experience 추출은 원문 의미를 압축해야 하므로 LLM이 필요하다.
반면 생성된 Memory는 짧고 제목, scope, 관련 검색어가 있어 기본 검색에 LLM이 필수는 아니다.

사용 가능한 token 예산이 제한돼 있다.
모델이나 reasoning effort가 환경에 따라 바뀌면 cache와 측정 조건도 달라진다.

## 결정

Experience 추출 모델은 `gpt-5.6-luna`, reasoning effort는 `low`로 고정한다.
환경변수나 호출 옵션으로 다른 모델을 선택하지 못하게 하고 Luna를 사용할 수 없으면 실패한다.

첫 retrieval은 JSON index의 lexical ranking으로 구현한다.
검색 경로에서 LLM, Neo4j, Postgres를 호출하지 않는다.

## 이유

- 작은 모델과 고정된 effort로 token 사용량과 cache identity를 예측할 수 있다.
- fallback을 막아 더 비싼 모델이 조용히 호출되는 문제를 예방한다.
- lexical 기준선은 추가 service와 dependency 없이 Retrieval Tax를 가장 작게 측정한다.
- embedding이나 query expansion은 기준선 실패가 확인된 query에만 검토할 수 있다.

## 검토한 대안

| 대안 | 기각 이유 |
| --- | --- |
| 기존 `LLM_MODEL` 재사용 | Graph 추출 설정 변경이 Memory cache와 비용을 함께 바꾼다 |
| 질의마다 Luna query expansion | agent-triggered 검색의 token과 turn 비용을 먼저 키운다 |
| SQLite FTS 또는 vector DB 선도입 | 현재 규모와 lexical 실패 경계가 아직 측정되지 않았다 |

## 결과

Memory 추출은 Codex 구독 계정 전송에 의존한다.
Luna 장애 시 다른 모델로 계속 처리할 수 없고 명시적으로 중단된다.
lexical 검색이 의미가 다른 표현을 놓칠 수 있으므로 평가 report에 실패 query를 남기고 다음 검색 기술의 도입 근거로 사용한다.

## 관련

- ADR 0002 — 구독 계정 LLM만 사용한다
- ADR 0003 — 설정 누락을 즉시 실패로 드러낸다
- ADR 0009 — Responses 직접 전송이 기본이다

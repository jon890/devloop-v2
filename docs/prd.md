# PRD — Coding Agent Experience Memory

- 상태: plan012 구현 완료, pilot 검증 완료
- 기준일: 2026-08-11
- 이전 기준선: 업무 지식그래프 GraphRAG

이 문서는 제품 목표, 사용자 가치, 범위와 제외 범위를 소유한다.
구현 방식은 `docs/code-architecture.md`, 데이터 계약은 `docs/data-schema.md`가 소유한다.
현재 GraphRAG는 새 구조의 비교군으로 유지한다.

## 문제

Coding Agent는 현재 source, symbol, git history를 직접 탐색할 수 있다.
그러나 다음 정보는 현재 코드만 읽어서 안정적으로 복원할 수 없다.

- 설계를 선택한 이유와 버린 대안
- 운영 장애 때문에 생긴 제약
- 실패한 migration과 실험 결과
- deprecated 코드를 아직 제거하지 못한 이유
- 당시 검증한 범위와 남은 불확실성

이 정보는 Dooray 업무·댓글·Wiki와 Git commit·diff·ADR·회고에 흩어져 있다.
현재 GraphRAG는 이를 관계형 질문으로 찾지만, 문서 추출에 LLM 537회가 필요하고 질문 한 건에도 LLM을 3-5회 호출한다.
Coding Agent가 source와 그래프를 중복 탐색하면 전체 처리 시간과 context가 늘어난다.

## 목표

Dooray와 Git에 남은 코드 밖의 경험을 짧은 Memory로 만들고, Coding Agent가 필요할 때 한 번의 검색으로 결론과 근거 링크를 받게 한다.

핵심 가치는 다음과 같다.

- 잘못된 변경과 재작업 감소
- 과거 맥락을 찾는 source 탐색 감소
- active와 superseded 판단의 구분
- 원문으로 즉시 내려갈 수 있는 provenance
- Memory 이득과 조회 비용을 분리한 전체 효용 측정

## 사용자와 가치

주 사용자는 `/Users/nhn/projects/OCR`의 여러 저장소를 수정하는 Claude Code와 Codex다.
사람은 Memory 생성과 근거 확인, status 교정을 운영한다.

| 상황 | Memory 없이 | Experience Memory 사용 |
| --- | --- | --- |
| legacy 동작 변경 | 코드와 git log를 반복 탐색 | 관련 제약과 원문 commit을 한 번에 확인 |
| 운영 설정 변경 | 과거 장애를 놓칠 수 있음 | incident와 금지 사항을 먼저 확인 |
| migration 계획 | 실패 이력을 수동으로 재구성 | failed attempt와 lesson을 함께 확인 |
| 의사결정 검증 | Dooray 업무와 댓글을 각각 열람 | 현재 상태, 이유, 원문 link를 함께 확인 |

## 지식 원천

세 원천을 모두 사용한다.

- Dooray 업무와 댓글
- Dooray Wiki
- `/Users/nhn/projects/OCR` 아래 Git 저장소의 기본 branch commit·diff와 경험 문서

원천은 읽기 전용이다.
Memory는 원문을 복제하지 않고 안정적인 원천 ID와 원문 URL을 보존한다.

## 범위

### 포함

- 세 원천을 공통 evidence packet으로 정규화
- Decision, Constraint, Incident, Failed Attempt, Lesson 추출
- `gpt-5.6-luna`를 사용한 증분·캐시 가능 추출
- status, confidence, scope, provenance 검증
- compact Markdown 문서와 JSON 검색 index 생성
- LLM과 Neo4j를 호출하지 않는 lexical 검색 기준선
- Coding Agent가 호출할 단일 `memory-search` CLI
- no-memory, agent-triggered, oracle-memory, automatic 조건 비교 설계
- Retrieval Tax, Memory Benefit, Net Memory Utility 측정

### 제외

| 제외 항목 | 이유 |
| --- | --- |
| class hierarchy, symbol 위치, caller와 callee 장기 저장 | Coding Agent가 현재 source에서 더 정확하게 재구성한다 |
| Neo4j 제거 | Graph의 추가 가치가 실측으로 부정되기 전에는 비교군으로 유지한다 |
| vector DB 선도입 | lexical 기준선의 실패가 확인되지 않았다 |
| 자동 retrieval 기본화 | 불필요한 조회 비용과 context 오염을 먼저 측정해야 한다 |
| 원천 저장소 변경 | 지식 수집은 읽기 전용이어야 한다 |
| 멀티유저 서비스와 신규 UI | 첫 목표는 로컬 Coding Agent의 전체 효용 검증이다 |

## 확정된 설계 판단

| 판단 | 이유 |
| --- | --- |
| Experience Memory를 기존 GraphRAG와 병렬로 둔다 | sunk cost와 가설을 모두 검증할 수 있다 |
| 계층형 파일 저장과 단일 검색 표면을 사용한다 | Agent의 여러 단계 탐색 호출을 막는다 |
| 검색은 lexical 기준선부터 시작한다 | 새 서비스와 embedding 비용 없이 효과를 측정할 수 있다 |
| 추출 모델을 `gpt-5.6-luna`로 고정한다 | 제한된 토큰 예산에서 모델 변경으로 인한 비용 변동을 막는다 |
| 원문 ID와 URL을 함께 저장한다 | 링크 변경에 견디면서도 사람이 바로 검증할 수 있다 |
| 현재 코드 사실은 Memory에서 제외한다 | 오래된 Memory가 source보다 우선하는 문제를 막는다 |

## 성공 기준

첫 수직 구현은 다음을 모두 만족해야 한다.

- 세 원천이 manifest에 포함되고 Dooray content hash와 Git revision이 고정된다.
- 모든 Memory가 하나 이상의 검증된 `sourceRef`와 원문 URL을 가진다.
- Memory 추출 LLM 호출은 전부 `gpt-5.6-luna`이며 다른 모델은 호출 전에 거부된다.
- 같은 evidence와 설정은 LLM 재호출 없이 같은 Markdown과 JSON index를 만든다.
- `memory-search` 한 번으로 상위 결과와 원문 link를 JSON으로 받는다.
- 검색 경로는 LLM, Neo4j, Postgres 없이 동작한다.
- no-memory 기준값과 비교할 task success, 잘못된 수정, 전체 처리 시간, 도구 호출 수를 기록할 수 있다.
- Retrieval Tax와 Memory Benefit을 별도 지표로 보고한다.

새 방향의 채택은 Memory 검색 정확도만으로 판정하지 않는다.
Coding Agent의 task success가 나빠지지 않고 잘못된 수정이나 재탐색이 줄며, 그 이득이 조회 비용보다 커야 한다.

## 열려 있는 것

- lexical 검색이 부족해지는 query 유형
- Graph traversal이 여전히 이득인 Coding Agent task
- status와 중복 Memory를 사람이 교정할 최소 curation 표면
- 자율적인 Memory trigger의 precision과 recall
- 전체 Git 이력 추출이 주는 추가 가치와 LLM 호출량의 균형

이 항목은 구현을 미리 확정하지 않고 사전 조사와 비교 평가로 판단한다.

## 최신 pilot 상태

2026-08-11 수직 검증에서 최신 Dooray raw와 OCR Git 9개 저장소를 source manifest로 고정했다.
`gpt-5.6-luna` bounded 추출은 `--sample-per-source 3` 기준 최종 재실행에서 calls 0, cacheHits 12를 기록했다.
부분 추출이므로 Wiki index는 `complete=false`이며, task utility 판정은 후속 평가가 소유한다.

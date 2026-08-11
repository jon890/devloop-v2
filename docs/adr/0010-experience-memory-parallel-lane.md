# ADR 0010 — Experience Memory를 GraphRAG와 병렬로 둔다

- 상태: 채택
- 결정일: 2026-08-11

## 맥락

현재 GraphRAG는 Dooray 문서를 고정 ontology와 Neo4j graph로 바꾸고 질문마다 여러 LLM 호출로 탐색한다.
관계형 질문과 graph 학습에는 가치가 있지만, Coding Agent는 현재 source와 git history를 직접 탐색할 수 있다.

Coding Agent가 더 필요로 하는 것은 코드에서 재구성하기 어려운 결정 이유, 운영 제약, incident, failed attempt다.
이 정보까지 graph traversal로 제공하면 Memory와 source를 중복 탐색하는 비용이 생긴다.

## 결정

Dooray 업무·댓글·Wiki와 OCR Git 저장소에서 Experience Memory를 만드는 별도 파일 pipeline을 둔다.
Memory는 compact Markdown과 JSON index로 제공하고 Coding Agent에는 단일 lexical 검색 표면만 노출한다.

기존 GraphRAG와 Neo4j는 제거하지 않고 비교군과 관계형 질문 경로로 유지한다.

## 이유

- 계층형 저장을 유지하면서도 Agent의 여러 단계 tool call을 피할 수 있다.
- 현재 코드 사실을 Memory에 복제하지 않아 stale knowledge 위험을 줄인다.
- 같은 task에서 GraphRAG와 shallow retrieval의 전체 효용을 비교할 수 있다.
- 생성 파일이라 원천과 schema가 같으면 언제든 다시 만들 수 있다.

## 검토한 대안

| 대안 | 기각 이유 |
| --- | --- |
| 기존 ontology에 Experience 유형 추가 | Graph traversal과 Neo4j 의존을 그대로 두어 retrieval 비용 가설을 검증할 수 없다 |
| GraphRAG 즉시 제거 | 관계형 use case의 추가 가치를 측정하지 않은 상태다 |
| vector DB 중심 재작성 | lexical 기준선의 실패가 확인되지 않았다 |

## 결과

두 지식 경로가 한동안 공존한다.
새 Memory는 기존 graph 산출물을 입력으로 사용하지 않으므로 추출과 평가 비용이 추가된다.
대신 Graph 제거 여부를 추측이 아니라 end-to-end utility로 판단할 수 있다.

## 관련

- `docs/prd.md`
- `docs/flow.md`
- `docs/code-architecture.md`
- `docs/data-schema.md`
- ADR 0001 — 고정 ontology 결정은 GraphRAG 경로에 계속 적용된다

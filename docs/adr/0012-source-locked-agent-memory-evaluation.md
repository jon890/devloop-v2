# ADR 0012 — Coding Agent Memory를 source-locked 반복 실행으로 평가한다

- 상태: 채택
- 결정일: 2026-08-12

## 맥락

Memory 검색 relevance만으로는 Coding Agent가 더 올바른 변경을 하는지 알 수 없다.
Agent 실행은 비결정적이고 내부 원천과 실제 repository revision을 공개 저장소에 복제할 수도 없다.

## 결정

기존 `kg-eval`의 반복, 재개, suite hash 관례를 Coding Agent 변경 task로 확장한다.
공개 suite와 ignored private source lock을 분리하고, 같은 task와 revision을 no-memory, agent-triggered, oracle-memory 조건에서 반복한다.

task success와 wrong edit를 우선 판정하고 Retrieval Tax와 Memory Benefit은 별도로 보고한다.
Graph, 대체 retrieval, automatic retrieval은 같은 lock을 사용하는 격리된 조건으로만 비교한다.

## 이유

- 원천과 Agent 전문을 공개하지 않고도 같은 snapshot과 조건을 검증할 수 있다.
- 실패를 source, retrieval, agent decision, implementation, validation 경계로 나눌 수 있다.
- Graph 제거와 vector DB 도입을 측정 전에 결론내리지 않는다.
- 같은 실행기를 재사용해 조건별 계측 차이를 줄인다.

## 검토한 대안

| 대안 | 기각 이유 |
| --- | --- |
| 검색 relevance만 측정 | 전체 task 성공과 context 오염을 보지 못한다 |
| task마다 수동 기록 | revision과 metric이 달라져 조건 비교가 깨진다 |
| 내부 원문과 run 전체 커밋 | 공개 저장소의 비공개 경계를 위반한다 |
| automatic retrieval부터 배포 | voluntary 기준선 없이 비용과 miss 회수를 구분할 수 없다 |

## 결과

평가에는 Agent 반복 실행 비용이 들며 token usage가 제공되지 않는 Agent는 `null`로 남는다.
Spike가 이겨도 production 변경은 자동으로 일어나지 않고 별도 결정이 필요하다.

## 관련

- ADR 0006 — 평가 실행기를 저장소 전용 skill에 둔다
- ADR 0010 — GraphRAG를 비교군으로 유지한다
- ADR 0011 — Memory 추출과 lexical 기준선

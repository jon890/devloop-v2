# 노인 돌봄 Graph RAG 에이전트 기술 스택 심층 조사

> 조사 기준일: 2026-08-03
>
> 대상: 운영 서비스를 전제로 한 Spring Boot·LangGraph4j와 NestJS·LangGraph.js 비교
>
> 현재 업무 경계: 이상 징후와 근거 설명, 의료진·돌봄 담당자 확인 권고, 승인 후 돌봄 일정 변경 API 호출

## 결론

현재 조건에서는 **Spring Boot와 Gradle 멀티 모듈을 제품의 중심으로 유지하고, LangGraph4j `1.8.21`을 제한적으로 검증한 뒤 채택**하는 방안이 가장 현실적이다.

다만 이는 LangGraph4j에 승인 업무 전체를 맡긴다는 의미가 아니다.

- LangGraph4j는 근거 수집, 설명 생성, 승인 대기 지점까지의 **추론 흐름**만 담당한다.
- 승인 요청, 권한 확인, 일정 변경 명령, 중복 방지, 감사 기록은 Spring과 PostgreSQL이 담당한다.
- 1~2주 기술 검증에서 재시작·다중 인스턴스 재개·병렬 실패·관찰성 기준을 통과하지 못하면 에이전트 실행부만 **NestJS와 LangGraph.js로 분리**한다.

처음부터 프레임워크 내구 실행, 세밀한 재시도, 병렬 실패 복구, LangSmith 운영 도구를 적극 활용해야 한다면 LangGraph.js가 더 안전한 선택이다.
그러나 현재 MVP는 Java 숙련도와 기존 Spring 운영 역량이 개발 속도와 장애 대응에 더 큰 영향을 준다.

## 판정 요약

| 판단 항목 | LangGraph4j `1.8.21` | LangGraph.js `1.4.8` | 현재 상황의 판단 |
| --- | --- | --- | --- |
| 팀 적합성 | Java 17+, Spring AI 모듈 제공 | Node 18+, NestJS 서비스 필요 | LangGraph4j 우세 |
| 프로젝트 지위 | LangGraph에서 영감을 받은 커뮤니티 구현 | LangChain의 공식 JavaScript 구현 | LangGraph.js 우세 |
| 승인 대기와 재개 | 체크포인트, 중단 전 지점, 상태 갱신, 재개 지원 | 임의 지점 `interrupt()`, 영속 재개 지원 | 모두 가능하나 JS가 더 명시적 |
| 노드 재시도와 시간 제한 | 그래프 수준의 일급 정책이 안정판에 없음 | 노드별 재시도·시간 제한·오류 처리 제공 | LangGraph.js 우세 |
| 병렬 실패 복구 | 제한된 포크-조인, 성공한 형제 작업의 보존 계약이 약함 | 성공한 형제 작업의 보류 쓰기를 보존 | LangGraph.js 우세 |
| 체크포인트 계보 | 재개에는 사용 가능하나 불변 분기 계보가 약함 | 재생과 분기 시 원래 이력을 유지 | LangGraph.js 우세 |
| 관찰성 | OpenTelemetry 모듈이 있으나 실험·도구 성격 | LangSmith와 OpenTelemetry 경로가 성숙 | LangGraph.js 우세 |
| 배포 단순성 | 기존 Spring 애플리케이션에 포함 가능 | 별도 Node 서비스 또는 별도 운영 계층 필요 | LangGraph4j 우세 |
| 유지보수 위험 | 활동은 활발하지만 핵심 기여자 집중도가 높음 | 기여자와 생태계가 더 분산됨 | LangGraph.js 우세 |
| 전환 비용 | 프레임워크 경계를 두면 제한 가능 | Java 서비스와 API 경계가 추가됨 | 초기에는 LangGraph4j 우세 |

버전과 프로젝트 상태는 [LangGraph4j 릴리스](https://github.com/langgraph4j/langgraph4j/releases/tag/v1.8.21), [LangGraph4j 저장소](https://github.com/langgraph4j/langgraph4j), [LangGraph.js 저장소](https://github.com/langchain-ai/langgraphjs), [npm 패키지 정보](https://www.npmjs.com/package/@langchain/langgraph)에서 확인했다.
LangGraph4j `1.9.0-beta1`은 프리릴리스이므로 본 판정의 운영 기준에서 제외했다.

## 권장 기술 스택

### 애플리케이션

- Java 21 LTS
- Spring Boot 3.x
- Gradle 멀티 모듈
- Spring AI
- LangGraph4j `1.8.21`
- PostgreSQL
- TimescaleDB 확장
- Neo4j
- OpenTelemetry
- Testcontainers

Java 17이 LangGraph4j의 최소 기준이지만 신규 운영 서비스라면 Java 21 LTS를 권장한다.
Spring AI는 Neo4j 벡터 저장소 자동 설정과 모델·도구 호출 관찰성을 제공한다.
구체적인 Spring Boot와 Spring AI 버전은 사용하는 모델 공급자 및 LangGraph4j 호환성 검증 후 잠가야 한다.

### 모델과 검색 계층

모델 공급자는 지금 고정하지 않는 편이 낫다.
건강 정보의 처리 지역, 공급자 학습 사용 여부, 보존 정책, 계약상 삭제 조건이 먼저 정해져야 하기 때문이다.

MVP에서는 Spring AI의 `ChatClient`와 구조화 출력 경계 뒤에 모델을 두고 다음 평가를 통과한 모델을 선택한다.

- 한국어 돌봄 기록의 의미 보존
- 제공된 근거만으로 설명하는 충실도
- 근거가 부족할 때 답변을 보류하는 비율
- 의료적 진단·처방 표현의 차단률
- 구조화 출력의 스키마 준수율
- 지연 시간과 호출 비용
- 데이터 보존·학습 제외·처리 지역 요건

임베딩 모델도 한국어와 의료 용어가 섞인 자체 평가 자료로 선택한다.
일반 벤치마크 점수만으로 결정하지 않고, 온톨로지 관계 검색과 문서 검색의 재현율을 따로 측정한다.
재정렬 모델은 초기 검색의 오탐이 운영 목표를 넘을 때만 추가한다.

프롬프트는 코드 안의 긴 문자열이 아니라 버전이 있는 정책 자산으로 관리한다.
모델, 프롬프트, 검색 설정, 온톨로지 개정판의 조합을 모든 결과에 남겨야 재현과 회귀 평가가 가능하다.

### 저장소 역할

| 저장소 | 보관 대상 | 보관하지 않을 대상 |
| --- | --- | --- |
| PostgreSQL | 사용자·돌봄 운영 데이터, 승인 요청, 일정 변경 명령, 감사 원장, 아웃박스 | 대량 원시 센서 표본 전체의 장기 분석 |
| TimescaleDB | 원시 센서 시계열, 시간 구간 집계, 보존 정책 | 온톨로지 관계와 에이전트 실행 상태 |
| Neo4j | 의료 지식 온톨로지, 사용자·돌봄 관계, 근거 연결, 문서 출처와 개정 정보 | 고빈도 원시 센서 데이터, 승인 업무의 유일한 진실 원천 |
| 체크포인트 저장소 | 에이전트 실행 재개에 필요한 상태 | 법적·업무적 감사의 유일한 원장 |

TimescaleDB의 연속 집계와 보존 정책은 원시 센서와 장기 요약을 함께 운영하기에 적합하다.
근거는 [연속 집계](https://docs.timescale.com/use-timescale/latest/continuous-aggregates/about-continuous-aggregates/)와 [데이터 보존 정책](https://docs.timescale.com/use-timescale/latest/data-retention/data-retention-with-continuous-aggregates/) 문서에서 확인할 수 있다.

Neo4j 벡터 인덱스는 근사 최근접 이웃 검색이며, 속성 필터와 전체 텍스트 검색을 조합할 수 있다.
따라서 Graph RAG는 벡터 검색 하나가 아니라 다음 조회를 결합해야 한다.

- 환자의 기간별 센서 집계
- 허용된 관계를 따라가는 온톨로지 조회
- 출처·개정일·적용 대상이 확인된 전문 문서 검색
- 사용자별 돌봄 기록 검색

관련 기능은 [Neo4j 벡터 인덱스](https://neo4j.com/docs/cypher-manual/current/indexes/semantic-indexes/vector-indexes/)와 [Spring AI Neo4j VectorStore](https://docs.spring.io/spring-ai/reference/api/vectordbs/neo4j.html)에서 확인할 수 있다.

## 권장 실행 구조

```text
센서 수집
  -> 시계열 저장·품질 검사
  -> 규칙·통계 기반 이상 후보 생성
  -> Graph RAG 근거 조회
  -> 에이전트가 이상 징후와 근거를 설명
  -> 돌봄 담당자 또는 관리자 승인 요청
  -> 승인 정책과 권한 재검증
  -> 일정 변경 명령 생성
  -> 내부 API 호출
  -> 결과와 근거를 감사 원장에 기록
```

LLM은 이상 여부의 최초 판정기나 진단기가 되어서는 안 된다.
센서 품질 검사, 개인 기준선, 임계치, 통계 모델이 이상 후보를 만들고 에이전트는 그 후보를 검토할 근거와 설명을 구성한다.

FHIR의 `Observation`도 활력 징후와 기기 측정 같은 관찰값을 다루며 임상 진단 자체와 구분한다.
이 경계는 [FHIR Observation](https://www.hl7.org/fhir/observation.html)에 부합한다.

### 일정 변경의 안전 경계

일정 변경 도구를 LLM이 자유롭게 호출하게 두지 않는다.

1. 에이전트는 `ScheduleChangeProposal`만 만든다.
2. 업무 계층이 제안 내용을 고정하고 `ApprovalRequest`를 생성한다.
3. 담당자 또는 관리자가 승인한다.
4. 승인 시점에 대상, 권한, 일정 충돌, 제안 만료를 다시 검사한다.
5. `ScheduleChangeCommand`를 중복 방지 키와 함께 발행한다.
6. 일정 API 어댑터는 허용된 동작만 호출한다.
7. 요청·응답·승인자·근거 묶음을 감사 원장에 기록한다.

이는 생성형 AI에 최소 권한과 최소 자율성을 부여하고 영향이 큰 작업에 사람 승인을 두라는 [OWASP Excessive Agency 지침](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)과 일치한다.

## LangGraph4j로 가능한 범위

안정판 `1.8.21`은 다음 MVP 기능을 구현할 기반을 갖고 있다.

- 상태 그래프와 순환 실행
- 비동기 실행과 스트리밍
- 서브그래프
- 체크포인트 저장
- 실행 중단 전 지점 설정
- 상태 갱신과 재개
- Spring AI 및 LangChain4j 통합
- PostgreSQL, Redis, DynamoDB 등 여러 체크포인트 저장기
- OpenTelemetry 연결용 모듈

승인 대기 예제는 `interruptBefore`, `updateState`, `GraphInput.resume()` 조합을 사용한다.
관련 공식 예제는 [사용자 입력 대기](https://raw.githubusercontent.com/langgraph4j/langgraph4j/main/how-tos/wait-user-input.ipynb)와 [시간 되감기](https://raw.githubusercontent.com/langgraph4j/langgraph4j/main/how-tos/time-travel.ipynb)에서 확인할 수 있다.

따라서 “설명 생성 후 승인 대기, 승인 결과를 넣어 재개”라는 MVP 흐름 자체는 구현할 수 있다.
문제는 기능의 존재가 아니라 운영 장애 시 의미가 충분히 강한지이다.

## LangGraph4j의 운영 한계

### 확인된 사실

#### 그래프 수준 재시도 정책이 약하다

안정판의 `StateGraph.addNode`에는 LangGraph.js처럼 노드별 `RetryPolicy`, 시도별 시간 제한, 재시도 종료 후 오류 분기 정책이 일급 설정으로 드러나지 않는다.
모델 호출 라이브러리의 재시도와 그래프 노드의 재시도는 서로 다른 문제다.

따라서 다음 요소를 애플리케이션에서 구현해야 한다.

- 재시도 가능한 오류 분류
- 지수 백오프
- 전체 시간 제한
- 중복 실행에 안전한 도구 호출
- 실패 큐와 운영자 재처리
- 보상 동작

LangGraph.js `1.4.x`는 노드별 재시도, 시도별 시간 제한, 오류 처리, 정상 종료, 보상 흐름을 공식 [장애 허용 문서](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)에서 제공한다.

#### 체크포인트의 업무 감사 능력이 부족하다

안정판 `Checkpoint`는 실행 ID, 상태, 현재 노드, 다음 노드 중심이다.
`BaseCheckpointSaver`의 계약도 목록, 조회, 저장, 해제 중심이며 승인자, 정책 버전, 도구 요청, 근거 문서의 불변 묶음을 표현하지 않는다.

- [BaseCheckpointSaver.java](https://github.com/langgraph4j/langgraph4j/blob/v1.8.21/langgraph4j-core/src/main/java/org/bsc/langgraph4j/checkpoint/BaseCheckpointSaver.java)
- [Checkpoint.java](https://github.com/langgraph4j/langgraph4j/blob/v1.8.21/langgraph4j-core/src/main/java/org/bsc/langgraph4j/checkpoint/Checkpoint.java)

그러므로 체크포인트는 재개 장치일 뿐 감사 원장으로 사용하면 안 된다.
FHIR의 [Provenance](https://hl7.org/fhir/provenance.html)와 [AuditEvent](https://www.hl7.org/fhir/R5/auditevent.html)에 대응할 별도 기록이 필요하다.

#### 관찰성 모듈은 운영 완제품이 아니다

LangGraph4j OpenTelemetry 모듈은 패턴과 도구에 초점을 둔다고 스스로 설명한다.
노드와 간선 추적은 가능하지만 대시보드, 평가 자료 관리, 실행 비교, 운영 배포까지 한 제품으로 제공하지 않는다.
근거는 [OpenTelemetry 모듈 설명](https://github.com/langgraph4j/langgraph4j/blob/v1.8.21/langgraph4j-opentelemetry/README.md)에서 확인할 수 있다.

추적 속성에 그래프 상태와 설정을 넣을 수 있으므로 건강 정보가 외부 관찰성 저장소로 유출되지 않도록 기본값을 바꿔야 한다.

- 원문 프롬프트와 센서 원본을 기본적으로 기록하지 않는다.
- 사용자 식별자는 비가역 가명 키로 바꾼다.
- 근거 ID와 정책 버전만 남긴다.
- 예외 메시지와 도구 인자를 정제한다.

#### 유지보수가 핵심 기여자에게 집중돼 있다

저장소는 최근에도 활발히 갱신되고 있지만 2026-08-03에 확인한 공개 [기여자 통계](https://github.com/langgraph4j/langgraph4j/graphs/contributors)는 기여량이 한 명의 핵심 유지보수자에게 크게 집중된 모습을 보인다.
이는 프로젝트가 방치됐다는 뜻은 아니며, 버전 호환성 문제나 보안 수정의 대응력이 조직 하나의 통제 밖에 있다는 의미다.

채택 시 다음 비용을 계획해야 한다.

- 안정판 고정과 계획된 업그레이드 창구
- 내부 어댑터 계층
- 회귀 시험 묶음
- 필요 시 포크 또는 직접 패치할 역량
- Spring AI 버전 조합 검증

### 코드에서 도출한 검증 필요 추론

다음 항목은 공식 보장으로 단정하지 않고 실제 장애 주입 시험으로 확인해야 한다.

#### 복잡한 병렬 실행의 적용 범위

LangGraph4j는 병렬 실행과 조건부 경로를 각각 지원한다.
다만 안정판의 공식 [병렬 분기 예제](https://raw.githubusercontent.com/langgraph4j/langgraph4j/main/how-tos/parallel-branch.ipynb)는 포크-조인 구조와 한 번의 병렬 단계에 초점을 두며, 병렬 단계 안의 조건부 경로 같은 조합에는 제약을 설명한다.

따라서 “병렬 실행을 지원하지 않는다”라고 판단하면 안 된다.
복잡한 동적 병렬 그래프가 필요한 경우에는 원하는 조합을 작은 재현 시험으로 검증해야 한다.
MVP에서는 의료 지식 검색, 사용자 기록 검색, 센서 요약 조회를 하나의 검색 조정 노드 안에서 통제하면 이 불확실성을 줄일 수 있다.

#### 병렬 형제 작업의 부분 성공 재사용

안정판의 `ParallelNode`는 여러 비동기 작업을 합치지만, 체크포인트 저장기 계약에는 LangGraph.js의 `pending writes`처럼 성공한 형제 작업 결과를 개별 보존하는 명시적 개념이 없다.
한 분기가 외부 부작용을 완료하고 다른 분기가 실패하면 재개 시 완료된 부작용이 다시 실행될 가능성을 배제할 수 없다.

관련 구현은 [ParallelNode.java](https://github.com/langgraph4j/langgraph4j/blob/v1.8.21/langgraph4j-core/src/main/java/org/bsc/langgraph4j/internal/node/ParallelNode.java)에서 확인할 수 있다.
이에 비해 LangGraph.js는 [영속성 문서](https://docs.langchain.com/oss/javascript/langgraph/persistence)에서 성공한 병렬 노드의 보류 쓰기를 보존한다고 명시한다.

#### PostgreSQL 체크포인트의 장기 실행 비용

안정판 `PostgresSaver` 구현은 저장 과정에서 스레드의 체크포인트 이력을 읽어 처리하는 경로를 가진다.
실행 단계가 길거나 사용자당 실행 이력이 많으면 단계별 저장 비용이 증가하는지 부하 시험이 필요하다.

구현은 [PostgresSaver.java](https://github.com/langgraph4j/langgraph4j/blob/v1.8.21/langgraph4j-postgres-saver/src/main/java/org/bsc/langgraph4j/checkpoint/PostgresSaver.java)에서 확인할 수 있다.

#### 불변 시간 분기 계보

안정판 PostgreSQL 저장기는 특정 체크포인트의 상태 갱신 시 기존 기록을 대체하는 경로를 가진다.
LangGraph.js의 시간 이동처럼 원래 이력을 보존하면서 새 분기를 만드는 의미와 동일하다고 가정하면 안 된다.

의료·돌봄 설명이 어떤 근거와 승인 상태에서 만들어졌는지 재현하려면 애플리케이션 감사 원장에 불변 스냅샷을 남겨야 한다.

## LangGraph.js를 선택하면 얻는 것

LangGraph.js는 공식 JavaScript 구현이며 다음 운영 의미가 더 명확하다.

- `interrupt()`로 임의 지점에서 중단하고 같은 스레드로 재개
- 단계별 체크포인트와 내구 실행
- 병렬 실패 시 성공한 형제 작업의 결과 보존
- 노드별 재시도와 시간 제한
- 원래 이력을 보존하는 재생과 분기
- 병렬 분기와 `Send` 기반 동적 분산
- 새 애플리케이션을 위한 형식화된 사건 스트리밍
- LangSmith 관찰성 및 Agent Server와의 일관된 경로

공식 [중단 문서](https://docs.langchain.com/oss/javascript/langgraph/interrupts)는 재개 시 중단이 발생한 노드가 처음부터 다시 실행된다고 명시한다.
따라서 LangGraph.js에서도 중단 이전 부작용은 중복 실행에 안전해야 한다.

장기 승인 대기 중 그래프 코드를 배포하는 위험도 있다.
공식 [장애 허용 문서](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance)는 재개된 실행이 최신 그래프 정의를 사용하며, 재개 지점 이전의 작업이나 중단 순서를 바꾸면 저장된 결과의 대응이 어긋날 수 있다고 설명한다.

따라서 LangGraph.js로 전환해도 다음 배포 계약이 필요하다.

- 모든 실행에 `graph_definition_version`을 저장한다.
- 승인 대기 중인 실행과 호환되지 않는 그래프를 같은 버전으로 덮어쓰지 않는다.
- 작업 및 중단 순서를 바꾸는 배포는 기존 실행을 소진하거나 명시적으로 이관한 뒤 진행한다.
- 이관할 수 없는 실행은 담당자가 근거를 확인한 후 취소하고 새 실행으로 다시 만든다.

### 비용과 주의점

오픈 소스 라이브러리는 MIT이며 NestJS 애플리케이션 안에서 독립적으로 운영할 수 있다.
LangSmith나 Agent Server는 필수가 아니다.

하지만 공식 배포 계층을 사용하면 별도 PostgreSQL, Redis, 라이선스 조건, 외부 연결 요건이 생긴다.
자체 운영 Agent Server의 조건은 [독립 서버 배포 문서](https://docs.langchain.com/langsmith/deploy-standalone-server)에서 확인할 수 있다.

OSS 라이브러리만 사용하면 다음 기능은 팀이 직접 구성해야 한다.

- NestJS API와 인증
- 작업 큐와 동시성 제한
- 수평 확장 시 실행 소유권
- 배포와 복구 절차
- 관찰성 자료의 개인정보 정제
- Java 업무 서비스와 계약·장애 처리

즉 LangGraph.js 선택은 프레임워크 성숙도는 높이지만 런타임과 서비스 경계 하나를 추가한다.
공식 [로컬 서버 문서](https://docs.langchain.com/oss/javascript/langgraph/local-server)의 `langgraph dev`는 메모리 기반 개발 서버이므로 운영 배포안으로 사용하면 안 된다.
운영에서는 영속 체크포인터를 붙인 NestJS 서비스 또는 운영용 Agent Server가 필요하다.

## Gradle 멀티 모듈 MVP 구조

처음에는 독립 마이크로서비스 여러 개보다 하나의 Spring Boot 배포 단위 안에서 모듈 경계를 두는 편이 빠르다.

```text
care-domain
sensor-ingest
anomaly-analysis
knowledge-graph
agent-orchestration
approval-workflow
schedule-adapter
platform-api
```

### 모듈 책임

| 모듈 | 책임 |
| --- | --- |
| `care-domain` | 환자·돌봄 계획·근거·승인·일정 명령의 순수 도메인 모델 |
| `sensor-ingest` | 센서 입력 검증, 품질 표시, 시계열 저장 |
| `anomaly-analysis` | 규칙·통계 기반 이상 후보와 개인 기준선 |
| `knowledge-graph` | 허용된 Cypher와 전문 지식·사용자 기록 검색 |
| `agent-orchestration` | 근거 조합, 설명 생성, 승인 대기까지의 그래프 |
| `approval-workflow` | 승인 요청, 권한, 만료, 동시 승인, 감사 기록 |
| `schedule-adapter` | 내부 일정 API 계약, 중복 방지, 재시도, 결과 정규화 |
| `platform-api` | 외부 API, 인증·인가, 배포 조립 |

모듈 수가 초기 개발을 방해하면 `sensor-ingest`와 `anomaly-analysis`, `approval-workflow`와 `schedule-adapter`를 각각 합칠 수 있다.
중요한 것은 물리적 모듈 수가 아니라 의존 방향이다.

### 교체 가능한 경계

다음 포트를 Spring 도메인에 두고 LangGraph4j 형식이 바깥으로 새지 않게 한다.

```java
interface AgentWorkflow {
    AgentRun start(AgentInput input);
    AgentRun resume(AgentRunId runId, ApprovalDecision decision);
}

interface EvidenceRetriever { /* 센서·온톨로지·돌봄 근거 조회 */ }
interface ApprovalPort { /* 승인 생성·조회·완료 */ }
interface ScheduleCommandPort { /* 승인된 일정 명령만 실행 */ }
interface AgentCheckpointPort { /* 프레임워크 실행 재개 */ }
```

프레임워크 상태에는 전체 도메인 객체보다 식별자와 버전만 넣는다.
이렇게 해야 직렬화 변경, 개인정보 노출, LangGraph.js 전환 비용을 줄일 수 있다.

## Graph RAG 설계 원칙

### 자유 Cypher 생성을 운영에서 금지한다

LLM이 임의 Cypher를 만들어 건강·돌봄 그래프 전체를 조회하게 하면 과도한 정보 접근, 고비용 질의, 프롬프트 주입 위험이 커진다.

- 질의는 허용된 템플릿과 파라미터만 사용한다.
- 사용자·기관·목적 범위를 서버가 주입한다.
- 읽기 전용 계정과 질의 시간 제한을 둔다.
- 반환 노드와 관계 종류를 제한한다.
- 모든 근거에 출처, 개정일, 적용 범위, 조회 시각을 붙인다.

### 의료 지식과 환자 사실을 분리한다

- 온톨로지는 일반 의료 개념과 관계를 표현한다.
- 센서 관찰은 특정 시점의 환자 사실을 표현한다.
- 돌봄 기록은 담당자가 기록한 업무 사실을 표현한다.
- 에이전트 설명은 파생 결과이며 원본 사실을 덮어쓰지 않는다.

관찰 코드에는 LOINC를 검토하고 임상 용어에는 SNOMED CT를 검토할 수 있다.
다만 [LOINC 라이선스](https://loinc.org/license)와 [SNOMED CT 공식 문서](https://docs.snomed.org/)에 따라 배포 지역과 사용 방식의 라이선스를 확인해야 한다.

### 근거 없는 설명은 실패로 처리한다

출력에는 최소한 다음을 포함한다.

- 관찰된 변화와 시간 구간
- 비교 기준선
- 사용한 센서 품질 표시
- 연결된 전문 지식 출처
- 사용자 돌봄 기록의 근거 ID
- 불확실성과 누락 데이터
- 담당자 확인 권고
- 생성 모델·프롬프트·정책 버전

근거 ID가 없거나 상충 근거가 해소되지 않으면 설명을 생성하지 않고 검토 대기 상태로 보낸다.

## 운영 보안과 개인정보

건강 정보는 민감정보로 다뤄야 한다.
국내 서비스라면 개인정보보호위원회의 [보건의료데이터 활용 가이드라인](https://m.pipc.go.kr/np/cop/bbs/selectBoardArticle.do?bbsId=BS217&mCode=D010030000&nttId=12183)을 기준으로 별도 법률·개인정보 검토가 필요하다.

최소 통제 항목은 다음과 같다.

- 전송·저장 암호화
- 역할과 기관 범위에 따른 세밀한 접근 통제
- 목적별 최소 정보 조회
- 승인자와 실행자의 행위 기록
- 운영 자료와 관찰성 자료의 보존 기간 분리
- 모델 공급자로 보내는 정보 최소화
- 프롬프트·응답·도구 인자의 개인정보 정제
- 삭제와 정정의 전파 절차
- 모델 및 검색 품질의 운영 감시
- 장애 시 일정 변경 도구의 기본 차단

### 저장소별 정보 수명주기

구체적인 보존 기간은 법률 검토와 기관 계약 후 정한다.
그 전에도 하나의 `data_subject_id`와 `retention_policy_id`로 원본, 파생 자료, 검색 색인, 체크포인트를 추적할 수 있어야 한다.

| 저장 위치 | 자료 성격 | 삭제·정정 원칙 | 백업·복원 원칙 |
| --- | --- | --- | --- |
| PostgreSQL | 운영 원본, 승인, 명령, 감사 | 업무·법정 보존 근거별 기간을 분리하고 정정 이력을 보존 | 시점 복구 후 삭제 요청과 정정 사건을 다시 적용 |
| TimescaleDB | 원시 센서와 집계 | 원시 자료 만료 시 파생 집계의 재식별 가능성도 함께 평가 | 보존 기간보다 오래된 백업의 접근과 폐기 절차를 둠 |
| Neo4j | 온톨로지, 사용자 관계, 근거 색인 | 원본 삭제 시 사용자 연결과 파생 색인을 비동기로 제거하고 검증 | 복원 후 원본 저장소와 개정 번호를 대조해 색인을 재구성 |
| 체크포인트 | 재개 상태와 중간 결과 | 실행 종료·만료 후 정해진 유예 기간 내 제거하고 감사 원장만 보존 | 복원한 체크포인트가 현재 그래프 버전과 맞지 않으면 자동 재개 금지 |
| 로그·추적 | 가명화된 운영 진단 자료 | 가장 짧은 기간을 적용하고 원문 건강 정보는 기본 수집 금지 | 장기 백업 대상에서 제외하거나 별도 암호화·접근 통제 |

삭제는 각 저장소의 성공 응답만 모으는 것으로 끝내지 않는다.
삭제 작업 ID와 저장소별 상태를 기록하고, 실패한 파생 색인을 재처리하며, 최종 검증이 끝나야 완료로 표시한다.
백업에서 복원할 때는 이미 처리된 삭제·정정 사건을 재적용해야 한다.

Neo4j의 세밀한 역할 기반 접근 통제, 온라인 백업, 클러스터링 요구 때문에 운영 건강 정보를 저장할 때는 Community Edition만으로 충분한지 별도 검토해야 한다.
제품별 차이는 [Neo4j Operations Manual](https://neo4j.com/docs/operations-manual/current/introduction/)에서 확인할 수 있다.

## 기술 검증 합격 기준

LangGraph4j 채택 전 아래 시나리오를 자동 시험으로 만들어야 한다.

| 시험 | 합격 조건 | 실패 시 판단 |
| --- | --- | --- |
| 승인 대기 중 프로세스 종료 | 재시작 후 같은 실행을 한 번만 재개 | LangGraph.js 전환 검토 |
| 다른 인스턴스에서 재개 | 공유 저장소로 상태·권한을 일관되게 복원 | 단일 인스턴스 종속이면 불합격 |
| 중복 승인 전달 | 일정 변경 API가 정확히 한 번의 업무 결과만 생성 | 승인 계층 재설계 |
| 승인과 취소의 경쟁 | 한 결정만 승리하고 나머지는 충돌로 기록 | 승인 계층 재설계 |
| 외부 API 시간 초과 | 안전한 재시도 또는 운영자 재처리로 수렴 | 도구 실행 분리 |
| 병렬 분기 하나 실패 | 완료된 부작용이 중복되지 않음 | 병렬 그래프 금지 또는 JS 전환 |
| 체크포인트 직렬화 변경 | 이전 실행을 재개하거나 명시적으로 이관 | 배포 차단 조건 설정 |
| 승인 대기 중 그래프 코드 변경 | 버전이 다른 실행을 잘못 재개하지 않고 소진·이관·취소 정책으로 처리 | 무중단 배포 절차 재설계 |
| 1,000단계 실행 이력 | 저장 지연과 DB 부하가 목표 범위 안 | 저장기 교체·패치 또는 JS 전환 |
| 개인정보 추적 검사 | 원문 건강 정보가 로그·추적에 남지 않음 | 관찰성 비활성화 후 보완 |
| Neo4j 질의 공격 | 임의 쓰기·전 사용자 조회·장기 질의 차단 | 검색 계층 재설계 |

성능 목표는 실제 동시 사용자 수와 센서 빈도가 정해진 뒤 수치화한다.
현재 단계에서 중요한 것은 정상 경로 지연보다 장애 후 중복 실행과 승인 무결성이다.

## 의사결정 규칙

### LangGraph4j를 채택한다

다음 조건을 모두 만족하면 채택한다.

- 기술 검증의 승인·재개·중복 방지 필수 시험을 통과한다.
- OpenTelemetry 자료에서 건강 정보를 정제할 수 있다.
- Spring AI와 모델 공급자 버전 조합을 고정할 수 있다.
- 그래프를 `AgentWorkflow` 경계 안에 격리한다.
- 체크포인트와 감사 원장을 분리한다.
- 복잡한 병렬 그래프를 MVP 범위에서 제외한다.

### LangGraph.js로 전환한다

다음 중 하나라도 중요 요구에 해당하면 전환한다.

- 노드별 재시도·시간 제한을 프레임워크 수준에서 즉시 요구한다.
- 병렬 분기의 부분 성공 보존이 핵심이다.
- 불변 시간 분기와 정교한 실행 재생이 핵심이다.
- LangSmith 평가·관찰성·배포 계층을 도입하기로 했다.
- LangGraph4j의 운영 결함을 보완하는 코드가 에이전트 업무 코드보다 커진다.

전환 시 Spring의 승인·일정 명령 계층은 그대로 두고 NestJS 에이전트 서비스만 분리한다.
계약은 `start`, `resume`, `cancel`, `status`와 근거·승인 이벤트로 제한한다.

### LangGraph와 업무 승인 엔진을 분리한다

승인 단계가 다단계 결재, 위임, 기한, 재할당, 에스컬레이션으로 커지면 LangGraph 체크포인트를 확장하지 않는다.
MVP에서는 PostgreSQL 승인 테이블과 아웃박스로 충분하지만, 복잡해지면 사용자 작업 수명주기를 제공하는 별도 업무 흐름 엔진을 검토한다.
[Camunda 사용자 작업](https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks/)은 사람이 완료할 때까지 프로세스를 정지하고 할당·수명주기를 관리하는 예시다.

## 단계별 제안

### 1단계: 1~2주 기술 검증

- LangGraph4j `1.8.21` 고정
- PostgreSQL 체크포인트
- 한 개의 이상 징후 설명 흐름
- 한 개의 승인 대기와 일정 변경 모의 API
- 장애 주입·중복 요청·다중 인스턴스 시험
- OpenTelemetry 개인정보 정제 시험

### 2단계: 운영 MVP

- Spring Boot 단일 배포 단위
- TimescaleDB와 Neo4j 분리
- 결정적 이상 후보 생성
- 허용된 Graph RAG 조회
- 승인 원장과 아웃박스
- 일정 변경 API의 중복 방지
- 근거 기반 응답 평가 자료

### 3단계: 분리 판단

- 에이전트 개발 속도와 운영 장애 데이터를 측정한다.
- LangGraph4j 보완 비용이 누적되면 NestJS와 LangGraph.js로 실행부를 옮긴다.
- 승인, 명령, 감사, 데이터 저장소는 Spring 중심으로 유지한다.
- Python은 Neo4j GraphRAG의 Python 전용 기능이나 데이터 과학 도구가 꼭 필요하고 운영 인력을 확보한 경우에만 검토한다.

## 최종 권고 문장

**지금은 Spring Boot·Gradle 멀티 모듈로 빠르게 시작하되 LangGraph4j를 업무 시스템의 중심이 아니라 교체 가능한 추론 실행기로 사용한다.**

**승인과 일정 변경은 PostgreSQL 기반 업무 계층이 소유하고, LangGraph4j `1.8.21`의 재개·병렬 실패·관찰성 검증에 실패하면 에이전트 실행부만 NestJS·LangGraph.js로 전환한다.**

이 선택은 Java 선호를 위해 운영 위험을 무시하는 결정도 아니고, 공식 생태계를 위해 서비스 하나를 성급히 늘리는 결정도 아니다.
현재 팀 역량을 활용하면서 가장 위험한 부분을 명시적 전환 조건으로 관리하는 결정이다.

## 주요 근거

- [LangGraph4j 저장소와 기능 개요](https://github.com/langgraph4j/langgraph4j)
- [LangGraph4j `1.8.21` 릴리스](https://github.com/langgraph4j/langgraph4j/releases/tag/v1.8.21)
- [LangGraph4j 영속성 예제](https://raw.githubusercontent.com/langgraph4j/langgraph4j/main/how-tos/persistence.ipynb)
- [LangGraph.js 개요](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [LangGraph.js 영속성과 장애 복구](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [LangGraph.js 중단과 재개](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [LangGraph.js 시간 이동](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel)
- [LangSmith 배포](https://docs.langchain.com/langsmith/deployment)
- [FHIR Observation](https://www.hl7.org/fhir/observation.html)
- [FHIR Provenance](https://hl7.org/fhir/provenance.html)
- [FHIR AuditEvent](https://www.hl7.org/fhir/R5/auditevent.html)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
- [OWASP Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)

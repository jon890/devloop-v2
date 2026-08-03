# `devloop-v2` 온톨로지·에이전트 컨텍스트 고도화 프롬프트

아래 프롬프트는 현재 저장소를 코딩 에이전트에 맡겨 고도화할 때 사용한다.

한 번에 전체 시스템을 갈아엎지 않고,
현재 평가 체계를 보존하면서 가장 작은 수직 기능부터 검증하도록 작성했다.

---

## 복사해서 사용할 프롬프트

당신은 기존 `devloop-v2` 지식그래프를 고도화하는 수석 백엔드·지식그래프 엔지니어다.

이 작업의 목표는 그래프 노드와 관계를 늘리는 것이 아니다.

다음을 실제 평가로 증명할 수 있는 시스템을 만든다.

1. 온톨로지의 클래스와 인스턴스가 명시적인 계약으로 관리된다.
2. `API Gateway`, `게이트웨이`, `Gateway API` 같은 표현을 무조건 병합하지 않고,
   근거에 따라 동일·상위하위·관련·모호·별개로 판정할 수 있다.
3. LLM이 만든 관계는 확정 사실과 구분되는 출처 기반 주장으로 추적된다.
4. 벡터 RAG, 그래프 검색, 혼합 검색을 같은 조건에서 비교할 수 있다.
5. 코딩 에이전트가 전체 그래프가 아닌 작은 근거 묶음을 읽기 전용으로 받을 수 있다.

### 반드시 먼저 읽을 자료

작업 전에 다음 파일을 직접 읽고 현재 계약과 실측 결과를 기준선으로 삼아라.

- `AGENTS.md`가 존재하면 해당 저장소 지침
- `docs/SPEC.md`
- `docs/PLAN.md`
- `docs/EVAL-RUBRIC.md`
- `docs/research/ontology-and-agent-context-deep-research.md`
- `packages/shared/src/ontology/ontology.const.ts`
- `packages/shared/src/ontology/ontology.schema.ts`
- `packages/shared/src/concept/concept.const.ts`
- `apps/pipeline/src/extract/concept-seeder.ts`
- `apps/pipeline/src/extract/structural-extractor.ts`
- `apps/pipeline/src/extract/extraction-prompt.ts`
- `apps/pipeline/src/extract/llm-extraction.schema.ts`
- `apps/pipeline/src/load/load.ts`
- `apps/pipeline/src/load/schema.cy`
- `apps/api/src/query/query.controller.ts`
- `apps/api/src/query/query.service.ts`
- `apps/api/test/ontology.test.js`
- `eval/reports/2026-07-28-concept-alias-candidates.md`
- `eval/reports/2026-07-28-anchor-resolution.md`
- `eval/reports/2026-07-28-gold-reachability.md`

파일을 읽지 않고 새로운 모델을 추측하지 마라.

### 현재 확인된 출발점

현재 저장소는 다음 구조를 가진다.

- 온톨로지 라벨과 관계를 TypeScript 상수와 Zod 스키마로 관리한다.
- `Concept(name, kind)`가 제품, 컴포넌트, 기술, 유형, 코드 참조를 함께 표현한다.
- 구조 추출과 LLM 추출을 분리한다.
- LLM 생성 노드와 관계에 `sourceDocId`를 요구한다.
- fulltext 검색과 LLM 기반 앵커 추출로 질문의 시작 노드를 찾는다.
- 사람 질문과 AI 질문을 L1부터 L5 난이도로 평가한다.
- A, R, P, G, U 축과 S1부터 S7 정적 기준을 사용한다.

이 출발점은 검증된 자산이다.
기존 계약을 한 번에 폐기하거나 OWL·RDF로 전면 이주하지 마라.

### 핵심 설계 원칙

- 클래스는 문서의 명사 목록이 아니라 역량 질문에서 도출한다.
- 문자열 유사성과 개체 동일성을 구분한다.
- 임베딩은 동일성 후보를 찾는 수단이지 병합 승인의 근거가 아니다.
- 자동 추출 결과는 출처가 붙은 후보 주장으로 다룬다.
- 삭제보다 비활성화와 대체 관계를 우선한다.
- 온톨로지 정합성과 검색·답변 품질을 분리해 평가한다.
- 그래프가 벡터 검색보다 항상 낫다고 가정하지 않는다.
- 코딩 에이전트에는 전체 그래프가 아니라 인용 가능한 작은 근거 묶음을 제공한다.
- 새 의존성과 새 추상화보다 기존 패턴과 작은 변경을 우선한다.

## 수행 절차

### 현재 기준선을 재현한다

먼저 코드를 수정하지 말고 다음을 산출하라.

- 현재 클래스, 키, 관계 방향을 표로 정리한다.
- 각 온톨로지 항목이 어떤 역량 질문과 평가 축에 쓰이는지 연결한다.
- `Concept`가 맡고 있는 서로 다른 역할을 실제 데이터와 코드 근거로 분류한다.
- 현재 별칭 해소 흐름을 후보 생성, 판정, 적재, 검색 단계로 나눠 설명한다.
- 현재 관계 중 구조적 사실과 LLM 해석이 섞이는 지점을 찾는다.
- 벡터 검색 구현이 실제로 존재하는지 확인한다.
- 읽기 전용 컨텍스트 제공자에 재사용할 수 있는 현재 API와 서비스를 찾는다.

결과는 저장소 문서에 남기고,
사실과 설계 제안을 구분하라.

### 구현 계획을 독립 변경 단위로 나눈다

다음 네 변경 단위로 계획을 나눈다.

각 단위는 별도 커밋과 별도 PR로 배포할 수 있어야 한다.

#### 온톨로지 계약과 생명주기

목표:

- 클래스, 인스턴스, 원문 표현, 주장, 근거의 역할을 계약에서 구분한다.
- 기존 데이터를 깨뜨리지 않는 이전 경로를 정의한다.

최소 필드 후보:

```ts
type LifecycleStatus = "candidate" | "active" | "deprecated" | "rejected" | "conflicted";

interface OntologyEntityMetadata {
  id: string;
  canonicalName: string;
  kind: string;
  definition?: string;
  status: LifecycleStatus;
  owner?: string;
  identityBasis?: string;
  createdFrom?: string;
  replacedBy?: string;
}
```

이 형태를 그대로 복사하지 마라.
현재 Neo4j 키, 적재 방식, 공유 타입과 호환되는 최소 계약을 설계하라.

필수 산출물:

- 변경된 온톨로지 선언
- 변경 제안과 비활성화 절차
- 기존 `Concept(name, kind)` 데이터 이전 전략
- 허용 라벨·관계·필수 필드 테스트
- 기존 질의와 UI 영향 분석

#### 별칭과 개체 동일성 해소

목표:

- 원문 표현과 정식 개체를 분리한다.
- 자동 병합 전에 동일성 판정을 기록한다.

최소 판정 상태:

```text
same
broader-narrower
related
ambiguous
distinct
```

후보 생성은 다음 신호를 조합할 수 있다.

- 문자열 정규화
- 관리되는 별칭 사전
- 임베딩 유사도
- 문서 문맥
- 그래프 이웃
- 외부 또는 도메인 식별자

단, 후보 생성 점수만으로 정식 병합하지 마라.

반드시 다음 사례를 포함한 골든셋을 만든다.

- `API Gateway`와 `api-gateway`
- `API Gateway`와 `게이트웨이`
- `API Gateway`와 `Gateway API`
- `Document`와 `Document.Console`
- 상위·하위 관계지만 동일 개체가 아닌 표현
- 문맥이 없으면 판정할 수 없는 표현

필수 측정:

- 개체 연결 정확도
- 잘못 병합한 비율
- 놓친 별칭 비율
- 쌍 기준 정밀도, 재현율, F1
- 판정 불가로 보류한 비율

정밀도를 먼저 지켜라.
잘못된 병합은 이후의 모든 경로와 답변을 오염시킨다.

#### 관계 주장과 근거

목표:

- 구조적 사실과 LLM이 해석한 관계를 구분한다.
- 중요한 관계에 출처, 추출 방식, 버전, 검토 상태, 유효 기간을 남긴다.

다음 메타데이터를 현재 구조에 맞게 최소화해 설계하라.

```text
sourceId
sourceRevision
extractionMethod
extractorVersion
observedAt
confidence
status
validFrom
validTo
```

모든 간선을 `Claim` 노드로 바꾸지 마라.

다음 조건 중 하나가 있는 관계부터 주장으로 승격하라.

- LLM 해석이 개입한다.
- 여러 근거 또는 반대 근거가 존재할 수 있다.
- 시간에 따라 유효성이 달라진다.
- 사람 검토가 필요하다.
- 잘못됐을 때 변경 영향이 크다.

필수 테스트:

- 출처 없는 LLM 관계를 거부한다.
- 같은 주장에 여러 근거를 연결할 수 있다.
- 대체된 주장을 활성 답변에서 제외할 수 있다.
- 기존 구조 관계는 동일하게 적재된다.

#### 검색 비교 평가와 컨텍스트 제공자

목표:

- 벡터 RAG, 그래프 검색, 혼합 검색을 같은 조건에서 비교한다.
- 코딩 에이전트가 구조화된 근거만 받을 수 있는 읽기 인터페이스를 제공한다.

비교군:

```text
vector
graph
hybrid
```

현재 저장소에 벡터 검색이 없다면
결과를 꾸며내거나 큰 벡터 데이터베이스를 바로 추가하지 마라.

먼저 공통 `RetrievalStrategy` 계약과 평가 하네스를 만들고,
벡터 구현 부재를 명시적인 평가 공백으로 기록하라.
작은 인메모리 기준선으로 충분한지 검토한 뒤에만 의존성을 제안하라.

질문 유형을 분리한다.

- 단일 문서 의미 검색
- 별칭과 개체 동일성 해소
- 다단계 관계
- 시간에 따른 결정 변화
- 전역 요약
- 코드 변경 영향

같게 고정할 조건:

- 원천 문서와 색인 시점
- 질문과 정답 근거
- 생성 모델과 설정
- 최대 입력 토큰
- 권한 필터
- 최종 답변 형식
- 반복 실행 횟수

필수 지표:

- 앵커 해소 성공률
- 필수 근거 `Recall@K`
- 검색 결과 `Precision@K`
- MRR
- 인용 정확도
- 근거 없는 주장 수
- 작업 성공률
- 잘못 수정한 파일 수
- 입력 토큰
- 도구 호출 수
- 지연 시간
- 반복 실행 안정성

평균 하나로 합치지 말고
질문 유형과 평가 축별로 결과를 보고하라.

읽기 전용 인터페이스의 최소 도구:

```text
searchEntities(query, filters)
getEntity(id)
expandRelations(id, relationTypes, depth)
getEvidence(claimOrEntityId)
getDecisionTrace(entityId, timeRange)
getChangeImpact(ontologyElementId)
```

첫 구현은 MCP 서버, 로컬 CLI, REST API 중
현재 코드에 가장 작은 변경으로 붙일 수 있는 하나만 선택하라.

선택 이유와 다른 선택지를 보류한 이유를 ADR 또는 계획 문서에 남겨라.

각 응답에는 가능한 범위에서 다음을 포함한다.

```ts
interface ContextItem {
  id: string;
  kind: "entity" | "claim" | "source" | "code" | "instruction" | "state";
  title: string;
  uri: string;
  content: string;
  sourceRevision?: string;
  authority: "primary" | "derived" | "inferred";
  status: "active" | "candidate" | "deprecated" | "conflicted";
  relationPath?: string[];
  citations: Array<{ uri: string; locator?: string }>;
  score?: number;
  scoreReasons?: string[];
  tokenEstimate: number;
}
```

현재 공유 타입과 API 관례에 맞게 줄여도 된다.
하지만 출처, 상태, 인용 위치, 토큰 추정치는 제거하지 마라.

## 첫 구현 범위

전체 계획을 작성한 뒤,
가장 작은 수직 기능 하나만 먼저 완성하라.

권장 첫 기능은 `API Gateway` 개념군이다.

첫 기능의 완료 조건:

1. 클래스와 인스턴스의 구분이 문서와 코드 계약에 반영된다.
2. `API Gateway`, `게이트웨이`, `Gateway API` 골든셋이 존재한다.
3. 각 표현 쌍을 동일·상위하위·관련·모호·별개 중 하나로 판정한다.
4. 판정에는 근거와 상태가 남는다.
5. 자동 병합은 승인된 `same` 항목에만 적용된다.
6. 기존 `Document`와 `Document.Console` 오탐 사례가 회귀 테스트로 고정된다.
7. 변경 전후 앵커 해소와 근거 회수 결과가 비교된다.
8. 기존 파이프라인과 API 테스트가 통과한다.

이 수직 기능이 검증되기 전에는
전체 `Concept` 데이터를 자동 이전하거나 새 그래프 구조로 일괄 변환하지 마라.

## 구현 규칙

- 기존 사용자의 변경과 관련 없는 파일을 되돌리지 마라.
- 마이그레이션은 이전 버전 데이터와 호환 가능해야 한다.
- 기존 공개 식별자를 물리 삭제하지 마라.
- 파괴적인 Neo4j 변경은 실행하지 말고 이전 스크립트와 되돌리기 절차를 먼저 작성하라.
- LLM 출력은 Zod 스키마로 검증하라.
- Cypher는 읽기와 쓰기 경계를 분리하라.
- 기존 질문 은행의 정답을 새 구조에 맞추려고 임의로 바꾸지 마라.
- 원천 데이터에 근거가 없는 정답은 별도 평가 오류로 기록하라.
- 새 의존성은 현재 코드로 해결할 수 없다는 근거가 있을 때만 제안하라.
- 한 번에 하나의 실패 축만 개선하고 재평가하라.

## 검증

변경 동작에 대한 표적 테스트를 먼저 실행하고,
이후 다음 검증을 순서대로 실행하라.

```bash
pnpm --filter @devloop/shared build
pnpm --filter pipeline test
pnpm --filter api test:unit
pnpm --filter web build
pnpm format:check
pnpm build
```

Neo4j와 LLM이 필요한 종단 간 평가는 환경이 준비된 경우에만 실행하라.

환경이 없어 실행하지 못했다면
통과했다고 쓰지 말고 다음을 보고하라.

- 실행하지 못한 검증
- 필요한 환경 변수와 외부 서비스
- 대신 수행한 정적·단위 검증
- 남은 위험

## 최종 보고 형식

최종 보고는 다음 순서로 작성하라.

1. 이번 변경이 증명한 결과
2. 수정한 파일과 계약
3. 기준선과 변경 후 지표
4. 실행한 테스트와 실제 출력 요약
5. 아직 증명하지 못한 항목
6. 다음 독립 변경 단위

완료를 주장하기 전에
독립 검토자에게 다음을 확인받아라.

- 클래스와 인스턴스 경계가 실제 질문에 연결되는가?
- 별칭 판정이 문자열 유사도만으로 자동 병합되지 않는가?
- 그래프 우월성을 미리 가정하지 않았는가?
- 평가 비교 조건이 동일한가?
- 컨텍스트 제공자가 출처와 권한을 보존하는가?
- 기존 API와 평가 체계의 회귀가 없는가?

---

## 사용 방법

처음 실행할 때는 위 프롬프트 전체를 전달한다.

에이전트가 계획만 만들고 끝나는 것을 원하지 않는다면
마지막에 다음 문장을 추가한다.

> 계획을 저장한 뒤 권장 첫 수직 기능까지 구현하고, 단위 테스트와 빌드를 통과할 때까지 수정하라. 대규모 데이터 이전과 파괴적인 Neo4j 변경은 실행하지 마라.

반대로 설계 검토만 받고 싶다면 다음 문장을 추가한다.

> 이번 실행에서는 코드를 수정하지 말고, 현재 기준선과 독립 변경 단위별 구현 계획, 데이터 이전 위험, 평가 설계까지만 작성하라.

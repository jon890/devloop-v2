# 데이터 스키마

- 상태: 기준선 (2026-07-29 작성)
- 원천: 깊이 인터뷰 8라운드(`~/personal/.omc/specs/deep-interview-dooray-knowledge-graph.md`),
  `docs/PLAN.md` 의 공유 계약, 운영 그래프 실측

이 문서는 **저장 모델의 필드·키·제약·삭제 규칙과 구조화 형식**을 소유한다.
계약의 실행 소스는 `packages/shared/src/ontology/` 이고 이 문서와 1:1 로 맞춘다.

## 온톨로지가 수렴한 과정

고정 스키마다. LLM 은 이 틀 안에서 추출만 한다.

| 라운드 | 개체 수 | 변화 |
| --- | --- | --- |
| 1~3 | 8 | 초기 도메인 모델. 3라운드 무변동 |
| **4** | **11** | 성공 장면을 논의하며 `Person`·`Comment`·`Decision` 추가 |
| 5~8 | 11 | **4라운드 연속 무변동** — 도메인 모델 수렴 |

R4 에서 추가된 셋이 핵심이다. "이 결정을 왜 했나" 에 답하려면
결정(`Decision`)과 그 근거(`Comment`), 그리고 사람(`Person`)이 노드여야 한다.
개체를 미리 나열해서 얻은 것이 아니라 **답해야 할 질문에서 역산해** 얻었다.

## 노드

| Label | key | 주요 속성 | 생성 주체 | 실측 |
| --- | --- | --- | --- | --- |
| `Project` | `code` | `name` | 구조 | 1 |
| `Task` | `number` | `subject`, `workflowClass`, `createdAt`, `bodyExcerpt` | 구조 | 490 |
| `Wiki` | `pageId` | `subject`, `parentId` | 구조 | 47 |
| `Person` | `memberId` | `name` | 구조 | 187 |
| `Comment` | `commentId` | `createdAt`, `excerpt` | 구조 | 854 |
| `Concept` | `name` | `kind` | 구조(태그)와 LLM(본문) | 974 |
| `Decision` | `id` (`task번호-seq`) | `summary`, `decidedAt` | LLM | 535 |

`Concept.kind` 는 `product`·`component`·`type`·`tech`·`code-ref` 중 하나다.

**모든 라벨의 key 에 UNIQUE 제약**이 걸린다 (7개).
`Task.subject`·`Wiki.subject`·`Concept.name` 에 fulltext 인덱스가 있고,
한국어 토큰화를 위해 analyzer 를 `cjk` 로 지정한다 (3개).

### key 설계의 함정

`Task.number` 가 key 라서 **프로젝트가 달라도 같은 번호는 같은 노드**가 된다.
다른 프로젝트의 78번 업무를 참조하면 이 프로젝트의 78번을 가리킨다.

실제로 두 번 문제가 됐다.

- 참조 추출이 타 프로젝트 참조를 이 프로젝트 업무로 이었다 (33건, 제거함)
- e2e fixture 를 운영 그래프에 잘못 적재했을 때 기존 업무 노드에 **병합**됐다

프로젝트를 여러 개 한 그래프에 담으려면 key 를 복합키로 바꿔야 한다.
현재는 비목표라 단일 프로젝트를 전제한다.

## 관계

| 관계 | 방향 | 생성 주체 | 실측 |
| --- | --- | --- | --- |
| `CONTAINS` | Project → Task·Wiki | 구조 | 537 |
| `ASSIGNED_TO` | Task → Person | 구조 | 933 |
| `AUTHORED` | Person → Task | 구조 | 490 |
| `COMMENTED` | Person → Comment | 구조 | 854 |
| `HAS_COMMENT` | Task → Comment | 구조 | 854 |
| `TAGGED` | Task → Concept | 구조 | 1,548 |
| `REFERENCES` | Task → Task | 구조 | 328 |
| `CHILD_OF` | Task → Task, Wiki → Wiki | 구조 | 250 |
| `MENTIONS` | Task·Wiki → Concept | LLM | 4,162 |
| `DOCUMENTS` | Wiki → Concept | LLM | 237 |
| `DEPENDS_ON` | Concept → Concept | LLM | 365 |
| `DECIDED_IN` | Decision → Task | LLM | 519 |
| `EVIDENCED_BY` | Decision → Task·Comment | LLM | 511 |
| `AFFECTS` | Decision → Concept | LLM | 1,281 |
| `RELATES_TO` | Task → Task | LLM | 150 |

`TAGGED.dimension` 은 문자열이고 `0`=유형, `1`=제품, `2`=컴포넌트를 뜻한다.
한 업무가 서로 다른 차원의 여러 Concept 에 `TAGGED` 될 수 있다.

`RELATES_TO.kind` 는 `precedes`·`causes`·`follows-up` 중 하나다.

### `MENTIONS` 와 `DOCUMENTS` 가 갈려 있다

`DOCUMENTS` 가 **더 강한 관계**다. 그 위키가 다루는 주제 개념이라는 뜻이다.

이 분기가 질의에서 문제를 만들었다. `[:MENTIONS]` 만 매치하면
**정답에 가까운 문서일수록 빠진다.** 위키가 주제로 다루는 개념은 `DOCUMENTS` 에만 붙기 때문이다.

**관계를 새로 추가할 때는 질의 쪽이 그 관계를 아는지 함께 확인한다.**
온톨로지에 정의만 하고 질의 프롬프트에 알리지 않으면 조용히 도달 불가가 된다.

## 구조화 산출물 (jsonl)

파이프라인 단계가 파일로 결과를 넘긴다. 한 줄에 노드 하나 또는 관계 하나다.

| 파일 | 생성 단계 | 담는 것 |
| --- | --- | --- |
| `graph/<project>/parsed.jsonl` | `parse-structure` | 구조 노드·관계 |
| `graph/<project>/inferred.jsonl` | `infer-knowledge` | `Concept`·`Decision` 과 의미 관계 |
| `graph/<project>/inference-dropped-relationships.json` | `infer-knowledge` | 스키마에 없어 버린 관계 |
| `graph/<project>/inference-failures.json` | `infer-knowledge` | 추출 실패 문서 |
| `graph/<project>/resolved.jsonl` | `resolve-graph` | 정규화된 노드·관계. **조사 전용** |
| `graph/<project>/resolve-report.json` | `resolve-graph` | 미매칭 Concept·건너뛴 관계·버린 관계·재작성 수 |
| `concepts/<project>.json` | `seed-concepts` | Concept 사전 |

`resolved.jsonl` 은 **파이프라인 입력이 아니다.** `sync-neo4j` 는 이 파일을 읽지 않고
`parsed`·`inferred`·사전을 직접 읽어 매번 새로 정규화한다. 근거는
`docs/adr/0004-resolve-as-inspection-stage.md` 에 있다.

형식은 `parsed`·`inferred` 와 같다. 같은 스키마를 재사용하고, 사람이 나란히 놓고 비교할 수 있다.

**출력 순서가 고정돼 있다** — 노드는 `라벨 → 키`, 관계는 `유형 → 시작키 → 끝키` 다.
같은 입력이면 바이트 동등해야 한다. 그게 별칭 변경 전후를 `cmp` 로 비교하는 전제다.

리포트는 `jsonl` 에 섞지 않고 별도 파일로 뺀다. 첫 줄에 메타데이터를 넣으면
읽는 쪽이 모두 그 줄을 건너뛰어야 하고, 그 규칙을 잊으면 조용히 깨진다.

형식은 이렇다.

```jsonl
{"label":"Wiki","key":"4377...","properties":{"pageId":"4377...","subject":"..."}}
{"type":"DOCUMENTS","startKey":"Wiki:4377...","endKey":"Concept:ingress-nginx","properties":{}}
```

관계의 `startKey`·`endKey` 는 `라벨:키` 형태다.

**소스 파일명이 적재 분기에 쓰인다.** 적재기는 Concept 이 어느 파일에서 왔는지로
구조 유래와 LLM 유래를 가른다. 파일명이 계약이므로 `packages/shared/src/graph/graph.const.ts`
상수를 통해서만 참조한다.

실제로 이 계약이 어긋나 e2e 가 오래 깨져 있었다 — fixture 가 Concept 을 제3의 파일명에 담고 있었다.

## Concept 표준 사전

Concept 이름 파편화가 관계형 질문의 연결을 끊는 **1번 위험**이다.
같은 대상이 여러 표기로 갈라지면 앵커가 한쪽만 잡아 다른 쪽 근거에 도달하지 못한다.

형태는 `{ canonical, kind, aliases[] }` 배열이다.
도메인 무관 기술 용어는 `packages/shared/src/concept/` 에 두고 프로젝트별 사전은 자동 생성한다.

사용처가 두 곳이다.

- `infer-knowledge` 추출 프롬프트에 **허용 목록**으로 제공한다. LLM 은 목록 밖 개체를 만들 때만 신규 이름을 쓴다
- `sync-neo4j` 적재 시 **별칭 → 대표 이름 정규화** 후 MERGE 한다. 사전 밖 신규 이름은 표기 정규화만 적용하고 리포트에 집계한다

### 정규화가 2단계로 걸린다

| 단계 | 흡수하는 차이 |
| --- | --- |
| 1 | 대소문자·공백 |
| 2 | 구두점 (`.`·`-`·`_`) |

2단계는 Concept 별칭 경로에만 적용된다. 1단계 함수는 참조 해석에도 쓰이므로 함부로 바꾸면 관계가 깨진다.

부당 병합을 막는 차단 목록이 있다. 토큰 집합이 같아도 다른 개체인 경우가 실재한다 —
쿠버네티스 표준 `Gateway API` 와 일반 `api gateway` 는 별개다.
**토큰 일치만으로 자동 병합하면 안 된다.**

### 표기 정규화로 잡히지 않는 유형

| 유형 | 예 |
| --- | --- |
| 부분 표기 | `Log`·`Crash` 대 `NHN Cloud Log & Crash` |
| 접두어 차이 | `api gateway` 대 `OCR API Gateway` |

부분포함으로 탐지하면 1,247쌍이 나오지만 **대부분 오탐**이다.
`Document` 가 `Document.Console` 에 포함되지만 둘은 별개 개체다.

그래서 자동 병합을 하지 않는다. 고빈도 Concept 만 후보로 뽑아 사람이 확인한 뒤 사전 별칭으로 등록한다.

## 삭제 규칙

**적재기에 삭제 경로가 없다.** MERGE 전용이다.

| 상황 | 결과 |
| --- | --- |
| 노드를 합치도록 정규화를 고치고 재적재 | 기존 파편 노드가 **그대로 남는다** |
| 관계 오탐을 제거하고 재적재 | 기존 관계가 **그대로 남는다** |

줄이려면 초기화가 필요하다.

```
(같은 NEO4J_URI로) reset-neo4j --force [--allow-production]  →  apply-schema  →  sync-neo4j
```

세 명령 모두 같은 `NEO4J_URI`를 가리켜야 한다 — `apply-schema`·`sync-neo4j`는 인라인 지정이 없으면
기본값 `bolt://localhost:7687`로 붙으므로, `reset-neo4j`에만 다른 URI를 인라인으로 주면
비우려던 그래프와 실제로 적재되는 그래프가 어긋난다.

`reset-neo4j` 는 `DETACH DELETE` 절차에 이름을 준 명령이다.

- `NEO4J_URI` 가 없으면 실행하지 않는다 — 삭제 대상을 항상 명시적으로 지정하게 만든다.
  이 명령만 다른 이유는 아래 참조
- `--force` 없이는 실행하지 않는다
- 대상 포트가 운영(`7687`)이면 `--allow-production` 도 함께 줘야 한다
- 대상 URI 와 현재 노드 수를 먼저 출력한다
- **삭제 범위는 전체다.** 프로젝트 단위 삭제는 만들지 않는다 —
  `Task.number` 가 프로젝트를 구분하지 않아 부분 삭제가 안전하지 않다 (위 "key 설계의 함정" 참조)

**`reset-neo4j` 만 `NEO4J_URI` 를 필수로 요구하는 이유** — 위 "key 설계의 함정"이 기록한 대로,
`Task.number` 가 프로젝트를 구분하지 않아 잘못된 그래프에 delete 를 실행하면 되돌릴 수 없다.
`apply-schema`·`sync-neo4j` 는 잘못 실행돼도 MERGE 이거나 제약 추가라 최악의 경우도 원복 가능하지만,
`reset-neo4j` 는 `DETACH DELETE` 라 대상을 잘못 짚으면 그래프가 통째로 사라진다. 그래서 이 명령만
기본값(`bolt://localhost:7687`)을 두지 않고 대상을 항상 명시하게 만든다 — CLAUDE.md 가 기록한
"환경변수 부재가 조용히 다른 모델로 돌게 만들었다" 사고와 같은 종류의 우연한 기본값 의존을
파괴적 명령에서는 허용하지 않는다.

`DETACH DELETE` 는 제약·인덱스를 지우지 않는다. 다만 재적재 절차에 `apply-schema` 를 넣어 둔다.

산출물 `jsonl` 이 남아 있으므로 **초기화 후 재적재로 정확히 복원된다** (실측: 노드 3,088 동일 복원).
LLM 캐시가 있어 추출 재실행은 불필요하다.

## 평가 gold 의 구조

평가 세트는 이 저장소에 포함되지 않는다. 형식만 기록한다.

문항의 정답 목록을 두 등급으로 나눈다.

| 등급 | 판정 |
| --- | --- |
| `required` | **전부 인용해야 통과** |
| `supporting` | **비율 기준** (파일럿 ≥ 40% / 인수 ≥ 60%) |

### 보강 비율은 분모가 작으면 필수와 같아진다

항목이 1개면 비율이 **0% 아니면 100%** 다. 어떤 임계값을 써도 "누락 0개" 요구가 된다.
2개여도 하나 빠지면 50% 라 60% 기준에 걸린다.

- 항목을 필수에서 내리기만 하지 말고 **분모를 함께 채운다**
- 보강이 0개인 문항은 비율 판정을 생략한다

자세한 판정 기준은 `docs/EVAL-RUBRIC.md` 가 단일 소스다.

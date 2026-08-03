# 데이터 스키마

- 상태: 기준선 (2026-07-29 작성)
- 원천: 깊이 인터뷰 8라운드(`~/personal/.omc/specs/deep-interview-dooray-knowledge-graph.md`), 운영 그래프 실측

이 문서는 **저장 모델의 필드·키·제약·삭제 규칙과 구조화 형식**을 소유한다.
계약의 실행 소스는 `packages/shared/src/ontology/` 이고 이 문서와 1:1 로 맞춘다.

## 원천 데이터

첫 대상 프로젝트(`tc-ocr`) 실측이다 (2026-07-22).

| 항목 | 실측값 |
| --- | --- |
| 업무 | 490건 (closed 442 / backlog 38 / working 7 / registered 3) |
| 위키 | 47건. 트리 구조라 `--parent` BFS 순회가 필요하다 |
| 댓글 | 업무당 수 건에서 수십 건 |
| 본문 | `text/x-markdown`. 업무 간 참조가 본문·댓글에 섞여 있다 |

**태그가 3차원 체계**이고 그것이 그대로 Concept 노드의 근거가 된다.

| 차원 | 값 |
| --- | --- |
| `0:` 유형 | Bug, Dev, Main, Survey, 배포, 장애 |
| `1:` 제품 | General, IDCard, CreditCard, DocumentAI, CarPlate, Business, Common |
| `2:` 컴포넌트 | API, Console, Admin, Env, Meter, Model, DOC, 성능테스트 |

업무당 태그는 평균 3개다. 이 값들은 프로젝트 고유이므로 다른 프로젝트를 색인하면 사전이 새로 시드된다.

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
fulltext 인덱스는 5개이고 한국어 토큰화를 위해 analyzer 를 전부 `cjk` 로 지정한다.

| 인덱스 대상 | 무엇을 찾게 하나 |
| --- | --- |
| `Task.subject`·`Wiki.subject`·`Concept.name` | 제목과 이름 |
| `Task.bodyExcerpt`·`Comment.excerpt` | 업무 본문과 댓글에 적힌 내용 |

`cjk` analyzer 는 한국어를 두 글자씩 겹쳐 쪼갠다. 그래서 띄어쓰기가 달라도 걸린다 —
`요청크기` 와 `요청 크기` 가 같은 노드를 같은 점수로 찾는다.

### 본문·댓글 텍스트 보존 규칙

검색이 닿을 수 있는 범위와 답변이 인용할 수 있는 범위가 여기서 정해진다.

| 대상 | 상한 | 전처리 |
| --- | --- | --- |
| `Task.bodyExcerpt` | 6,000자 | 없다 (원문을 그대로 자른다) |
| `Comment.excerpt` | 6,000자 | 개행을 보존해 뽑고 GitHub 훅 머리말을 벗긴다 |

상한 6,000자는 평가 세트의 필수 근거 요구 14건을 **전부** 담는 값이다 (고유 댓글은 13건 —
`comment-483-planning` 이 두 문항에서 필수라 두 번 계수된다). 길이는 470~5,061자이고,
2,000자면 10/14, 5,000자면 13/14 를 덮는다. 상한을 넘으면 잘리고,
`parse-structure` 요약이 잘린 건수를 출력한다 (tc-ocr 실측 — 본문 15건·댓글 7건).

**훅 머리말을 벗기되 댓글 자체를 버리지 않는다.** 훅 댓글 359건은 예외 없이 커밋 메시지를
달고 있고, 평가 세트가 필수 근거로 지목한 것도 그중 2건이다. 잡음은 댓글이 아니라 매번 같은
모양으로 반복되는 링크 머리말이다. 그 분량은 댓글별 비율 중앙값 58%이고 전체 문자 수 합계 기준으로는 47%다.

**벗기기는 훅 형식으로 판정된 댓글에만 적용한다.** 훅 머리말은 두 줄 고정 형태다.

```
[[<레포>](<레포 url>)] <사람> push(es) [<커밋>](<커밋 url>) to `<브랜치>`
[<제목>](<url>)
```

동사는 `pushes` 와 `push` 둘 다 나온다 (실측 359건 중 356건이 복수형, 3건이 단수형).
정규식은 `push(?:es)?` 로 쓴다 — `pushes?` 는 `pushe` 뒤의 `s` 가 선택이라는 뜻이라
정작 `push` 를 놓친다.

첫 줄이 이 모양일 때만 훅으로 보고, 이어지는 링크 전용 줄까지 벗긴다.
"앞쪽 링크 줄을 걷어낸다" 는 넓은 규칙은 쓰지 않는다. 실측 기준은 이렇다 —
첫 줄이 링크나 불릿으로 시작하는 사람 댓글이 336건이고, 그중 넓은 규칙이 실제로 내용을 깎는 것이
40건이다 (최대 699자 손실). 좁힌 규칙은 훅 359건을 전부 잡고 사람 댓글 495건은 한 건도 건드리지 않는다.

벗긴 뒤 남는 내용이 없으면 원문을 유지한다 — 정보를 잃지 않게 하는 안전 기본값이다.

**댓글 저장용 텍스트는 개행을 보존해 뽑는다.** 참조 추출이 쓰는 추출 함수는 `\s+` 를 공백
하나로 병합해 개행을 지운다. 200자만 저장할 때는 무해했지만 6,000자를 담으면 마크다운 표·목록·
헤딩이 통째로 뭉개져, 표의 행 경계가 사라지면 값을 다른 행에서 잘못 읽어 답이 틀릴 수 있다.
실측 정답 댓글의 조치 내용이 표다. 훅 머리말 판정도 개행을 전제한다 — 병합된 값을 넘기면
훅 359건이 한 건도 매칭되지 않는다.

머리말 벗기기와 개행 보존 추출은 저장하는 값에만 적용한다. 업무 참조 추출은 개행이 병합된
기존 값을 그대로 받는다. 같은 텍스트를 미리 가공해서 넘기면 `REFERENCES` 328건이 조용히 바뀐다.

규칙은 원천 JSON 이 아니라 **저장 직전 함수에 실제로 도착하는 값**을 기준으로 정한다.
원천은 두 줄이지만 추출 함수를 지나면 한 줄이 된다.

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

**출력 순서가 고정돼 있다** — 노드는 `라벨 → 키 → tie-break`, 관계는 `유형 → 시작키 → 끝키 → tie-break` 다.
tie-break 는 그 레코드를 파일에 쓸 때 실제로 쓰는 `JSON.stringify` 직렬화 결과 자체다 — 앞선 키가
모두 같은 동순위 레코드(예: 식별 속성만 다른 관계)도 이 값으로 전순서가 선다.
같은 입력이면 바이트 동등해야 한다. 그게 별칭 변경 전후를 `cmp` 로 비교하는 전제다.

리포트는 `jsonl` 에 섞지 않고 별도 파일로 뺀다. 첫 줄에 메타데이터를 넣으면
읽는 쪽이 모두 그 줄을 건너뛰어야 하고, 그 규칙을 잊으면 조용히 깨진다.

형식은 이렇다.

```jsonl
{"label":"Wiki","key":"4377...","properties":{"pageId":"4377...","subject":"..."}}
{"type":"DOCUMENTS","startKey":"4377...","endKey":"ingress-nginx","properties":{"startLabel":"Wiki","endLabel":"Concept"}}
```

관계의 `startKey`·`endKey` 는 라벨 없이 **키만** 담는다. 끝점 라벨은
`properties.startLabel`·`properties.endLabel` 로 따로 들어간다.

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

그래서 자동 병합을 하지 않는다. 고빈도 Concept 만 후보로 뽑아 사람이 확인한 뒤 판단으로 등록한다.

## 판단 저장소 (관계형)

이 절은 ADR 0005가 채택한 현재 스키마다.
사람이 내린 Concept 동일성 판단과 프로젝트·소스 등록을 담는다.
자동 생성되는 사전과 **분리해서** 둔다 — 섞으면 재생성이 판단을 지운다.
결정 배경은 [ADR 0005](adr/0005-curation-in-relational-store.md) 다.

| 표 | 소유 | 키·제약 |
| --- | --- | --- |
| `project` | 프로젝트 등록 | `code` 유일 |
| `source` | 프로젝트에 붙는 원천 (Dooray·GitHub) | `(kind, external_key)` 유일. 한 소스는 한 프로젝트에만 붙는다 |
| `concept_decision` | 판단 한 건 | `(project_id, key_norm)` 유일 |

컬럼 계약이다.

| 표 | 컬럼 |
| --- | --- |
| `project` | `id serial primary key`<br>`code text not null unique`<br>`name text`<br>`created_at timestamptz not null default now()` |
| `source` | `id serial primary key`<br>`project_id integer not null references project(id) on delete cascade`<br>`kind text not null check (kind in ('dooray', 'github'))`<br>`external_key text not null`<br>`created_at timestamptz not null default now()`<br>`unique (kind, external_key)` |
| `concept_decision` | `id serial primary key`<br>`project_id integer not null references project(id) on delete cascade`<br>`key_raw text not null`<br>`key_norm text not null`<br>`kind text not null check (kind in ('merge_alias', 'block'))`<br>`canonical text`<br>`reason text not null`<br>`approved_at date`<br>`created_at timestamptz not null default now()`<br>`unique (project_id, key_norm)`<br>`check ((kind = 'merge_alias') = (canonical is not null))` |

`concept_decision` 의 종류는 두 가지다.

- `merge_alias` — 이 표기는 `canonical` 과 같은 개체다
- `block` — 이 표기는 자동 병합 대상이 아니다

설계 근거 네 가지다.

- **`(project_id, key_norm)` 유일성이 이 표의 존재 이유다.**
  "한 표기는 최대 하나의 판단에만 지배된다" 를 뜻한다.
  지금 이 위반이 **적재 도중 예외**로 드러나는데, 제약으로 옮기면 등록이 거부된다
- **제약을 정규화된 키에 건다.** 충돌은 원문이 아니라 정규화된 형태에서 일어난다.
  원문은 사람이 읽기 위해 함께 보관한다
- **별칭 1:N 을 배열 컬럼으로 넣지 않는다.** 별칭 하나가 행 하나이고 `canonical` 로 묶인다
- **판단은 프로젝트에 붙인다.** 소스 단위로 쪼개면 같은 표기가 한 소스에서는 합쳐지고
  다른 소스에서는 안 합쳐져 그래프가 자기모순이 된다

삭제는 `project` 에서 하위로 흐른다 (`on delete cascade`).
소스나 판단만 지워도 그래프는 변하지 않는다 — 반영은 재적재로만 일어난다.

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

세 명령 모두 같은 `NEO4J_URI`를 가리켜야 한다.
각 명령은 값이 없으면 기본 대상에 붙지 않고 실행을 거부한다.
명령마다 다른 값을 인라인으로 주면 비우려던 그래프와 실제로 적재되는 그래프가 어긋나므로,
한 절차에서는 `export NEO4J_URI=...`로 대상을 고정한다.

`reset-neo4j` 는 `DETACH DELETE` 절차에 이름을 준 명령이다.

- `NEO4J_URI` 가 없으면 실행하지 않는다 — 삭제 대상을 항상 명시적으로 지정하게 만든다.
  네 Neo4j 명령의 공통 규칙이며, 이 명령에는 아래의 삭제 전용 확인도 더 붙는다
- `--force` 없이는 실행하지 않는다
- 대상 포트가 운영(`7687`)이면 `--allow-production` 도 함께 줘야 한다
- 대상 URI 와 현재 노드 수를 먼저 출력한다
- **삭제 범위는 전체다.** 프로젝트 단위 삭제는 만들지 않는다 —
  `Task.number` 가 프로젝트를 구분하지 않아 부분 삭제가 안전하지 않다 (위 "key 설계의 함정" 참조)

**Neo4j를 쓰는 네 명령은 모두 `NEO4J_URI`를 필수로 요구한다.**
`sync-neo4j`·`apply-schema`·`audit-concepts`·`reset-neo4j`가 조용히 운영 기본값을 고르는 일을 막고,
읽기·쓰기 대상을 호출자가 명시하게 한다.
그중 `reset-neo4j`는 `DETACH DELETE`를 실행하므로 `--force`와 운영 포트 추가 확인까지 요구한다.
위 "key 설계의 함정"이 기록한 대로 `Task.number`가 프로젝트를 구분하지 않아,
잘못된 그래프에 삭제를 실행하면 되돌릴 수 없기 때문이다.

`DETACH DELETE` 는 제약·인덱스를 지우지 않는다. 다만 재적재 절차에 `apply-schema` 를 넣어 둔다.

산출물 `jsonl` 이 남아 있으므로 **초기화 후 재적재로 정확히 복원된다** (실측: 노드 3,088 동일 복원).
LLM 캐시가 있어 추출 재실행은 불필요하다.

## 평가 gold 의 구조

평가 세트는 `eval/suites/`에 저장한다.
질문만 있는 기존 은행은 보존하고, 대표 업무 흐름처럼 회귀 기준으로 쓸 문항은 원천 근거와 함께 세트로 승격한다.

세트 최상위에는 다음 값을 둔다.

| 필드 | 의미 |
| --- | --- |
| `schemaVersion` | 형식 변경을 구분하는 버전 |
| `project` | 원천 프로젝트 |
| `flowId` | 대표 업무 흐름의 안정된 식별자 |
| `title` | 사람이 읽는 흐름 이름 |
| `sourceSnapshot` | gold를 확인한 원천 적재 시점 |
| `questions` | 평가 문항 목록 |

각 문항은 다음 계약을 따른다.

| 필드 | 의미 |
| --- | --- |
| `id` | 세트 안에서 안정된 문항 식별자 |
| `audience` | `human` 또는 `ai` |
| `difficulty` | `L1`부터 `L5` |
| `question` | `/api/query`에 보낼 자연어 질문 |
| `answerability` | `answerable` 또는 `insufficient-source` |
| `sourceRefs` | 정답을 확인한 업무·댓글·위키 식별자 |
| `graphChecks` | 검색 전 `/api/graph/samples?label=<Task\|Comment>&offset=<n>&limit=100`와 이웃 조회로 확인할 노드·관계 |
| `requiredEvidence` | 전부 검색돼야 하는 근거 식별자 |
| `supportingEvidence` | 답을 보강하는 근거 식별자 |
| `orderedEvents` | 순서가 중요한 근거 식별자 배열 |
| `expectedClaims` | 원천이 직접 지지하는 핵심 주장 |
| `forbiddenClaims` | 원천에 없는 인과·동일성 주장 |

`answerability=insufficient-source`인 문항은 `requiredEvidence`를 요구하지 않는다.
대신 답변이 근거 부족을 명시하고 `forbiddenClaims`를 만들지 않아야 통과한다.

`sourceRefs`의 그래프 기준 노드는 fulltext 검색이 아니라 라벨별 샘플 페이지에서 찾는다.
`type=post`는 `Task` 라벨과 업무 번호 문자열 key를,
`type=comment`는 `Comment` 라벨과 댓글 id 문자열 key를 정확히 비교한다.
`/api/graph/search`는 fulltext 검색 전용이라 숫자 key 해석에 쓰지 않는다.
제목·이름뿐 아니라 업무 본문과 댓글도 검색하므로 `Comment` 노드가 결과에 섞여 나온다.

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

## 평가 실행 결과

원시 실행 결과는 `eval/runs/`에 두고 커밋하지 않는다.
조직 내부 원문과 질의 응답 전문이 들어갈 수 있기 때문이다.
비교에 필요한 요약만 `eval/reports/`에 JSON과 Markdown으로 함께 남긴다.

원시 결과는 다음 실행 조건을 고정한다.

- 대상 커밋과 단계 이름
- 평가 세트 경로와 내용 해시
- API 기준 URL
- 호출자가 선언한 질의 모델 표기
- 반복 횟수
- 문항·회차별 시작 시각, 지연 시간, HTTP 상태, `answer`·`evidence`·`cypher`

API는 실제 모델 식별자를 응답하지 않는다.
따라서 모델 표기는 호출자가 실행 조건으로 선언한 값이며, 서버가 증명한 값처럼 취급하지 않는다.

요약 결과는 문항마다 다음 판정을 분리한다.

- 결정적 검사 결과
- 두 독립 의미 판정 결과
- 반복 간 안정성
- 최종 `PASS`, `FAIL`, `REVIEW`
- 실패 경계인 `SOURCE`, `GRAPH`, `RETRIEVAL`, `ANSWER`

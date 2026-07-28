# gold 도달성 검사 — 데이터에 근거가 있는 gold 인가

작성 2026-07-28. 분석 전용 리포트다. gold 파일은 고치지 않았다.

## 요약

질문 은행 34문항 전체를 검사했다.
`gold.required` 와 `gold.supporting` 에 적힌 노드가 질문이 요구하는 관계로 그래프에서 도달 가능한지 확인했다.

| 분류 | 건수 | 문항 |
| --- | --- | --- |
| 1 도달 가능 | 25 | A-01~A-05, A-11~A-14, A-16, H-01~H-06, H-08~H-11, H-13~H-16, H-18 |
| 2 관계·표기 불일치 | 5 | A-07, A-08, A-09, A-15, H-07 |
| 3 근거 없음 | 4 | A-06, A-10, H-12, H-17 |

3번은 다시 두 갈래로 나뉜다.

| 하위 분류 | 뜻 | 문항 |
| --- | --- | --- |
| 3a 추출 누락 | 원천 데이터에 단서가 있는데 추출이 만들지 않았다. 고칠 수 있다 | H-17 |
| 3b 원천 부재 | 원천 Dooray 본문에도 그 연결이 없다. 검색·추출로는 못 푼다 | A-06, A-10, H-12 |

가장 중요한 결론이다.
**조정자가 지목한 A-06·H-12 외에 A-10 이 같은 유형이었다.**
A-10 은 Task 501 과 502 사이 엣지를 전제하는데, 두 업무가 서로를 참조한 적이 없다.

## 검사 방법

운영 Neo4j(`bolt://localhost:7687`, ssh 터널)에 읽기 전용으로 접속해 조회했다.
쓰기 구문(`CREATE`·`MERGE`·`DELETE`·`SET`)은 스크립트 차원에서 차단했다.

검사 순서는 셋이다.

1. gold 에 적힌 노드가 존재하는지 확인한다 (Task 43개, Wiki 9개, Concept·Person 9개).
2. 질문이 지정한 관계로 그 노드에 도달하는지 확인한다.
3. 2번이 실패하면 추출 산출물(`structural.jsonl`·`llm.jsonl`)과 원천 Dooray 본문(`data/raw/tc-ocr/posts/*.json`)을 확인한다.

### 1단계 — 노드 존재

```cypher
WITH [1,26,63,76,81,82,83,86,89,206,396,420,433,435,441,442,446,448,450,478,
      481,482,483,485,486,487,489,491,492,493,494,495,496,497,498,499,500,
      501,502,504,505,506,507] AS nums
UNWIND nums AS n
OPTIONAL MATCH (t:Task {number:n})
RETURN n, t.subject, t.createdAt
```

Task 43개 전부 존재한다.
Wiki 9개도 제목 완전일치로 전부 존재한다.

Concept·Person 은 두 건이 빠졌다.

```cypher
WITH ['General','API Gateway','ingress-nginx','CloudTrail','OCR.API','장애',
      'DocumentIdCardAuthenticityService:82','ExceptionController:45','김병태'] AS names
UNWIND names AS n
OPTIONAL MATCH (c:Concept {name:n})
OPTIONAL MATCH (p:Person {name:n})
RETURN n, c.name, p.name
```

- `API Gateway` — 없다. 대신 `api gateway`(연결 9), `OCR API Gateway`(연결 37), `Gateway`(연결 12)가 있다
- `ExceptionController:45` — 없다. 대신 `exceptioncontroller.java:45` 가 있다

### 2단계 — 관계 도달

문항마다 질문이 지정한 관계를 그대로 Cypher 로 옮겼다.
대표 쿼리는 아래 문항별 표의 근거 열에 적었다.

### 3단계 — 원천 확인

```bash
grep -o "491" 483.json | wc -l     # 0
grep -o "483" 491.json | wc -l     # 1 (내부 id 일부, 업무 참조 아님)
grep -o "501" 502.json | wc -l     # 0
grep -o "502" 501.json | wc -l     # 0
```

`491.json` 의 "483" 1건은 조직 멤버 id 문자열의 일부였다.
업무 참조가 아니다.

## 문항별 결과 — AI 은행 16문항

| id | 분류 | 근거 |
| --- | --- | --- |
| A-01 | 1 도달 가능 | `groundTruthCypher` 실행 성공. 483 workflowClass=working, 담당 6명(김병태 포함) |
| A-02 | 1 도달 가능 | Wiki 존재, `CHILD_OF` 부모 = "OCR 지식 정리 (brain 이관)" |
| A-03 | 1 도달 가능 | `MATCH (t:Task)-[:TAGGED]->(:Concept {name:'General'}) RETURN count(t)` → 60 |
| A-04 | 1 도달 가능 | `groundTruthCypher` 실행 성공 |
| A-05 | 1 도달 가능 | `groundTruthCypher` 실행 성공 |
| A-06 | **3b 근거 없음** | 아래 "3번 상세" 참조 |
| A-07 | **2 관계 유형 불일치** | Task 494·495·496 은 `MENTIONS` 로 붙는다. 그런데 Wiki "ingress-nginx 컨트롤러를 여러 개 둘 때 격리하는 법" 은 `DOCUMENTS` 로만 붙는다 |
| A-08 | **2 표기 불일치** | 483 은 `ASSIGNED_TO` 김병태 이고 `MENTIONS` `api gateway` 다. 질문이 지정한 `API Gateway` 는 이름이 정확히 일치하는 Concept 이 없다 |
| A-09 | **2 표기 불일치** | `(:Decision)-[:AFFECTS]->(:Concept {name:'api gateway'})` 이고 `DECIDED_IN` 483, `EVIDENCED_BY` Comment 가 있다. 역시 `API Gateway` 대소문자만 다르다 |
| A-10 | **3b 근거 없음** | 아래 "3번 상세" 참조 |
| A-11 | 1 도달 가능 | `OCR.API` 가 `DEPENDS_ON` 으로 40건 연결. Wiki "NCS 모델 L4 LB 커넥션 토폴로지와 OCR.API 커넥션 풀" 이 `MENTIONS`·`DOCUMENTS` 양쪽으로 붙는다 |
| A-12 | 1 도달 가능 | `groundTruthCypher` 실행 성공. 다만 결과가 `General` 2건뿐이다 (아래 "곁가지 발견" 참조) |
| A-13 | 1 도달 가능 | `groundTruthCypher` 실행 성공 |
| A-14 | 1 도달 가능 | 필수 26·83·206·481 전부 `MENTIONS CloudTrail` 로 도달. 단 같은 경로에 32건이 더 붙어 있다 |
| A-15 | **2 관계 유형 불일치** | 497 은 `RELATES_TO {kind:'precedes'}` 로 499 를 선행한다. 500 은 `RELATES_TO {kind:'follows-up'}` 방향 500→499 로만 붙어 질문이 지정한 `precedes` 와 어긋난다 |
| A-16 | 1 도달 가능 | `groundTruthCypher` 실행 성공. 결과는 2026년 2건뿐이다 |

A-07 의 대표 쿼리다.

```cypher
MATCH (x)-[r:MENTIONS|DOCUMENTS]->(c:Concept {name:'ingress-nginx'})
RETURN labels(x), type(r), coalesce(x.number, x.subject)
```

A-15 의 대표 쿼리다.

```cypher
MATCH (t:Task {number:499})-[r:RELATES_TO|REFERENCES]-(o:Task)
RETURN type(r), r.kind, startNode(r).number, endNode(r).number
```

## 문항별 결과 — human 은행 18문항

| id | 분류 | 근거 |
| --- | --- | --- |
| H-01 | 1 도달 가능 | Wiki 제목 완전일치 존재 |
| H-02 | 1 도달 가능 | 483 `ASSIGNED_TO` 김병태 |
| H-03 | 1 도달 가능 | Wiki 와 Task 478 이 Concept `X-Request-Id`·`OCR.API` 를 공유한다 |
| H-04 | 1 도달 가능 | Wiki 가 Concept `NHN Cloud Log & Crash` 를 `MENTIONS`·`DOCUMENTS` 양쪽으로 붙는다 |
| H-05 | 1 도달 가능 | Wiki 와 보강 Task 485·487·507 이 각각 공통 Concept 을 가진다 |
| H-06 | 1 도달 가능 | Concept `부하테스트` 는 없지만 499·500 제목에 "부하테스트" 가 있어 `task_subject_fulltext` 로 도달한다 |
| H-07 | **2 표기 불일치** | 아래 "H-07 상세" 참조 |
| H-08 | 1 도달 가능 | 501 `a100 mig 2g.10gb`, 502 `mig`·`gpu`, 500 `oomkilled`, 482 `gpu node` 로 각각 도달 |
| H-09 | 1 도달 가능 | `expectedFacts` 두 건이 Decision.summary 에 그대로 있다 — "Remove API Gateway from the OCR service to lift API Gateway data transfer size limits and improve OCR usability", "…because removing API Gateway alone does not solve the 5MB issue" |
| H-10 | 1 도달 가능 | 495 와 Wiki 가 Concept `ingress-nginx`·`LoadBalancer`·`OCR API Gateway` 를 공유한다 |
| H-11 | 1 도달 가능 (보강은 미달) | 필수 485·486 은 `TAGGED 장애` 로 도달한다. 보강 487·489·491·482 는 장애 태그가 없다 (아래 "곁가지 발견" 참조) |
| H-12 | **3b 근거 없음** | 아래 "3번 상세" 참조 |
| H-13 | 1 도달 가능 | Task 1 제목 "[OCR] 서비스 출시 기획서 및 중요 문서" 로 `task_subject_fulltext` 도달 |
| H-14 | 1 도달 가능 | Wiki "미터링 & 클라우드트레일" 과 Task 450 이 Concept `Metering`·`OCR` 를 공유한다 |
| H-15 | 1 도달 가능 (경로 약함) | 필수 433 은 `gpu 메모리 oom` 으로 도달한다. 435 는 OOM 계열 Concept 이 하나도 없고 제목의 "GPU OOM" 으로만 도달한다 |
| H-16 | 1 도달 가능 | Task 81 이 Concept `인터셉터` 를 가진다. `expectedFacts` 는 제목·본문 발췌에 있다 |
| H-17 | **3a 근거 없음(추출 누락)** | 아래 "3번 상세" 참조 |
| H-18 | 1 도달 가능 | 필수 26·396·481 전부 `MENTIONS CloudTrail` 로 도달 |

### H-07 상세 — 노드 표기가 gold 와 다르다

gold 는 Concept 두 개를 필수로 요구한다.

- `DocumentIdCardAuthenticityService:82`
- `ExceptionController:45`

그래프 실측은 이렇다.

```cypher
MATCH (c:Concept)
WHERE c.name IN ['DocumentIdCardAuthenticityService:82',
                 'documentidcardauthenticityservice.java:82',
                 'exceptioncontroller.java:45']
OPTIONAL MATCH (x)-[r:MENTIONS|DOCUMENTS]->(c)
RETURN c.name, collect(coalesce(x.number, x.subject))
```

| Concept | 들어오는 관계 |
| --- | --- |
| `DocumentIdCardAuthenticityService:82` | 없음 (고아) |
| `documentidcardauthenticityservice.java:82` | Task 492 |
| `exceptioncontroller.java:45` | Task 493 |

gold 표기와 이름이 같은 Concept 이 존재하기는 하지만 아무 것도 붙어 있지 않다.
실제로 쓰이는 노드는 소문자에 `.java` 가 붙은 별개 노드다.
`ExceptionController:45` 는 어떤 표기로도 존재하지 않는다.

**이것은 관계 이름 문제가 아니라 노드 이름 문제다.**
같은 코드 위치가 두 이름으로 파편화됐고 gold 는 쓰이지 않는 쪽을 가리킨다.

## 3번(근거 없음) 상세

### A-06 — Task 483 과 491 사이 엣지가 없다

```cypher
MATCH (t:Task {number:483})-[r]-(o:Task)
RETURN type(r), r.kind, startNode(r).number, endNode(r).number
```

483 에 붙는 Task 는 494·495·496·497·498·499·504·505·506 과 17·24·25·30·31·32·404 다.
491 은 없다.

491 쪽에서 봐도 같다.

```cypher
MATCH (t:Task {number:491})-[r]-(o) RETURN type(r), labels(o)
```

491 은 Task-Task 관계가 **하나도 없다**.
Concept·Person·Comment·Project·Decision 에만 붙는다.

추출 산출물에도 없고 원천 본문에도 없다.
조정자의 실측과 일치한다.

확신도는 **높다**. 그래프·추출·원천 세 층 모두 확인했다.

### A-10 — Task 501 과 502 사이 엣지가 없다 (새로 발견)

gold.required = [501, 502] 이고 질문은 "501 과 RELATES_TO 로 이어지는 후속 Task" 를 요구한다.

```cypher
MATCH (t:Task {number:501})-[r:RELATES_TO|REFERENCES]-(o:Task)
RETURN type(r), r.kind, startNode(r).number, endNode(r).number
```

| 출발 | 관계 | 도착 |
| --- | --- | --- |
| 501 | `RELATES_TO {kind:'follows-up'}` | 487 |
| 501 | `RELATES_TO {kind:'follows-up'}` | 454 |

502 도 똑같이 487·454 로만 붙는다.
501 과 502 는 **같은 두 업무를 가리키는 형제일 뿐 서로 연결돼 있지 않다.**

원천 본문에도 상호 참조가 없다 (`501` 과 `502` grep 각 0건).
추출 산출물에도 없다.

다만 두 업무는 Concept 6개를 공유한다 — `amp fp16`, `convnext-xl`, `dbnetpp`, `mmdeploy`, `General OCR`, `OCR.General`.
사람이 "후속" 이라고 읽는 근거는 제목("AMP 외 후속 검토 후보")과 공유 개념이다.

확신도는 **높다**. A-06 과 같은 방식으로 세 층 모두 확인했다.

### H-12 — 491 → 483 순서 엣지가 없다

gold.note 가 요구하는 순서는 `491(장애) → 483(제거 결정) → 498(등가성 검증)` 이다.

- `483 ↔ 498` — 있다 (`REFERENCES` 양방향, `RELATES_TO {kind:'follows-up'}` 498→483)
- `491 → 483` — 없다 (A-06 과 같은 근거)

즉 세 단계 사슬의 **첫 고리가 끊겨 있다.**
483→498 만으로는 "장애가 원인이었다" 는 인과를 답할 수 없다.

확신도는 **높다**.

### H-17 — 2021 성능테스트와 2026 부하테스트를 잇는 경로가 없다

gold.required = [63, 499], gold.note 가 `2021 → 2026` 시간순을 요구한다.

```cypher
MATCH (c:Concept)
WHERE c.name CONTAINS '성능' OR c.name CONTAINS '부하'
   OR toLower(c.name) CONTAINS 'k6'
RETURN c.name, [(x)-[:MENTIONS|TAGGED|DOCUMENTS]->(c) | coalesce(x.number, x.subject)]
```

| Concept | 붙는 노드 |
| --- | --- |
| `성능테스트` | Task 63·69·76·265·381·387·416·418·419, Wiki "OCR 개발 컨벤션…" |
| `k6` | Task 497·499, Wiki 3건 |

`부하테스트` 라는 Concept 은 **존재하지 않는다.**
Task 499·500 이 가진 Concept 을 전부 확인해도 성능·부하 계열이 없다.

```cypher
MATCH (a:Task)-[r:REFERENCES|RELATES_TO]-(b:Task)
WHERE a.number IN [63,76] AND b.number IN [499,500]
RETURN a.number, type(r), b.number
```

결과 0행. Task-Task 엣지도 없다.

**A-06·A-10·H-12 와 다른 점이 여기다.**
원천 본문에는 단서가 명확하게 있다.

```bash
grep -o "부하테스트" 499.json | wc -l   # 14
grep -o "부하테스트" 500.json | wc -l   #  8
grep -o "성능 테스트\|성능테스트" 63.json # 5
```

추출이 499·500 에서 "부하테스트" 를 Concept 으로 만들지 않았을 뿐이다.
추출 프롬프트나 사전 별칭(`부하테스트` → `성능테스트`)으로 고칠 수 있다.

확신도는 **높다** — 다만 "근거 없음" 이 아니라 "추출 누락" 으로 읽어야 한다.

## 3번 문항 선택지 비교

어떤 것도 실행하지 않았다. 사람이 정할 사안이다.

### 공통 선택지 — A-06·A-10·H-12 (원천 부재 3건)

| 선택지 | 장점 | 단점 |
| --- | --- | --- |
| (a) 해당 항목을 `required` 에서 `supporting` 으로 낮춘다 | gold 파일만 고치면 된다. 사람이 아는 인과를 기록으로 남긴다. 보강은 비율 기준이라 일부 누락을 허용한다 | 보강 비율(인수 ≥ 60%)에 여전히 영향을 준다. A-06 은 보강이 0개라 새로 만들어야 한다 |
| (b) 해당 항목을 gold 에서 완전히 뺀다 | 판정이 즉시 깨끗해진다. 검색·추출을 아무리 고쳐도 못 푸는 문항이 사라진다 | 사람이 아는 인과가 문서에서 사라진다. 나중에 데이터가 보강되면 다시 넣어야 한다 |
| (c) 질문 문구를 데이터에 있는 관계로 바꾼다 | 문항 수를 유지하면서 실제 검색 능력을 계속 측정한다 | 질문이 쉬워진다. 기준선 문항과 비교가 끊긴다 |
| (d) 추론 관계를 새로 만들어 그래프에 넣는다 | 사람이 아는 인과를 그래프가 표현하게 된다. 다른 문항도 함께 좋아질 수 있다 | 오탐 위험이 크다. 아래 별도 검토 |

문항별로 (c) 를 적용하면 이렇게 된다.

| 문항 | 현재 질문 | (c) 로 바꾼 예 |
| --- | --- | --- |
| A-06 | "483 과 `REFERENCES`·`RELATES_TO` 로 연결된 Task" | 그대로 두고 gold 를 483·498(+494~499·504~506)로 조정한다 |
| A-10 | "501 과 `RELATES_TO` 로 이어지는 후속 Task" | "501·502 가 공통으로 `MENTIONS` 하는 Concept 과 두 Task 가 공유하는 선행 Task" |
| H-12 | "제거 결정부터 공인 진입점 전환까지 시간순" | "483 제거 결정부터 공인 진입점 전환까지 시간순" (491 장애를 시작점에서 뺀다) |

### (d) 추론 관계를 만들 때 — 어떤 규칙이면 오탐이 없나

세 가지 축을 검토했다.

| 규칙 후보 | 483↔491 을 잡나 | 오탐 위험 | 판단 |
| --- | --- | --- | --- |
| 시간 근접만 (예: 30일 내) | 잡는다 (5/27 대 6/24, 28일차) | **매우 크다**. 같은 기간 무관한 업무가 전부 엮인다 | 쓸 수 없다 |
| 공통 Concept 개수만 (예: 3개 이상) | 잡는다 (6개 공유) | **크다**. `OCR`·`NHN Cloud` 같은 광범위 Concept 이 거의 모든 쌍을 3개 이상으로 만든다 | 쓸 수 없다 |
| 저빈도 공통 Concept, 같은 태그 축, 시간 근접을 모두 요구 | 검증 필요 | 중간 | 유일하게 검토할 만하다 |

세 번째를 구체화하면 이런 형태다.

- 두 Task 가 공유하는 Concept 중 **연결 수가 낮은 것**(예: 전체 연결 20 이하)이 2개 이상이다
- 두 Task 의 `1:` 차원 태그(제품)가 같다
- 생성 시각 차이가 60일 이내다
- 관계 이름을 기존 것과 섞지 않는다 — 예를 들어 `INFERRED_RELATES_TO` 로 분리하고 `inferenceRule` 속성에 규칙 이름을 남긴다

부작용은 넷이다.

1. **G 축(그래프 정합)이 자기 검증에 빠진다.** 추론 엣지를 근거로 답하고 그 엣지를 Cypher 로 재현하면 항상 통과한다. `EVAL-RUBRIC.md` 의 S2a 문제와 같은 구조다
2. **앵커 경쟁이 악화된다.** 엣지가 늘면 근거 후보가 늘어 `ANCHOR_CANDIDATE_LIMIT` 안에서 정답이 밀려날 수 있다
3. **S6(근거 추적) 100% 조건을 어떻게 맞출지 정해야 한다.** 추론 엣지는 출처 문서가 하나가 아니다
4. **적재기가 MERGE 전용이라 규칙을 바꿔도 옛 추론 엣지가 남는다.** 규칙 조정 때마다 초기화 후 재적재가 필요하다

483↔491 로 검증한 결과다.
공유 Concept 6개 중 `Metering`·`api gateway` 는 연결 수가 낮고, `OCR`·`NHN Cloud`·`General OCR`·`OCR.API` 는 광범위하다.
`1:` 차원 태그는 483 이 `Common`, 491 이 `Common` 으로 같다.
시간 차이는 28일이다.
**즉 위 규칙이면 483↔491 을 잡는다.** 다만 같은 규칙이 다른 쌍 몇 개를 잘못 잡는지는 측정하지 않았다 — 규칙을 채택하기 전에 전수 측정이 필요하다.

### H-17 (추출 누락) 선택지

원천에 단서가 있으므로 다른 축이다.

| 선택지 | 장점 | 단점 |
| --- | --- | --- |
| (a) 사전에 `부하테스트` → `성능테스트` 별칭을 등록한다 | 진행 중인 "사전 별칭 보강(2층)" 작업과 같은 흐름이다. 오탐 위험이 낮다 (두 표현은 실제 동의어다) | 재적재가 필요하다. 499·500 이 `성능테스트` Concept 을 얻으려면 추출도 그 용어를 뽑아야 한다 |
| (b) 추출 프롬프트에 테스트 유형 용어를 명시한다 | 앞으로 들어오는 데이터에도 적용된다 | 추출 재실행이 필요하다 (캐시가 있어 비용은 낮다). 다른 Concept 분포에 영향을 줄 수 있다 |
| (c) gold 를 63·76 만으로 좁힌다 | 즉시 통과한다 | 질문의 "그동안" 이라는 시간 범위 요구가 사라진다. 문항 가치가 크게 떨어진다 |

권고 우선순위를 굳이 매기면 (a) 와 (b) 를 함께 하는 쪽이다.
다만 이 판단도 사람이 정한다.

## 2번(관계·표기 불일치) 5건 — DOCUMENTS 개선으로 풀리는 것과 아닌 것

| 문항 | 불일치 유형 | DOCUMENTS 개선으로 풀리나 |
| --- | --- | --- |
| A-07 | Wiki 가 `MENTIONS` 대신 `DOCUMENTS` 로만 붙는다 | **풀린다** |
| A-08 | Concept 이름 대소문자 (`API Gateway` 대 `api gateway`) | 안 풀린다 |
| A-09 | 같은 대소문자 문제 | 안 풀린다 |
| A-15 | `RELATES_TO` 의 `kind` 값 (`precedes` 대 `follows-up`) 과 방향 | 안 풀린다 |
| H-07 | Concept 노드 이름 파편화 (`ExceptionController:45` 대 `exceptioncontroller.java:45`) | 안 풀린다 |

풀리는 것 1건, 안 풀리는 것 4건이다.

안 풀리는 4건은 세 갈래로 다시 나뉜다.

- **대소문자 (A-08·A-09)** — Cypher 생성 규칙에서 Concept 이름을 대소문자 무시로 매칭하면 풀린다. 질의 쪽 수정이다
- **관계 kind (A-15)** — 500 과 499 의 선후 관계를 추출이 거꾸로 판단했다. `follows-up` 500→499 는 "500 이 499 의 후속" 을 뜻하는데 500 의 제목은 "부하테스트 사전 조건" 이다. 추출 쪽 수정이거나, 질문에서 `kind` 지정을 빼는 쪽이다
- **노드 이름 파편화 (H-07)** — `ExceptionController:45` 와 `exceptioncontroller.java:45` 를 같은 개체로 볼 규칙이 필요하다. `.java` 접미어를 떼는 정규화는 `CLAUDE.md` 가 말하는 "남은 파편화" 유형이고 자동 병합이 위험한 영역이다. gold 표기를 그래프에 맞추는 쪽이 더 안전할 수 있다

## 곁가지 발견

검사 중에 gold 도달성과 별개로 눈에 걸린 것들이다.
이 작업 범위 밖이라 조사만 하고 손대지 않았다.

### REFERENCES 엣지의 3분의 1이 잘못됐다

`structural.jsonl` 의 `REFERENCES` 786건을 분석했다.

| 항목 | 건수 | 비율 |
| --- | --- | --- |
| 전체 | 786 | 100% |
| 자기 참조 (`startKey == endKey`) | 202 | 26% |
| `project` 가 `tc-ocr` 아님 | 258 | 33% |

`project` 값 분포를 보면 파싱이 깨진 것이 드러난다.

```
pull 52, images 44, 7 28, CV-OCR 19, 4 11, 1 10, 5 8,
issues 7, 3 5, AIService 5, 0 5, 10 3, com 3, HTTP 3, 11 3
```

`pull`·`images`·`issues`·`com`·`HTTP` 는 프로젝트 코드가 아니다.
URL 을 업무 참조로 잘못 읽은 결과다.
실제 사례로 Task 483 은 이런 엣지를 갖고 있다.

| 엣지 | project 값 |
| --- | --- |
| 483 → 30 | `pull` |
| 483 → 31 | `pull` |
| 483 → 32 | `pull` |
| 483 → 404 | `HTML` |
| 483 → 24 | `7` |
| 483 → 17 | `07` |
| 483 → 25 | `0` |

이 7건은 GitHub PR 링크나 날짜 문자열에서 만들어진 가짜 엣지로 보인다.
A-06 처럼 `REFERENCES` 를 직접 요구하는 질문에서는 **답에 가짜 업무 번호가 섞인다** — P(무환각)·G(그래프 정합) 축에 직접 영향을 준다.
자기 참조 202건도 답에 자신을 포함시켜 노이즈가 된다.

### 장애 태그가 2건뿐이다

`0: 장애` 태그(id `4347303825597023868`)를 가진 업무는 원천에서 485·486 둘뿐이다.

```bash
grep -l "4347303825597023868" *.json   # 485.json 486.json
```

그래프가 놓친 것이 아니라 원천이 그렇다.
결과로 A-12·A-16 은 `groundTruthCypher` 가 돌아 "통과" 하지만 답이 각각 1행·1행이다.
H-11 의 보강 4건(487·489·491·482)도 이 태그로는 모을 수 없다.

"굵직한 장애" 를 태그로 모으는 전제가 데이터에 아직 서 있지 않다.

### OOM Concept 이 7개로 파편화됐다

`oom`, `gpu 메모리 oom`, `cpu memory oom`, `gpu memory oom`, `cuda oom`, `oomkilled`, `gpu oom` 이 각각 별개 노드다.
어느 하나를 앵커로 잡아도 H-15 의 필수 433·435 를 함께 덮지 못한다.
`CLAUDE.md` 가 말하는 "사전 별칭 보강(2층)" 의 좋은 후보다.

### Decision.summary 가 영어다

Task 483 에 붙은 Decision 8건의 `summary` 가 전부 영어 문장이다.
H-09 의 `expectedFacts` 는 이 영어 문장에 담겨 있어 도달 자체는 된다.
다만 한국어 질문에 한국어로 답할 때 이 문장을 인용·번역하는 단계가 하나 더 필요하다.

### Decision 노드에 statement·rationale 속성이 없다

`keys(d)` 는 `id`·`summary`·`sourceDocId` 뿐이고 일부만 `decidedAt` 을 갖는다.
A-09 가 요구하는 "출처 문서 id" 는 `sourceDocId` 로 있다.
`decidedAt` 이 없는 Decision 은 시간순 정렬(H-12 유형)에 쓸 수 없다.

## 검사에 쓴 도구

읽기 전용 조회 스크립트를 임시 디렉터리에 만들어 썼다.
쓰기 구문은 실행 전에 정규식으로 차단했다.

```js
if (/\b(create|merge|delete|set|remove|drop)\b/i.test(cypher)) throw new Error('write blocked');
```

드라이버는 `apps/api/node_modules/neo4j-driver` 를 썼고 접속 정보는 `.env` 에서 읽었다.
Neo4j 에 쓰기는 하지 않았다.
API 는 기동하지 않았고 질의 평가도 돌리지 않았다.

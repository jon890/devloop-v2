# Concept 사전 별칭 보강 후보 (2층)

- 작성일: 2026-07-28
- 대상: 운영 Neo4j (`bolt://localhost:7687`) 의 `Concept` 노드 974종
- 성격: **분석·제안 전용**. 코드·사전·그래프를 고치지 않았다 (조회 Cypher 만 실행했다)

Concept 정규화 1층(표기 정규화)이 끝난 뒤 남은 파편화를 사람이 판단할 수 있는 후보 목록으로 정리했다.
자동 병합은 하지 않는다. 아래 표를 사람이 확인해 사전 별칭으로 등록하는 것이 다음 단계다.

## 1. 선정 기준과 임계값

### 1.1 참조 수 임계값 — 5건 이상

참조 수는 `(:Task|:Wiki|…)-[:MENTIONS|TAGGED]->(:Concept)` 의 **서로 다른 출처 노드 수**로 셌다.

| 임계값 | Concept 종수 | 포함 참조 건수 | 전체 참조 대비 |
| --- | --- | --- | --- |
| 전체 | 974 | 5,498 | 100% |
| 3건 이상 | 192 | 4,595 | 83.6% |
| **5건 이상** | **122** | **4,358** | **79.3%** |
| 10건 이상 | 76 | 4,051 | 73.7% |

5건을 임계값으로 정한 근거는 세 가지다.

- 상위 122종(12.5%)이 전체 참조의 79.3%를 덮는다. 병합 효과가 나오는 구간이 여기에 몰려 있다.
- 3건으로 낮추면 종수가 192로 늘어 후보 쌍이 급증하지만 추가로 덮는 참조는 4.3%p 뿐이다.
- 10건으로 올리면 실측으로 확인된 대표 파편 `api gateway`(8건), `Gateway`(11건) 중 하나가 후보에서 빠진다.

임계값 미만이지만 승인된 그룹에 명백히 딸린 변형은 **부속 항목**으로 섹션 4에 따로 적었다.
사전에 등록할 때 함께 넣으면 되고, 단독 판단 대상은 아니다.

### 1.2 후보 쌍 생성 규칙

- 이름을 소문자화하고 `&`·`/` 를 공백으로 바꾼 뒤 공백·`.`·`_`·`-` 로 토큰을 나눈다.
- 한쪽의 토큰 집합이 다른 쪽의 부분집합이면 후보로 올린다.
- 단순 부분 문자열 겹침은 쓰지 않는다. `Document` 가 `document_recognizer_service_mgmt` 안에 들어 있다는 이유만으로 후보가 되는 것을 막기 위해서다.

이 규칙으로 참조 5건 이상 122종에서 **88쌍**이 나왔다.

## 2. 제외 규칙

88쌍 중 제외 규칙에 걸린 것을 빼고, 남은 쌍은 근거(출처 제목)를 눈으로 확인해 판정했다.

| 규칙 | 내용 | 근거 | 제외 수 |
| --- | --- | --- | --- |
| R1 네임스페이스 | 한쪽이 `X.Y` 형태의 점 표기 컴포넌트 경로다 | 추출기가 만드는 구조적 경로라 상위·하위가 설계상 다른 개체다 | 36쌍 |
| R2 코드 식별자 | 한쪽의 `kind` 가 `code-ref` 다 | 테이블·함수 이름 같은 문자 그대로의 심볼이라 개념 별칭이 아니다 | 7쌍 |
| R3 한정어 추가 | 긴 쪽이 짧은 쪽에 제품·서비스를 특정하는 한정어를 더한다 | 상위 개념과 그 하위 제품은 별개 개체다 | 근거 확인 단계에서 판정 |
| R4 일반 명사 | 짧은 쪽이 여러 맥락에 두루 쓰이는 일반 명사다 | 병합하면 무관한 출처가 대량 섞여 앵커가 더 나빠진다 | 근거 확인 단계에서 판정 |

R1·R2 는 기계적으로 걸러진다. R3·R4 는 출처 제목을 봐야 판정할 수 있어 섹션 3의 표에 개별로 적었다.

### 2.1 제외된 대표 사례

| 쌍 | 규칙 | 이유 |
| --- | --- | --- |
| `Document`(38) 대 `Document.Console`(43) | R1 | 과제문에 나온 원래 사례다. 네임스페이스 루트와 그 하위 컴포넌트다 |
| `Admin`(89) 대 `OCR.Admin`(76) | R1 | 교집합 55건으로 이미 함께 걸리지만, 점 표기 쪽은 OCR 제품 안의 Admin 으로 범위가 좁다 |
| `Document`(38) 대 `document_recognizer_service_mgmt`(5) | R2 | 뒤쪽은 DB 테이블 이름이다 |
| `OCR`(266) 대 `신용카드 OCR`(69) | R3 | `신용카드` 가 제품을 특정한다. OCR 전체와 신용카드 OCR 은 다르다 |
| `NHN Cloud`(48) 대 `NHN Cloud Log & Crash`(18) | R3 | `Log & Crash` 는 NHN Cloud 안의 별개 상품이다 |
| `Log`(44) 대 `NHN Cloud Log & Crash`(18) | R4 | `Log` 의 출처가 "Audit 로그 카테고리 구분"(Task 55), "로그성 데이터 저장 로직 제거"(Task 97) 처럼 일반 로그다 |
| `user`(17) 대 `service user`(9) | R4 | 교집합이 0건이지만 뜻이 다르다. `user` 는 서비스 이용자, `service user` 는 쿠버네티스 클러스터 신원이다 |
| `AI`(54) 대 `Document Recognizer AI`(75) | R4 | `AI` 는 여러 제품에 두루 붙는다 |
| `배포`(95) 대 `배포 Main`(5) | R3 | `배포 Main` 은 `[배포 Main] 2022년` 같은 연도별 상위 업무 라벨이다 |
| `ingress`(16) 대 `ingress-nginx`(12) | R3 | 쿠버네티스 리소스 종류와 그 컨트롤러 구현이라 별개다 |
| `Container`(20) 대 `NHN Container Service`(8) | R3 | 뒤쪽은 NCS 상품 이름이다 |
| `path`(7) 대 `context path`(6) | R3 | `context path` 는 도메인별 애플리케이션 경로라는 특정 개념이다 |

**교집합 0건이 병합 근거가 되지는 않는다.**
`user` 대 `service user` 는 교집합 0건이지만 뜻이 다르다.
교집합은 병합했을 때 얻는 효과의 크기를 보는 값이지, 같은 개체인지를 판정하는 값이 아니다.

### 2.2 기존 차단 목록과의 관계

`apps/pipeline/src/load/load.const.ts` 의 `CONCEPT_KEY_MERGE_DENYLIST` 에 두 건이 등록되어 있다.

- `analysis` — `/analysis`(API 경로) 대 `analysis`(일반 코드 참조)
- `cloudtoastcom` — `*.cloud.toast.com`(와일드카드 도메인) 대 `cloud.toast.com`(개별 호스트)

둘 다 "표기는 겹치지만 범위가 다르다"는 성격이다. 위 R3 와 같은 유형이다.
같은 성격의 쌍(`OCR` 대 `신용카드 OCR`, `NHN Cloud` 대 `NHN Cloud Log & Crash` 등)은 후보에서 뺐다.

## 3. 병합 후보

판정 대상은 R1·R2 를 통과한 45쌍이다. 근거를 확인해 **7쌍을 후보**로 남겼고, 그중 **5쌍(그룹 A·B·C)을 병합 권장**한다.
나머지 2쌍은 Document 계열의 이름 관계를 사람이 정해야 판정할 수 있어 보류로 뒀다.

교집합이 작을수록 두 Concept 이 서로 다른 출처에 붙어 있다는 뜻이고, 병합으로 열리는 경로가 크다.

### 3.1 후보 표

| # | Concept A (참조) | Concept B (참조) | 교집합 | 합집합 | 권장 | 근거 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `OCR API Gateway` (35) | `api gateway` (8) | **1** | 42 | **권장** | 양쪽 다 OCR 앞단 API Gateway 다. B 에만 Task 483·491 이 있다 |
| 2 | `OCR API Gateway` (35) | `Gateway` (11) | **2** | 44 | **권장** | B 의 출처가 전부 OCR Gateway 맥락이다. B 에만 Task 489 가 있다 |
| 3 | `Document Recognizer AI` (75) | `document recognizer` (6) | **0** | 81 | **권장** | 같은 제품의 소문자·축약 표기다. 완전 분리 상태다 |
| 4 | `Vehicle Plate Recognizer AI` (44) | `vehicle plate ocr` (6) | **0** | 50 | **권장** | 같은 제품의 개명 전후 표기다. 완전 분리 상태다 |
| 5 | `Vehicle Plate Recognizer AI` (44) | `Vehicle` (13), `Plate` (9) | 3 / 2 | 61 | **권장** | 두 토막 모두 이 제품을 가리킨다 |
| 6 | `Document AI` (47) | `Document Recognizer AI` (75) | **2** | 120 | **보류** | 상품 브랜드와 컴포넌트 중 무엇인지 갈린다. 섹션 5 참조 |
| 7 | `Document AI` (47) | `document ocr` (8) | **1** | 54 | **보류** | 6번과 같은 판단이 선행되어야 한다 |

`Vehicle` 과 `Plate` 는 교집합 5건으로 서로 겹치므로 한 그룹으로 묶어 계산했다.

### 3.2 그룹별 근거 (출처 제목)

사람이 같은 개체인지 눈으로 확인할 수 있도록 각 Concept 의 출처를 최대 5건씩 적는다.

#### 그룹 A — API Gateway (후보 1·2)

3종 합계 참조 54건, 합집합 51건이다. 서로 거의 겹치지 않는다.

| Concept | 출처 (최대 5건) |
| --- | --- |
| `OCR API Gateway` (35) | Task 33 `[Common.API] APIGW 설정`<br>Task 67 `[Common.Console] URI 형식 변경`<br>Task 95 `[Document.Console] 신용카드 분석 콘솔 페이지 최초 접근 전 신용카드 분석 API(API-GW) 호출 시 발생`<br>Task 498 `[OCR.API] APIGW ↔ 공인 경로 등가성 검증 스크립트`<br>Task 497 `[OCR.API] 요청 크기 제한 상향 — multipart, WebClient` |
| `api gateway` (8) | Task 483 `[OCR] API Gateway 제거`<br>Task 491 `[OCR.Infra] API Gateway가 RST로 연결 종료(connection reset by peer)`<br>Task 63 `[Document.API] 사업자등록증 분석 API 성능테스트`<br>Task 459 `[OCR] OCR.API - NHN Cloud 서비스 인증토큰 적용`<br>Task 213 `[OCR] 운영 업무 이관` |
| `Gateway` (11) | Task 489 `[OCR.General] General OCR 모델 응답지연 스파이크 시 게이트웨이 HTML 504 응답`<br>Task 506 `[OCR.Environment] real 공인 진입점 확보`<br>Task 295 `[OCR] OCR Alpha/Beta에서 개발계 신분증/여권 진위 확인 및 Corporation Search IP ACL`<br>Task 19 `[OCR] 논리 구성도 - OLD`<br>Wiki `General OCR 처리 흐름·아키텍처 (요약)` |

세 집합이 실제로 갈라져 있다는 것을 Cypher 로 확인했다.

| Task | 붙어 있는 Gateway 계열 Concept |
| --- | --- |
| 483 | `api gateway` 만 |
| 491 | `api gateway` 만 |
| 489 | `Gateway` 만 |
| 506 | `OCR API Gateway`, `Gateway` |

**주의 — `gateway api`(2건) 는 병합 대상이 아니다.**
토큰 집합이 `api gateway` 와 완전히 같지만 다른 개체다.
출처는 Task 495 `Gateway API(NGINX Gateway Fabric) 이행 검토`, Task 494 이고,
쿠버네티스 표준 Gateway API 를 가리킨다.
`nat gateway`(3건) 도 별개다.
토큰 일치만으로 자동 병합하면 안 되는 실측 사례라 여기 남긴다.

#### 그룹 B — Document Recognizer AI (후보 3)

| Concept | 출처 (최대 5건) |
| --- | --- |
| `Document Recognizer AI` (75) | Task 186 `Document Recognizer / Vehicle Plate Recognizer 서비스 통합 시나리오`<br>Task 187 `통합에 따라 수정 필요 사항 정리`<br>Task 7 `OCR DB 데이터모델링`<br>Task 67 `[Common.Console] URI 형식 변경`<br>Task 111 `[Document.API] InternalInterceptor 적용 대상 path pattern 수정` |
| `document recognizer` (6) | Task 63 `[Document.API] 사업자등록증 분석 API 성능테스트`<br>Task 188 `[OCR.Doc] 상품명 변경에 따른 가이드 Repository 추가 및 메뉴 구조 수정`<br>Task 47 `[OCR] 번역 Main Task`<br>Task 96 `[배포] 2021.12.29 : Hotfix`<br>Task 233 `[배포] 2023.08.29 : 정기 배포` |

교집합 0건이다. 소문자 표기 쪽은 배포·가이드 계열 업무에만 붙어 있다.

`Recognizer`(6건) 는 후보에서 뺐다.
출처가 Task 156 `[Document.Model] 신분증 분석 모듈 리얼 환경 셋팅`, Task 326 `[OCR] Real NKS NeuVector 설치` 처럼
Document 인지 Vehicle Plate 인지 갈리지 않는 인프라 업무다. R4 에 해당한다.

#### 그룹 C — Vehicle Plate Recognizer AI (후보 4·5)

| Concept | 출처 (최대 5건) |
| --- | --- |
| `Vehicle Plate Recognizer AI` (44) | Task 186 `Document Recognizer / Vehicle Plate Recognizer 서비스 통합 시나리오`<br>Task 187 `통합에 따라 수정 필요 사항 정리`<br>Task 72 `[Document.API][VehiclePlate.API] 빈 파일 업로드 시 이해하기 쉬운 에러 메시지 반환`<br>Task 26 `[Document.Console] CloudTrail 연동`<br>Task 43 `[Document.Console] [Document.API] OCR 데이터 관리 정책` |
| `vehicle plate ocr` (6) | Task 393 `[OCR] OCR.Environment Vehicle Plate OCR 미터링 스케줄러 제거`<br>Task 396 `[OCR] Vehicle Plate OCR CloudTrail 제거(25.04.21 이후)`<br>Task 394 `[OCR] Vehicle Plate OCR 관련 개요·가이드 문서 제거 및 비노출 요청`<br>Task 397 `[OCR] Vehicle Plate OCR 관련 테이블 제거`<br>Task 398 `[OCR] Vehicle Plate OCR 콘솔 화면 비노출 요청` |
| `Vehicle` (13) | Task 183 `[OCR.Console] API History테이블 insert 로직 변경 및 L&C알림 수정`<br>Task 244 `[OCR.Model] Model Sever NKS -> NCS 전환`<br>Task 189 `[OCR] Document Recognizer / Vehicle Plate Recognizer 서비스 통합`<br>Task 229 `[OCR] NKS -> NCS 전환 : 사업자 등록증, Vehicle, 신용카드, 신분증`<br>Task 186 `서비스 통합 시나리오` |
| `Plate` (9) | Task 395 `[OCR] Vehicle Plate OCR API GW 설정 제거`<br>Task 244 `[OCR.Model] Model Sever NKS -> NCS 전환`<br>Task 2 `[OCR] 장비 & Github & dl 계정 정보`<br>Task 178 `[배포] 2023.02.28 : 정기 배포`<br>Task 198 `[배포] 2023.03.28 : 정기 배포` |

`vehicle plate ocr` 6건은 전부 이 제품의 서비스 종료(fade-out) 업무다.
`Vehicle Plate Recognizer AI` 와 교집합 0건이라, 지금은 "차량번호판 서비스 종료" 질문이 통합 시나리오 쪽에 닿지 않는다.

## 4. 부속 항목 (참조 5건 미만)

단독 판단 대상은 아니지만, 위 그룹을 사전에 등록할 때 같은 항목의 별칭으로 함께 넣을 만한 것이다.

| 소속 그룹 | 부속 Concept | 참조 | 비고 |
| --- | --- | --- | --- |
| A (API Gateway) | `apigw.v2` | 1 | |
| B (Document Recognizer AI) | `vehicle plate recognizer` | 2 | 실제로는 그룹 C 소속이다 |
| C (Vehicle Plate) | `vehicle(car) plate` | 1 | |
| — | `nginx ingress` | 1 | `ingress-nginx` 의 어순 변형이다. Task 483 한 건 |
| — | `ingress-nginx controller` | 1 | Task 494 |
| — | `ingress-nginx chart` | 1 | Task 494 |
| — | `l&c`, `l&c 알림` | 각 1 | `NHN Cloud Log & Crash` 의 축약 표기다 |
| — | `Crash` | 4 | `NHN Cloud Log & Crash` 와 교집합 1건. 다만 출처에 Prometheus 지표 수집(Task 467)이 섞여 있어 확신이 낮다 |

`Crash` 는 4건이라 임계값 미만이면서 근거도 갈린다. 사람이 판단하기 전까지는 등록하지 않는 편이 낫다.

## 5. 사람 판단이 필요한 지점

### 5.1 Document 계열의 표준 이름 (후보 6·7)

같은 서비스가 시기에 따라 세 이름으로 불린다.

| Concept | 참조 | 대표 출처 |
| --- | --- | --- |
| `Document Recognizer AI` | 75 | Task 186·187 서비스 통합 시나리오, Task 7 DB 데이터모델링 |
| `Document AI` | 47 | Task 351 `[Document AI] 모델 API 검토`, Task 497·499 `[OCR.API]` 최근 업무 |
| `document ocr` | 8 | Task 314·345 `Document OCR 서비스 이용 신청·취소` |

교집합은 `Document AI` 대 `Document Recognizer AI` 가 2건, `Document AI` 대 `document ocr` 가 1건으로 거의 분리되어 있다.
합치면 합집합 130건대의 최대 그룹이 되지만, 판단이 필요하다.

- 셋이 같은 서비스의 개명 이력이면 하나로 합쳐야 한다.
- `Document AI` 가 상품 브랜드이고 `Document Recognizer AI` 가 그 안의 인식 컴포넌트라면 별개로 둬야 한다.
- Task 188 `상품명 변경에 따른 가이드 Repository 추가` 가 개명이 있었음을 시사하지만, 어느 방향인지는 이 데이터만으로 확정할 수 없다.

규모가 가장 크므로 잘못 합치면 손해도 가장 크다. **사람 확인 없이 등록하지 않기를 권한다.**

### 5.2 `Gateway` 를 병합할 것인가

`Gateway` 11건의 출처는 모두 OCR Gateway 맥락으로 읽힌다.
다만 Task 495 가 다루는 쿠버네티스 표준 Gateway API 로 향후 이행하면
`Gateway` 라는 짧은 이름이 그쪽을 가리키게 될 수 있다.
지금 병합해도 되지만, `gateway api` 는 **반드시 별개로 유지**해야 한다.

## 6. 평가 문항에 미칠 영향 (추정)

여기서 말하는 것은 추정이다. 실제 확인은 사전 등록 후 3회 반복 측정으로 해야 한다.
`CLAUDE.md` 에 적힌 대로 1회 측정으로는 개선·회귀를 판정할 수 없다.

### 6.1 영향이 예상되는 문항

`CLAUDE.md` 의 "다음 개선의 단위는 문항이 아니라 노드다" 표에 적힌 실패 노드와 대조했다.

| 놓치는 노드 | 해당 문항 | 그룹 A 병합의 효과 |
| --- | --- | --- |
| Task 491 | A-06, H-12 | **직접 영향.** 지금 `api gateway` 에만 붙어 있다. 병합하면 다수파 `OCR API Gateway` 앵커로 도달 가능해진다 |
| Task 483 | A-08, A-09 | **직접 영향.** 같은 이유다 |
| Wiki `ingress-nginx 컨트롤러를 여러 개 둘 때 격리하는 법` | A-07, H-10 | **영향 없음.** 원인이 관계 유형 불일치라 별칭으로 풀리지 않는다. 섹션 6.2 참조 |

Task 483·491 을 놓치는 4문항(A-06, A-08, A-09, H-12)이 그룹 A 병합의 주 대상이다.
다만 A-08 은 기준선 통과가 우연이었고 main 에서도 3회 전부 실패하는 문항이라,
이 문항으로 개선을 판정하지 않는 편이 좋다.

### 6.2 그룹 A 로 해결되지 않는 것 — 원인은 관계 유형 불일치다

조사 중에 별칭 문제가 아닌 원인을 하나 찾았다.

> **정정** — 이 절의 초안은 "위키가 ingress 계열 Concept 에 붙어 있지 않다" 고 적었으나 틀렸다.
> `MENTIONS` 와 `TAGGED` 만 조회한 결과였다. 실제로는 `DOCUMENTS` 로 붙어 있다.

Wiki `ingress-nginx 컨트롤러를 여러 개 둘 때 격리하는 법` 의 관계를 전부 조회하면 이렇다.

```
DOCUMENTS → ingress-nginx, ingress, ingressclass, admission webhook
MENTIONS  → helm chart, OCR API Gateway, Admin, API, Metering, IP,
            LoadBalancer, argocd, NKS LoadBalancer, Console
```

Wiki `OCR API Gateway 제거 — 외부 전용 ingress 로 분리한 작업` 도 같다.
`OCR API Gateway`·`ingress`·`ingress-nginx` 모두 `DOCUMENTS` 로 붙어 있다.

즉 추출 누락이 아니라 **관계 유형 불일치**다.
추출기는 그 문서가 다루는 주제 개념을 `DOCUMENTS` 로, 스쳐 언급된 개념을 `MENTIONS` 로 나눈다.
질문과 gold 가 `MENTIONS` 만 요구하니 가장 관련 깊은 문서가 오히려 탈락한다.

사전 별칭으로는 해결되지 않는다. 질의가 두 관계를 함께 매치하게 해야 한다.
이 개선은 `feat/documents-relation` 브랜치에서 이미 진행 중이다.

### 6.3 부작용 가능성

- 그룹 A 를 합치면 `OCR API Gateway` 의 참조가 35 → 51 로 늘어난다.
  다른 짧은 앵커를 BM25 로 밀어낼 여지가 커지므로, 앵커 후보 슬롯 문제(`ANCHOR_CANDIDATE_LIMIT = 8`)와 함께 보는 것이 좋다.
- 그룹 C 를 합치면 서비스 종료 업무 6건이 통합 시나리오 업무와 한 앵커에 들어온다.
  차량번호판 관련 질문의 근거 건수가 늘어나므로, 무환각(P) 축에서 무관한 근거를 인용하지 않는지 확인이 필요하다.

## 7. 다음 단계 제안

1. 섹션 3.1 의 1~5번(그룹 A·B·C)을 사람이 확인한다.
2. 승인된 것만 `packages/shared/src/concept/concept.const.ts` 에 별칭으로 등록한다. 현재 사전은 6항목뿐이다.
3. `gateway api`, `nat gateway` 는 별칭에 넣지 않는다. 필요하면 `CONCEPT_KEY_MERGE_DENYLIST` 에 추가한다.
4. 재적재는 초기화가 필요하다. 적재기가 MERGE 전용이라 그냥 다시 넣으면 기존 파편 노드가 남는다.
5. 측정은 A-06·A-09·H-12 를 중심으로 3회 반복한다. A-08 은 main 에서도 전회 실패하므로 판정에 쓰지 않는다.
6. 섹션 6.2 의 관계 유형 불일치는 `feat/documents-relation` 에서 별도로 다룬다.

## 부록 — 실행한 조회

Neo4j 에는 `MATCH` 조회만 실행했다. 쓰기 구문은 사용하지 않았다.

| 목적 | 요지 |
| --- | --- |
| 참조 수 집계 | `MATCH (c:Concept) OPTIONAL MATCH (s)-[:MENTIONS\|TAGGED]->(c) RETURN c.name, count(DISTINCT s)` |
| 출처 목록 | 위 조회에 `elementId(s)` 수집을 더해 교집합을 계산했다 |
| 근거 제목 | `WHERE s:Task OR s:Wiki` 로 좁혀 `s.number`·`s.pageId`·`s.subject` 를 조회했다 |
| Gateway 분리 확인 | `MATCH (t:Task)-[:MENTIONS\|TAGGED]->(c:Concept) WHERE t.number IN [483,491,489,506]` |
| Wiki 연결 확인 | `MATCH (w:Wiki) WHERE w.subject CONTAINS 'ingress'` |

한계 — 참조 수 집계가 `MENTIONS` 와 `TAGGED` 만 세고 `DOCUMENTS` 237건을 빼놓았다.
위키가 주로 다루는 개념은 실제보다 낮게 잡혔다.
후보 선정은 Task 참조가 지배적이라 순위가 크게 흔들리지는 않지만, 위키 중심 개념을 다시 볼 때는 `DOCUMENTS` 를 포함해 세야 한다.

후보 쌍 생성은 조회 결과를 내려받아 로컬 스크립트로 계산했다. 그래프에는 아무것도 쓰지 않았다.

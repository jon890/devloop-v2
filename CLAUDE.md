# devloop-v2 — Dooray 지식그래프 GraphRAG

Dooray 업무·위키를 Neo4j 지식그래프로 만들고 자연어로 질의하는 시스템이다.

## 구조

pnpm workspaces monorepo 다.

패키지는 **기능·역할 도메인**별로 나눈다 (지식 노드 종류별이 아니다).
zod 스키마는 `*.schema.ts`, 상수는 `*.const.ts` 로 분리한다.

```
apps/api/src/     graph/  ontology/  neo4j/  llm/     (+ graph-query.service.ts 는 아직 평면)
packages/shared/  ontology/  graph/  api/  concept/  raw/
apps/pipeline/    ingest/  extract/  load/  llm/
```

노드 종류(Task/Wiki/Concept)별로 나누지 않은 이유 — `structural-extractor` 가 모든 노드를 한 번에 순회하고
적재기도 전 노드를 한 트랜잭션에 MERGE 한다. 쪼개면 응집이 깨지고 호출이 얽힌다.

| 위치 | 역할 |
| --- | --- |
| `packages/shared` | 온톨로지 계약·API 타입·Concept 표준 사전 코어. 모든 앱이 의존한다 |
| `apps/pipeline` | 수집 → 추출 → 적재 CLI. 단계 이름은 아래 표 참조 |
| `apps/api` | 질의응답 REST (NestJS). 앵커 검색 → Cypher 생성 → 답변 합성 |
| `apps/web` | React 와 Vite 기반 UI |
| `docs/` | 관리 문서. 아래 표 참조 |
| `eval/` | 질문 은행(gold), 정적 점검 Cypher, 측정 리포트 |

관리 문서다. 각 문서가 무엇을 소유하는지 고정돼 있다.

| 문서 | 소유 |
| --- | --- |
| `docs/prd.md` | 제품 목표·사용자 가치·범위와 제외 범위 |
| `docs/flow.md` | 단계 흐름·상태 전이·실패와 부분 성공 |
| `docs/code-architecture.md` | 모듈 책임·파일 배치·의존 방향 |
| `docs/data-schema.md` | 노드·관계 계약, `jsonl` 형식, 삭제 규칙 |
| `docs/adr/` | 코드로 자명하지 않은 장기 기술 결정 |
| `docs/EVAL-RUBRIC.md` | 품질 판정 단일 소스. `kg-eval` 이 섹션 번호(섹션 3)로 참조하므로 섹션 구조를 바꾸지 않는다 |
| `docs/pitfalls/` | 반복되는 실수 패턴. 활동별로 나눠 두고 그 활동 직전에 읽는다 |
| `docs/retrospectives/` | 사건 하나의 관찰·원인·조치. 쓰고 나면 고치지 않는다 |

## 활동 전에 함정 파일을 읽는다

이 저장소는 같은 실수를 반복해 왔다. **아래 활동을 시작하기 전에 해당 파일을 먼저 읽는다.**
링크만 훑지 말고 실제로 읽어라 — 대부분 한 화면 분량이다.

| 이 일을 하기 전에 | 읽을 것 |
| --- | --- |
| `kg-eval` 로 품질을 측정한다 | `docs/pitfalls/measurement.md` |
| `sync-neo4j`·`reset-neo4j` 로 그래프를 건드린다 | `docs/pitfalls/graph-loading.md` |
| 테스트를 추가하거나 통과를 근거로 삼는다 | `docs/pitfalls/testing.md` |
| 컨테이너·워크트리를 만들거나 지운다 | `docs/pitfalls/process-cleanup.md` |
| phase 파일이나 구현 지시를 쓴다 | `docs/pitfalls/spec-writing.md` |

색인과 세 문서 계열의 경계는 `docs/pitfalls/INDEX.md` 에 있다.

주요 명령:

```bash
pnpm -r build                          # 전체 빌드
pnpm --filter pipeline test            # 파이프라인 테스트
pnpm apply-schema                      # Neo4j 제약·인덱스 적용
pnpm --filter pipeline sync-neo4j      # 적재
pnpm api                               # API 기동 (:3000)
pnpm web                               # UI 기동 (:5173)
```

### 파이프라인 단계 이름은 산출물과 비용을 드러낸다

```
fetch-dooray → seed-concepts → parse-structure → infer-knowledge → sync-neo4j
체인 밖: audit-concepts · apply-schema
```

| 단계 | 산출물 | 재실행 비용 |
| --- | --- | --- |
| `fetch-dooray` | `data/raw/` | 네트워크. Dooray 가 살아 있어야 한다 |
| `seed-concepts` | `data/concepts/` | 공짜 |
| `parse-structure` | `graph/parsed.jsonl` | **공짜** (수 초) |
| `infer-knowledge` | `graph/inferred.jsonl` | **LLM 537회** |
| `sync-neo4j` | Neo4j | 되돌리기 어렵다 |

`parse-structure` 는 규칙 파싱이라 공짜고 `infer-knowledge` 는 LLM 이라 비싸다.
**구조만 고쳤으면 `parse-structure` 만 다시 돌린다.** 옛 이름(`extract:structural`·`extract:llm`)은
둘 다 `extract:` 라 이 차이가 안 보였다.

`infer-knowledge` 캐시 키에 `promptVersion` 이 들어 있다 — 추출 프롬프트를 고치면 캐시가 전부 빗나간다.

## 실측으로 확립된 사실

추정하지 말고 아래를 전제로 삼는다. 모두 실제 측정으로 확인했다.

### 앵커 선정이 취약하다

`graph-query.service.ts` 의 앵커 검색에 두 문제가 있다.

- **원문 유실**: 프롬프트가 한·영 표기 변형을 만들라고 지시하는데, LLM 이 원문을 버리고 변형만 넣는다
    - 실측 — "Log & Crash 쓰는 법" 에서 `로그` 만 추출해 엉뚱한 Concept 을 앵커로 잡았다
    - `Log & Crash` 로 검색하면 정답 위키가 4위로 나온다. 인덱스 문제가 아니다
- **최종 슬롯 경쟁**: 전문 검색은 **인덱스당** 8건씩 따로 가져온다. 공유되는 것은 그 뒤 `rankAnchorCandidates` 가 고르는 최종 8개다.
  라벨 정원(Task 최대 5·Wiki 최소 2·Concept 최대 2)이 이미 완화하고 있다
    - 앞서 이 문서에 "8을 3개 인덱스가 공유한다" 고 적혀 있었으나 틀렸다. `fulltextSearch` 의 `perIndexLimit` 를 확인했다

### 검색 도달은 해결됐고 병목이 상한으로 옮겨갔다 (plan006, 2026-08-03 실측)

**이전 상태** — `FULLTEXT_INDEXES` 가 제목과 이름만 덮고, 저장 텍스트도 업무 본문 300자·댓글 200자라
검색이 닿을 길 자체가 없었다. 댓글의 79%가 잘렸다.

**지금** — 저장 상한이 6,000자이고 인덱스가 5개다 (`task_body_fulltext`·`comment_excerpt_fulltext` 추가).
댓글 히트는 부모 업무로 승격된다.

- 실측 — 병목과 조치를 함께 묻는 질문의 정답 댓글이 이제 1,729자로 온전하고, 새 댓글 인덱스가
  그 노드를 **1위(점수 8.98, 2위 3.91)** 로 찾아낸다. 답변이 조치 내용까지 인용한다
- 한국어 토큰화는 문제가 아니다. `cjk` analyzer 가 두 글자씩 겹쳐 쪼개므로 `요청크기` 와 `요청 크기` 가 같은 점수로 걸린다

**그런데 회수 실패는 줄지 않았다 (19 → 20).** 원인이 검색이 아니라 **상한**으로 옮겨갔다.

- `AGW-H04`·`AGW-H01` 은 실패 회차의 근거 노드 수가 **정확히 30개**다 — `EVIDENCE_NODE_LIMIT` 에서 정답 노드가 떨어진다
    - **전체로 일반화하지 마라.** 회수 실패 20건 중 30에 닿은 것은 5건이고 나머지는 근거가 30개에 못 미친다.
      상한이 구속하는 문항과 그렇지 않은 문항이 섞여 있다
- 생성된 Cypher 의 `LIMIT 50` 도 같은 자리다. 어떤 문항은 그 패턴이 157행을 만들고 한 업무의
  Decision 이 50행을 먼저 채워, 다른 업무의 정답 댓글이 아예 들어오지 못한다
- 따라서 다음 개선 단위는 문항이 아니라 **상한과 행 예산**이다. 상한을 올리기 전에
  **자를 때 필수 근거를 우선 남기는지**를 먼저 본다 — 지금은 순서에 맡긴다
    - plan007 이 이 중 근거 상한을 처리했다. 아래 "근거는 개수가 아니라 길이로 자른다" 를 본다.
      Cypher 행 예산은 아직 남아 있다
- `GRAPH` 관문이 0건이라고 "그래프에 답이 다 있다" 는 뜻이 아니다. 그 관문은 노드·관계의 존재만 본다

**긴 본문이 환각을 늘리지 않았다.** 음성 대조 문항의 금지 주장 판정이 2판정자 × 6회차 12건 전부
통과다 (이전 기준선은 위반 2건). 단 저장할 때 **개행을 보존해야** 한다 — 개행을 지우면 6,000자 안의
마크다운 표가 행 경계를 잃어 값을 다른 행에서 잘못 읽을 위험이 있다. 실측 정답 댓글의 조치 내용이 표다.

### 근거는 개수가 아니라 길이로 자른다 (2026-08-03)

노드 30건 상한(`EVIDENCE_NODE_LIMIT`)이 정답 근거를 버리고 있었다. `AGW-H04` 를 6회 돌린 실측이다.

| 관측 | 회차 | 결과 |
| --- | --- | --- |
| 노드 30건에 닿아 정답 댓글이 근거에 없다 | 3 | 회수 실패 |
| 댓글이 근거에 있고 본문이 프롬프트 창 안에 온전히 들어온다 | 3 | 도달 |

개수로 자르는데 **비용은 길이에서 온다.** plan006 이 본문 상한을 6,000자로 올린 뒤 노드 하나가
200자에서 8,800자까지 벌어졌는데 개수 기준은 둘을 같은 1로 센다. 그래서 셋을 바꿨다.

- **직렬화 예산 60,000자, 개수 상한 80** (`EVIDENCE_SERIALIZED_BUDGET`·`EVIDENCE_NODE_CEILING`)
- **`Comment` 를 라벨 우선순위 최하위에서 `Decision` 다음으로** 올렸다. 필수 근거 29건 중 14건이
  댓글인데 `Concept` 뒤라 가장 먼저 버려졌다. `Concept` 은 태그성 노드라 본문이 없다
- **답변 프롬프트 근거를 노드 단위 선택으로** 바꿨다 (`ANSWER_EVIDENCE_PROMPT_BUDGET`)

마지막이 따로 있던 결함이다. 프롬프트는 원래 `JSON.stringify(evidence).slice(0, 20_000)` 이었다.
**문자 단위로 자르면 JSON 구조 중간이 잘려** LLM 이 닫히지 않은 조각을 받는다.
실측으로 6회 모두 20,000자를 넘었다 (20,392~34,615자).

- **한글 길이를 잴 때 escape 여부를 구분하라.** JS `JSON.stringify` 는 한글을 그대로 두고
  파이썬 `json.dumps` 는 기본이 `\uXXXX` 다. 같은 근거가 34,615자와 57,466자로 갈린다.
  이 차이를 놓쳐 절단 심각도를 한 번 잘못 보고했다
- **응답 예산이 프롬프트 예산보다 크다.** 회수는 응답 기준으로 판정하므로 프롬프트 사정에 맞춰
  응답을 줄이지 않는다
- **노드에 예산을 먼저 줘라.** 관계 비용을 전부 먼저 빼면 관계가 예산을 넘는 회차에서 노드 예산이
  0이 되어 첫 노드만 담기고, 그 뒤 관계도 끝점이 없어 전부 걸러진다. 독립 검토가 이 결함을
  측정 전에 잡았다 — 노드 57건을 회수한 회차가 프롬프트에는 1건만 줬다 (9회 중 3회)
- **예산에 안 맞는 항목을 만나면 멈춰라 (`break`).** 건너뛰면(`continue`) 예산에 걸린 상위 노드
  대신 하위의 짧은 노드가 담겨 정렬이 뒤집힌다 — 본문 있는 `Comment` 를 버리고 본문 없는
  `Concept` 을 담는 일이 생긴다

### 남은 파편화는 자동 병합할 수 없다

표기 정규화로 잡히지 않는 유형이다.

- 부분 표기 — `Log`·`Crash` 대 `NHN Cloud Log & Crash`
- 접두어 차이 — `api gateway` 대 `OCR API Gateway`
- 부분포함 1,247쌍이 탐지되지만 **대부분 오탐**이다. `Document` 가 `Document.Console` 에 포함되지만 둘은 별개 개체다

따라서 다음 단계는 자동 병합이 아니라, 고빈도 Concept 만 후보로 뽑아 사람이 확인한 뒤 사전 별칭으로 등록하는 방식이다.
후보 조사는 끝났다 — `eval/reports/2026-07-28-concept-alias-candidates.md` 에 후보 7쌍, 병합 권장 5쌍이 있다.

## 품질 판정

`docs/EVAL-RUBRIC.md` 가 단일 소스다. 축별로 독립 판정하며 점수를 합산하지 않는다.

| 축 | 통과 조건 |
| --- | --- |
| A 앵커 해석 | 필요한 앵커 전부 resolve |
| R 근거 재현율 | 필수 항목 전부 인용, 보강은 비율 기준 |
| P 무환각 | 위반 0건 |
| G 그래프 정합 | 관계 주장 100% Cypher 재현 |
| U 행동 유용성 | 권고 (실패로 보지 않음) |

합산을 폐기한 이유 — 답을 못 찾은 문항도 P(무환각) 만점을 받아 하한이 떠받쳐졌다.
실패가 숫자에 묻혀 원인을 읽을 수 없었다.

gold 는 필수(`required`)와 보강(`supporting`)으로 나눠 적는다.
비율 기준만 쓰면 gold 가 작을 때 이산화되어 어떤 임계값도 "누락 0개" 요구가 된다 (실측: gold 최대 7개).

## 작업 방식

- **구현은 codex subagent 에 위임한다.** 메인 세션은 계획·평가·orchestration 을 맡는다
- **리뷰는 작성과 다른 lane 에서 한다.** 구현 후 `code-reviewer` 또는 `verifier` 에 위임해 GO/NO-GO 를 받는다. 같은 컨텍스트의 자기 승인은 신뢰할 수 없다
- LLM 은 구독 CLI(`codex exec`)만 쓴다. 종량제 API 는 금지한다
- 모델 — 추출 `gpt-5.5`, 질의 `gpt-5.6-terra` (벤치마크로 확정)
- 테스트는 데모 데이터가 아니라 실제 Dooray·GHE 데이터로 한다

## 진행 중인 작업

| 항목 | 상태 |
| --- | --- |
| Concept 정규화 (1층) | **완료**. 재적재 후 Concept 1,007 → 974 |
| 그래프 시각화 3화면 | **머지 완료** (`ea13574`). 온톨로지 정의·스키마 맵·인스턴스 탐색 |
| 도메인 구조 정리·거대 함수 분해 | **머지 완료**. `query` 352줄만 남겼다 |
| 앵커 원문 보존·라벨 정원 | **머지 완료** |
| `query` 도메인 분해 | **머지 완료** (`958e31f`). `graph-query.service.ts` 661 → 82줄, 조회 4종만 남겼다 |
| prettier 도입 | **머지 완료** (`c70ddc8`) |
| 질의에 DOCUMENTS 관계 반영 | **머지 완료** (`80a79a7`). A-07 이 3회 전부 통과로 바뀌었다 |
| `REFERENCES` 오탐 제거 | **머지 완료** (`64b97ca`). 786 → 328 |
| API 환경설정 config 통합 | **머지 완료** (`4e79013`). 필수 값 부재를 기동 실패로 만들었다 |
| 스키마 맵 표본 페이징 | **머지 완료** (`ef0c5a5`).<br>정렬은 키 속성 뒤 `elementId` 로 동순위를 깬다<br>limit 상한 100, offset 상한 `MAX_SAFE_INTEGER` |
| 파이프라인 단계 이름·모듈 배치 | **머지 완료** (`ffefdae`). 1단계 |
| 파이프라인 2단계 — `sync-neo4j` 분해 | **완료**. `resolve-graph`·`reset-neo4j` 신설, `sync.ts` 875 → 303줄.<br>죽은 마이그레이션 2개는 분리가 아니라 삭제했다 — 적재기가 그 상태를 만들지 않는다 |
| 사전 별칭 보강 (2층) | **완료.** 후보 5쌍을 승인해 병합 별칭 6개를 판단 저장소에 등록하고, `resolve-graph` 비교로 그 흡수 대상 6종만 합쳐지는지 확인했다.<br>`gateway api`·`nat gateway` 는 별개로 남았다.<br>2026-07-30 재적재로 그래프에 반영했다 — Concept 974 → 968, 관계 13,019 → 13,002 |
| gold 3문항 (A-06·A-10·H-12) | **`supporting` 하향으로 결정.** 미실행 |
| gold H-17 | **별칭·추출 프롬프트 둘 다로 결정.** 미실행. 프롬프트 변경은 LLM 537회 |
| A-14 인수 기준 | **문구 변경으로 결정.** "FAIL 전환 0개" → "원인이 가짜 엣지 제거임을 증명". 미실행 |
| 원천 텍스트 보존·본문 검색 (plan006) | **완료.** 상한 6,000자, 인덱스 5개, 댓글 히트 승격.<br>회수 실패는 19 → 20 으로 목표 미달이고, 병목이 `EVIDENCE_NODE_LIMIT` 30 과 Cypher `LIMIT 50` 으로 옮겨간 것을 실측했다<br>측정 리포트 — `eval/reports/2026-08-03-plan006-engine.md` |
| 근거 상한·댓글 확장 (plan007) | **완료.** 근거 상한을 개수 30 에서 직렬화 예산 60,000자로, Cypher 를 지목된 모든 업무의 댓글 확장으로 바꿨다.<br>회수 실패가 변경 전 (12, 12) 에서 변경 후 (7, 9) 로 **구간이 겹치지 않는다** — 이 축에서 처음이다<br>측정 리포트 — `eval/reports/2026-08-03-plan007-evidence-budget.md` |
| Cypher 행 예산 | **다음 후속.** 필수 근거가 여러 업무에 걸칠 때 `LIMIT 50` 이 행을 굶어 업무 노드를 잃는다.<br>`AGW-A05` 가 6회 전부 `task-494` 를 놓친다. 상한을 올리기보다 **업무별로 행을 나누는 Cypher 형태**를 프롬프트로 유도하는 편을 먼저 본다 |
| GitHub Enterprise 통합 | **보류**. Phase 1(staging·초기화)만 남았다 |
| 노드 속성 키 순서 한계 | **후속으로 미룸.**<br>현재 계약(같은 입력이면 같은 바이트)은 지켜진다. 더 강한 계약(키 순서가 달라도 논리적으로 같은 JSON 이면 같은 바이트)은 아직 아니다<br>`mergeNode`(`node-merge.ts:179-182`)의 얕은 병합 때문에 속성 삽입 순서가 다르면 바이트가 달라질 수 있다<br>다만 사전만 바꾸는 의도된 경로에서는 레코드 순회 순서가 고정돼 있고(`resolve.ts:27-32`·`:128-135`) 강화 키 그룹이 전체가 함께 매칭·미매칭되어 지금은 드러나지 않는다 |

### 별칭 등록 효과를 적재 없이 확인했다

`eval/reports/2026-07-28-concept-alias-candidates.md` 의 후보 5쌍을 승인했고,
여기서 나온 병합 별칭 6개를 관계형 판단 저장소에 등록했다.
주입 데이터는 조직 내부 이름과 업무 번호를 담으므로 저장소 밖에 보관한다.

판단 주입 전후로 `resolve-graph` 를 실행해 사라진 Concept 이 흡수 대상 6종과 정확히 일치하고,
관계 끝점이 세 표준어로 옮겨지는 것을 확인했다.
판단을 반영한 뒤 `seed-concepts` 를 다시 실행해도 `resolved.jsonl` 바이트가 같았다.

```bash
# cwd: 저장소 루트
D="$(pwd)/apps/pipeline/data"
pnpm --filter pipeline resolve-graph --project tc-ocr --data-dir "$D" --out /tmp/after.jsonl
pnpm --filter pipeline seed-concepts --project tc-ocr
pnpm --filter pipeline resolve-graph --project tc-ocr --data-dir "$D" --out /tmp/after2.jsonl
cmp /tmp/after.jsonl /tmp/after2.jsonl
```

**`gateway api`(쿠버네티스 표준 Gateway API)와 `nat gateway` 는 병합 대상이 아니다.**
`api gateway` 와 토큰 집합이 같지만 다른 개체다. 토큰 일치만으로 자동 병합하면 안 되는 실측 사례다.
2026-07-30 에 사용자 승인을 받아 그래프를 초기화하고 재적재했다. 아래 "재적재로 별칭 효과를 그래프에 반영했다" 를 본다.

### 재적재로 별칭 효과를 그래프에 반영했다 (2026-07-30)

`reset-neo4j --force --allow-production` → `pnpm apply-schema` → `sync-neo4j` 순서로 돌렸다.
실측 결과가 사전 예측과 **모든 유형에서 정확히 일치했다.**

| 항목 | 이전 | 이후 | 차이 |
| --- | --- | --- | --- |
| 노드 | 3,088 | 3,082 | -6 (Concept 974 → 968) |
| 관계 | 13,019 | 13,002 | -17 |

관계 17건은 흡수된 Concept 로 향하던 엣지가 표준어에서 겹쳐 합쳐진 것이다
(`MENTIONS` 13, `DEPENDS_ON` 2, `DOCUMENTS` 2). 다른 라벨·관계는 전부 불변이다.
흡수 대상 6종은 0건으로 사라졌고 `gateway api`·`nat gateway` 는 별개로 남았다.

**되돌릴 수 없는 적재는 예측을 먼저 세우고 실행한다.** 방법은 이렇다.

- `resolve-graph` 산출 파일에서 관계를 `(type, startKey, endKey)` 로 묶어 **고유 개수**를 센다.
  적재기가 MERGE 하므로 레코드 수(13,078)가 아니라 이 값(13,002)이 적재 후 건수다
- 라벨·관계 유형별 표를 전후로 만든다. 총계만 보면 어느 유형이 왜 줄었는지 못 읽는다
- 예측과 실측이 어긋나면 그 자리에서 원인을 찾는다. 사후에 숫자만 보고 해석하면 늦다

`sync-neo4j` 는 초기화 직후에도 관계 1건을 건너뛴다 — `Decision:127-2 -[:EVIDENCED_BY]-> Comment:...`
의 끝점 Comment 노드가 원천에 없다. 재적재 전에도 있던 상태이므로 이번 작업이 만든 것이 아니다.

코드가 바뀌지 않았으므로 dev 서버는 재시작하지 않았다.
`/api/graph/stats` 가 곧바로 새 건수를 반환하는 것을 확인했다 — API 는 그래프 통계를 캐시하지 않는다.

### 다음 개선의 단위는 문항이 아니라 노드다

같은 노드를 여러 문항이 함께 놓친다. 문항별로 대응하지 말고 노드에 왜 도달하지 못하는지 본다.

2026-07-28 측정 기준으로 남은 실패 11건의 성격이다.

| 유형 | 문항 | 성격 |
| --- | --- | --- |
| 원천에 근거 없음 | A-06, A-10, H-12 | 483↔491, 501↔502 엣지가 원천 Dooray 데이터에도 없다. 검색 개선으로 못 푼다 |
| 앵커 해석 실패 | H-10, H-11, H-16 | 지칭이 모호해 엉뚱한 앵커를 잡는다 |
| 근거 상한 밀림 | A-14 | 경로는 있으나 상한 30건 안에 못 든다 |
| 개별 확인 필요 | H-07, H-08, H-14, H-15 | |

노드 단위 접근이 통한 사례가 있다 — 위키 "ingress-nginx 격리" 는 관계 유형 불일치였고
질의에 `DOCUMENTS` 를 알려 A-07 을 통과로 바꿨다. 다만 같은 위키를 요구하는 H-10 은 여전히 실패한다.
같은 노드를 놓치더라도 **원인이 문항마다 다를 수 있다.**

GitHub 통합 계획은 `.omc/plans/2026-07-27-ghe-repo-knowledge.md` 에 있다.
기존 품질이 예상보다 낮다는 것을 실측으로 발견해 순서를 바꿨다 — 파편화가 심한 상태에서 저장소 노드를 더하면 앵커 경쟁이 악화된다.

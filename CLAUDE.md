# devloop-v2 — GraphRAG와 Coding Agent Experience Memory

Dooray 업무·위키의 Neo4j GraphRAG를 비교군으로 유지하면서,
Dooray와 OCR Git 이력에서 Coding Agent용 Experience Memory를 만든다.

## 구조

pnpm workspaces monorepo 다.

패키지는 **기능·역할 도메인**별로 나눈다 (지식 노드 종류별이 아니다).
zod 스키마는 `*.schema.ts`, 상수는 `*.const.ts` 로 분리한다.

```
apps/api/src/     graph/  ontology/  neo4j/  llm/     (+ graph-query.service.ts 는 아직 평면)
packages/shared/  ontology/  graph/  api/  concept/  raw/
packages/llm/     (평면 — Responses 직접 호출·app-server 클라이언트·어댑터)
apps/pipeline/    ingest/  extract/  load/  llm/  memory/
```

노드 종류(Task/Wiki/Concept)별로 나누지 않은 이유 — `structural-extractor` 가 모든 노드를 한 번에 순회하고
적재기도 전 노드를 한 트랜잭션에 MERGE 한다. 쪼개면 응집이 깨지고 호출이 얽힌다.

| 위치 | 역할 |
| --- | --- |
| `packages/shared` | 온톨로지 계약·API 타입·Concept 표준 사전·Memory 계약. 모든 앱이 의존한다 |
| `packages/llm` | LLM 호출 전송. 기본은 Responses 직접 호출이고 상주 `codex app-server` 를 되돌릴 길로 둔다 ([ADR 0009](docs/adr/0009-direct-responses-transport.md)) |
| `apps/pipeline` | GraphRAG 수집·추출·적재와 Experience Memory 정규화·추출·색인·검색 CLI |
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

Experience Memory 설계를 위해 `docs/memory/` 같은 별도 관리 문서군을 만들지 않는다.
기존 관리 문서의 소유 범위와 `tasks/plan{N}-*/` 실행 규약을 사용한다.

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
- LLM 은 구독 계정으로만 쓴다. 종량제 API 는 금지한다. 호출은 Responses 엔드포인트로 직접 보낸다
- 모델 — 추출 `gpt-5.5`, 질의 `gpt-5.6-terra` (벤치마크로 확정)
- Experience Memory 추출 모델은 `gpt-5.6-luna`, reasoning effort는 `low`로 강제한다. 환경변수나 다른 모델로 fallback하지 않는다
- Experience Memory request schema는 Responses Structured Outputs 지원 키만 사용한다.
  빈 문자열과 `sourceRefKeys` 중복은 Zod post-validation에서 거부한다
- 계획 lane은 기존 관리 문서와 task를 확정하고, 구현 lane은 별도 실행 컨텍스트에서 phase 구현·검증·커밋을 수행한다
- 테스트는 데모 데이터가 아니라 실제 Dooray·GHE 데이터로 한다

<!-- MEMORY-SEARCH-VOLUNTARY-POLICY:START -->
## Experience Memory voluntary search policy

- Search Experience Memory with `pnpm --silent memory-search -- --query <query> --project tc-ocr --allow-incomplete` before work that depends on historical decisions, compatibility constraints, incidents, migrations, or legacy behavior.
- Skip Memory search for clear code-only edits where the current source and local tests fully define the change.
- If Memory results have low confidence, `uncertain` status, or conflicting sources, open the original source reference before relying on them.
- Experience Memory is supporting context only. Current source code, current tests, and explicit task instructions win when they conflict with Memory.
<!-- MEMORY-SEARCH-VOLUNTARY-POLICY:END -->

## 지금 어디에 있나

이 절은 **짧게 유지한다.** 측정 수치와 사건 경위는 리포트가 소유하고 여기서 복제하지 않는다.

- **LLM 전송** — Responses 직접 호출이 기본이다. 답변 분량에 따른 총지연 회귀는 열려 있다.
  `eval/reports/2026-08-06-plan011-direct-transport.md` 를 본다
- **품질 축의 현재 상태** — 최신 측정 리포트를 본다. `eval/reports/` 에서 가장 최근 날짜 파일이
  기준선이고, 그 문서가 그 시점의 실패 경계 분포와 남은 병목을 소유한다.
  **같은 날짜에 여러 개가 있으면 늦은 phase 것이 기준선이다** — 한 plan 이 중간 측정과 최종 측정을
  따로 남기면 파일명 순서로는 가려지지 않는다 (plan010 이 그렇다)
- **끝난 작업의 경위** — `git log` 와 각 plan 의 `tasks/plan{N}-*/` 가 소유한다
- **사건별 원인·조치** — `docs/retrospectives/`. 실행 기록은 `RUNS.md`
- **질의 도메인의 살아 있는 제약** — `docs/code-architecture.md` 의 "질의 도메인의 알려진 한계"
- **Experience Memory 수직 검증** — `eval/reports/2026-08-11-plan012-experience-memory.md`.
  최신 raw 기준 source manifest, Luna bounded cache, Wiki/search smoke를 기록했다

미실행으로 남은 결정이다. 각각 근거 문서가 있다.

| 항목 | 상태 |
| --- | --- |
| gold 3문항 (A-06·A-10·H-12) | `supporting` 하향으로 결정. 미실행 — 원천에 근거가 없는 문항이다 |
| gold H-17 | 별칭·추출 프롬프트 둘 다로 결정. 미실행. 프롬프트 변경은 LLM 537회 |
| A-14 인수 기준 | "FAIL 전환 0개" → "원인이 가짜 엣지 제거임을 증명" 으로 문구 변경. 미실행 |
| GitHub Enterprise 통합 | 보류. 계획은 `.omc/plans/2026-07-27-ghe-repo-knowledge.md`. 앞의 두 문(측정 정밀도·코드 관련 gold)이 열려야 시작한다 |
| 노드 속성 키 순서 결정성 | 후속. 현재 계약(같은 입력이면 같은 바이트)은 지켜진다 |
| 위키 본문 저장 | 후속. 위키는 `pageId`·`subject` 만 있고 본문 121,554자가 그래프에 없다 |

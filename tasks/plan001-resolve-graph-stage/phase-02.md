# Phase 02 — 정규화를 resolve 디렉터리로 옮기고 계약을 만든다

**Execution profile**: standard
**Status**: pending

---

## 목표

`apps/pipeline/src/neo4j/sync.ts` 는 875줄이고 그중 **약 340줄이 정규화**다.
그 정규화는 Neo4j 의존이 0인데 적재 파일 안에 있다. `apps/pipeline/src/resolve/` 로 옮긴다.

왜 필요한가 — 정규화가 적재에 묶여 있어 **별칭 사전을 고쳤을 때 무엇이 합쳐지는지 적재 없이 볼 수 없다.**
적재기가 MERGE 전용이라 틀리면 그래프를 초기화해야 한다.

**이 phase 는 이동과 계약 정의까지다. 동작을 바꾸지 않는다.**

**범위 외**

- `resolve-graph` 명령·파일 출력 — Phase 03
- `sync-neo4j` 축소·`reset-neo4j` 신설·죽은 마이그레이션 삭제 — Phase 04
- 정규화 판정 규칙 변경 — 이번 plan 전체에서 하지 않는다

---

## 작업 항목 (4)

### 1. `apps/pipeline/src/resolve/` 신설과 정규화 이동

`sync.ts` 의 아래 범위를 옮긴다. 함수 본문을 고치지 마라.

| 옮길 것 | 현재 위치 | 새 파일 |
| --- | --- | --- |
| `normalizeText`·`normalizeConceptKey`·`conceptLookupKeys`·`buildConceptAliasMap`·`conceptDictionaryConflict`·`conceptEntry`·`conceptSource` | `sync.ts` 111~196 | `resolve/concept-alias.ts` |
| `addEndpointAlias`·`resolveEndpoint`·`addDictionaryEndpointAliases` | `sync.ts` 314~330, 570~594 | `resolve/endpoint.ts` |
| `buildUnmatchedConceptRepresentatives`·`addUnmatchedConceptCandidate`·`selectUnmatchedRepresentatives`·`conceptReferenceCounts`·`compareCodePoints`·`normalizeNode`·`normalizeNonConceptNode`·`normalizeUnmatchedConceptNode`·`normalizedKey`·`databaseKey`·`mergeNode` | `sync.ts` 384~569 | `resolve/node-merge.ts` |
| `normalizeGraph`·`validateNormalizationSources`·`normalizeNodes`·`normalizeRelationships`·`normalizeRelationship`·`recordSkippedRelationship` | `sync.ts` 255~383 | `resolve/resolve.ts` |

**주의** — `databaseKey` 는 `neo4j.int()` 를 쓴다. Neo4j 드라이버 의존이 남으면
`resolve/` 가 "Neo4j 를 모른다" 는 원칙이 깨진다. 두 갈래 중 하나를 골라 근거를 보고하라.

- `databaseKey` 만 `neo4j/` 에 남기고 `resolve/` 는 `normalizedKey`(순수)까지만 담당한다
- `resolve/` 가 드라이버를 알되 그 사실을 파일 주석에 남긴다

**첫 번째를 권한다** — 적재 키 변환은 쓰기 관심사다.

### 2. `apps/pipeline/src/resolve/resolve.schema.ts` — 결과 계약

`sync.ts:41` 의 `NormalizedGraph` 를 확장해 정리 산출까지 담는다.

```ts
export interface ResolveResult {
  nodes: OntologyNode[];
  relationships: OntologyRelationship[];
  unknownConcepts: Map<string, number>;
  skippedRelationships: SkippedRelationshipsReport;
  droppedRelationships: DroppedRelationshipsReport;
  rewrittenRelationships: number;
}
```

뒤 두 필드는 Phase 01 의 `sanitizeLlmRecords` 결과에서 온다.

zod 스키마도 함께 둔다. 이 저장소 관례는 zod 를 `*.schema.ts` 에, 상수를 `*.const.ts` 에 두는 것이다.
`Map` 은 JSON 직렬화가 안 되므로 **파일로 쓸 때의 형태**를 스키마로 정하고 근거를 보고하라
(Phase 03 이 이 스키마로 `resolve-report.json` 을 쓴다).

### 3. `apps/pipeline/src/resolve/resolve.ts` — 진입 함수

읽기·쓰기 없이 인자만 받아 결과를 돌려주는 함수를 내보낸다.

```ts
export interface ResolveInput {
  parsed: SourcedRecord[];
  inferred: SourcedRecord[];
  dictionary: ConceptDictionary;
}

export function resolveGraph(input: ResolveInput): ResolveResult;
```

내부 순서는 이렇다.

1. `sanitizeLlmRecords` 로 `inferred` 를 정리한다 (Phase 01 의 순수 함수)
2. 사전으로 별칭 맵을 만든다
3. `parsed` 와 정리된 `inferred` 를 합쳐 기존 `normalizeGraph` 로직을 흘린다

`SourcedRecord` 는 `sync.ts` 에 있는 타입이다. `resolve/` 로 옮기거나 공용 위치를 정하고 근거를 적어라.

### 4. `sync.ts` 가 새 함수를 쓰게 고친다

`prepareLoadGraph` 를 `resolveGraph` 호출로 바꾼다.
**읽기(`readJsonlRecords`·`loadConceptDictionary`)는 이번에 옮기지 않는다** — Phase 03 에서 `io.ts` 로 간다.
지금은 `sync.ts` 가 읽어서 `resolveGraph` 에 넘기는 형태로 둔다.

`sanitizeLlmGraphFile` **호출을 제거한다.** 적재가 더 이상 파일을 덮어쓰지 않는다.
정리는 `resolveGraph` 안에서 메모리로 이루어진다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/resolve/resolve.ts` | 신규 |
| `apps/pipeline/src/resolve/resolve.schema.ts` | 신규 |
| `apps/pipeline/src/resolve/concept-alias.ts` | 신규 |
| `apps/pipeline/src/resolve/endpoint.ts` | 신규 |
| `apps/pipeline/src/resolve/node-merge.ts` | 신규 |
| `apps/pipeline/src/neo4j/sync.ts` | 수정 — 정규화 제거, `resolveGraph` 호출 |
| `apps/pipeline/src/neo4j/sync.test.ts` | 수정 — 이동한 함수 import 경로 |
| `apps/pipeline/test/sync.test.cjs` | 수정 — 같은 이유 |

---

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

`pnpm --filter api test` 는 쓰지 마라 — exit 0 으로 조용히 통과한다.
테스트 **개수**를 확인하라. 줄었으면 이동한 테스트가 실행되지 않는 것이다.

### 함수 본문 동등성 (필수)

이동만 했으므로 함수 본문이 같아야 한다.

```bash
# cwd: 저장소 루트
git show HEAD:apps/pipeline/src/neo4j/sync.ts > /tmp/sync-before.ts
# 옮긴 함수들의 본문을 /tmp/sync-before.ts 와 새 파일에서 각각 추출해 diff 한다
```

import 줄과 `export` 키워드 추가는 허용된다. **그 외 차이가 있으면 함수명과 줄을 보고하라.**

### 적재 결과 동등성 (필수)

`sync-neo4j` 를 돌려 노드·관계 통계가 이전과 같은지 확인한다.

```bash
# cwd: 저장소 루트
# 반드시 대상 포트를 명시한다
NEO4J_URI=bolt://localhost:7688 pnpm --filter pipeline sync-neo4j --project <프로젝트코드> --data-dir <절대경로>
```

- **`NEO4J_URI` 를 지정하지 않으면 `.env` 기본값인 운영 그래프(7687)에 적재된다.**
  실제로 이 실수로 운영 그래프가 오염된 사례가 있다
- 테스트 인스턴스가 없으면 이 검증은 `PHASE_BLOCKED` 로 남기고 통계 비교를 조정자에게 넘겨라

---

## 의도 메모 (왜)

- **`resolve/` 를 `neo4j/` 밖에 두는 이유** — Neo4j 를 모르는 코드다. 디렉터리 이름이 그 사실을 말해야 한다
- **4개 파일로 가른 기준은 전역 시야다** — 사전 전체(별칭), 전체 노드(엔드포인트 색인),
  전체 노드·관계(참조 수로 대표 선정), 그리고 그 셋을 흘리는 진입점이다
- **더 쪼개지 않는 이유** — 이 저장소는 "쪼개면 응집이 깨지고 호출이 얽힌다" 는 판단을 문서로 남겼다.
  어떤 Concept 을 어느 대표로 합칠지는 다른 문서들이 그 이름을 몇 번 참조했는지에 달려 있어
  항목 단위로 나눌 수 없다
- 이 phase 가 Phase 03 의 무엇을 막아주나 — `resolveGraph` 가 순수 함수이므로
  Phase 03 은 **입출력만 붙이면** 된다

근거 문서 — `docs/adr/0004-resolve-as-inspection-stage.md`, `docs/code-architecture.md`

---

## Blocked 조건

- 테스트용 Neo4j 인스턴스가 없어 적재 동등성을 확인할 수 없으면
  `PHASE_BLOCKED: 테스트 Neo4j 부재로 적재 동등성 검증 불가` 를 출력하고,
  **함수 본문 동등성과 단위 테스트까지는 완료한 상태로** 종료한다

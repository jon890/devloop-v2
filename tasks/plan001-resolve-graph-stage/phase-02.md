# Phase 02 — 정규화를 resolve 디렉터리로 옮기고 계약을 만든다

**Execution profile**: standard
**Status**: completed

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
| `buildUnmatchedConceptRepresentatives`·`addUnmatchedConceptCandidate`·`selectUnmatchedRepresentatives`·`conceptReferenceCounts`·`compareCodePoints`·`normalizeNode`·`normalizeNonConceptNode`·`normalizeUnmatchedConceptNode`·`normalizedKey`·`mergeNode` | `sync.ts` 384~569 | `resolve/node-merge.ts` |
| `normalizeGraph`·`validateNormalizationSources`·`normalizeNodes`·`normalizeRelationships`·`normalizeRelationship`·`recordSkippedRelationship`·`parseGraphRecords` | `sync.ts` 255~383, 223~254 | `resolve/resolve.ts` |

`addDictionaryEndpointAliases` 는 314~330 이라 `resolve.ts` 행의 줄 범위와 겹쳐 보이지만
`endpoint.ts` 로 간다. **함수명이 기준이고 줄 범위는 참고값이다.**

`parseGraphRecords` 를 함께 옮긴다. zod 로 노드와 관계를 가르는 순수 파싱이라 정규화 입력 만들기의 일부다.
남겨 두면 Phase 04 에서 쓰기 전용 `sync.ts` 에 홀로 남는다.

**타입도 함께 옮긴다.** 함수만 옮기면 컴파일이 깨진다.

| 타입 | 현재 줄 | 이동처 |
| --- | --- | --- |
| `NormalizedGraph` | 41 | `resolve.schema.ts` — `ResolveResult` 로 흡수 |
| `SkippedRelationshipSample`·`SkippedRelationshipsReport` | 30, 36 | `resolve.schema.ts` |
| `SourcedRecord` | 53 | `resolve.schema.ts` |
| `NodeRef` | 58 | `resolve/node-merge.ts` — `endpoint.ts` 도 쓰므로 여기서 내보낸다 |
| `ConceptSource` | 81 | `resolve/concept-alias.ts` |
| `DatabaseKey` | 80 | `neo4j/sync.ts` 잔류 — `databaseKey` 와 함께 |
| `PreparedLoadGraph` | 48 | **삭제.** `ResolveResult` 가 대체하므로 존재 이유가 없다 |

**`databaseKey` 는 옮기지 않는다. `neo4j/sync.ts` 에 남긴다.** 위 표에서 빠져 있는 것이 의도다.

`databaseKey` 는 `neo4j.int()` 를 쓴다. 옮기면 `resolve/node-merge.ts` 가 `neo4j-driver` 를
import 하게 되고 **"`resolve/` 는 Neo4j 를 모른다" 는 이 plan 의 핵심 원칙이 첫 커밋부터 깨진다.**
적재 키 변환은 쓰기 관심사다.

`resolve/` 는 `normalizedKey`(순수)까지만 담당한다. 선택지가 아니라 확정 사항이다.

완료 조건으로 기계 검증을 붙인다. 출력이 비어야 한다.

```bash
# cwd: 저장소 루트
grep -rn "neo4j-driver\|from \"neo4j\"" apps/pipeline/src/resolve/
```

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
  endpointIndex: EndpointIndex;
  previousDropped: readonly DroppedRelationship[];
}

export function resolveGraph(input: ResolveInput): ResolveResult;
```

뒤 두 필드가 왜 필요한지가 이 phase 의 핵심이다.

- **`endpointIndex`** — `sanitizeLlmRecords` 가 판정에 쓴다. 이 색인은 `data/raw/` 를 읽어야 만들어지므로
  `resolveGraph` 안에서 만들 수 없다. 만들면 순수 함수가 아니게 된다. 호출자가 만들어 넘긴다
- **`previousDropped`** — 현재 `sync-neo4j` 의 stdout `droppedRelationships` 는
  `inference-dropped-relationships.json` 의 누적분과 이번 실행분을 `mergeDroppedRelationships` 로 합친 값이다.
  이 인자가 없으면 이번 실행분만 남아 **적재 출력이 달라진다.** 동작 불변 리팩토링이 깨진다

내부 순서는 이렇다.

1. `sanitizeLlmRecords(inferred, previousDropped, endpointIndex)` 로 `inferred` 를 정리한다 (Phase 01 의 순수 함수)
2. 사전으로 별칭 맵을 만든다
3. `parsed` 와 정리된 `inferred` 를 합쳐 기존 `normalizeGraph` 로직을 흘린다

`resolveGraph` 안에서 **파일을 읽지도 쓰지도 마라.** 순수성이 Phase 03 의 전제다.

### 4. `sync.ts` 가 새 함수를 쓰게 고친다

`prepareLoadGraph` 를 `resolveGraph` 호출로 바꾸고 `PreparedLoadGraph` 타입을 지운다.
**읽기(`readJsonlRecords`·`loadConceptDictionary`)는 이번에 옮기지 않는다** — Phase 03 에서 `io.ts` 로 간다.
지금은 `sync.ts` 가 읽어서 `resolveGraph` 에 넘기는 형태로 둔다.

`sanitizeLlmGraphFile` **호출을 제거한다.** 적재가 더 이상 파일을 덮어쓰지 않는다.
정리는 `resolveGraph` 안에서 메모리로 이루어진다.

호출을 제거하면 `sync.ts` 가 세 가지를 직접 챙겨야 한다. 빠뜨리면 적재 출력이 달라진다.

1. `buildEndpointIndex(dataDir, project)` 로 색인을 만들어 넘긴다
2. `inference-dropped-relationships.json` 을 읽어 `previousDropped` 로 넘긴다
   (`readDroppedRelationships` 를 `export` 한다)
3. **리포트 파일을 다시 쓰지 않는다.** 적재는 읽기만 한다

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
| `apps/pipeline/src/infer/llm-relationship-sanitizer.ts` | 수정 — `buildEndpointIndex`·`EndpointIndex`·`readDroppedRelationships` 를 `export` |
| `apps/pipeline/src/neo4j/sync.test.ts` | 수정 — 이동한 함수 import 경로 |
| `apps/pipeline/test/sync.test.cjs` | 수정 — 같은 이유 |
| `apps/pipeline/package.json` | 수정 — test glob 에 `dist/resolve/*.test.js` 추가 |

**glob 을 빠뜨리면 `resolve/` 로 옮긴 테스트가 조용히 사라진다.** 현재 값에 `dist/resolve/` 가 없다.
`sync.test.ts` 의 정규화 테스트를 `resolve/` 로 옮기면 glob 갱신 없이는 실행 대상에서 빠지고,
테스트 개수만 줄어든 채 전부 통과로 보인다.

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
기준값은 api 51, pipeline 은 Phase 01 이 늘린 값이다.

`format:check` 가 걸려도 **포맷터를 파일 전체에 돌리지 마라.** 손댄 줄만 고친다.
이 phase 는 이동이 많아 재포맷 유혹이 크다. 재포맷 diff 에 실제 변경이 묻힌 사고가 이미 있었다.

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

**대상은 `bolt://localhost:7690` 이다.** 이 plan 작업 중 띄운 일회용 컨테이너다
(`devloop-plan001-neo4j`, `neo4j:5-community`, tmpfs, 인증 `neo4j/devloop-test-password`).

- 7688 은 다른 프로젝트가 점유 중이고 7687 은 운영이다. **둘 다 쓰지 마라**
- 7690 이 안 떠 있으면 같은 설정으로 다시 띄운다 (docker run -d --rm --name devloop-plan001-neo4j -p 7690:7687 --tmpfs /data --tmpfs /logs -e NEO4J_AUTH=neo4j/devloop-test-password neo4j:5-community)

```bash
# cwd: 저장소 루트
export NEO4J_URI=bolt://localhost:7690
export NEO4J_USER=neo4j
export NEO4J_PASSWORD=devloop-test-password
D=$(pwd)/apps/pipeline/data
```

**`NEO4J_AUTH` 가 아니라 `NEO4J_USER`·`NEO4J_PASSWORD` 를 쓴다.**
`neo4jCredentials()`(`neo4j-config.ts`)가 그 둘이 있으면 먼저 쓰고 `NEO4J_AUTH` 는 무시한다.
셸에 이전 값이 남아 있으면 `NEO4J_AUTH` 만 설정해서는 조용히 다른 자격증명으로 붙는다.

**컨테이너를 다시 띄웠으면 `pnpm apply-schema` 를 반드시 다시 돌려라.**
tmpfs 라 재기동 시 데이터뿐 아니라 제약·인덱스도 사라진다.
제약 없이 적재하면 MERGE 의 유일성 보장이 달라져 통계가 미묘하게 어긋난다.

절차는 이렇다. 빈 그래프에 **옛 코드와 새 코드로 각각 적재해 통계를 비교**한다.
운영 그래프의 현재 상태는 필요 없다 — 같은 입력에 같은 결과가 나오는지가 검증 대상이다.

**기준값은 코드를 고치기 전에 먼저 뽑아라.** 이 phase 의 첫 작업이다.

기준값은 `/tmp` 가 아니라 **저장소 안**에 둔다. phase 04 가 같은 파일을 재사용하고,
컨테이너가 죽어도 남으며, `git status` 에 보인다.

```bash
# cwd: 저장소 루트 — 아직 아무것도 고치지 않은 상태에서
B=tasks/plan001-resolve-graph-stage/baseline-load-stats

# 적재기는 MERGE 전용이다. 그래프가 비어 있지 않으면 기준값이 부풀려진다
docker exec devloop-plan001-neo4j cypher-shell -u neo4j -p devloop-test-password \
  'MATCH (n) RETURN count(n) AS nodes'   # 0 이어야 한다. 아니면 먼저 비운다

pnpm apply-schema
pnpm --filter pipeline sync-neo4j --project tc-ocr --data-dir "$D" | tee "$B.summary.txt"
```

**개수만 비교하면 놓치는 실패가 있다.** 라벨별·유형별 개수가 같아도 Concept 이 다른 대표로
병합되거나 관계 끝점이 다시 이어질 수 있다. 이번 plan 이 옮기는 것이 정확히 그 두 로직이라
가장 그럴듯한 실패 방식이 개수 비교를 통과한다. 키 집합도 함께 뜬다.

```bash
docker exec devloop-plan001-neo4j cypher-shell -u neo4j -p devloop-test-password --format plain \
  'MATCH (n) RETURN labels(n)[0] AS label, count(*) AS c,
     collect(DISTINCT coalesce(toString(n.number), n.key, n.pageId, n.name)) AS keys
   ORDER BY label' | sort > "$B.nodes.txt"
docker exec devloop-plan001-neo4j cypher-shell -u neo4j -p devloop-test-password --format plain \
  'MATCH (a)-[r]->(b) RETURN type(r) AS t, count(*) AS c,
     collect(DISTINCT [labels(a)[0], labels(b)[0]]) AS shape
   ORDER BY t' | sort > "$B.rels.txt"
```

그다음 구현하고, 끝난 뒤 같은 세 파일을 다시 떠서 비교한다.

```bash
# cwd: 저장소 루트 — 구현 완료 후
docker exec devloop-plan001-neo4j cypher-shell -u neo4j -p devloop-test-password 'MATCH (n) DETACH DELETE n'
# 초기화 직후에도 0 을 확인한다. 적재기가 MERGE 전용이라 잔여 노드가 있으면
# 새 코드가 노드를 덜 만드는 회귀가 그 잔여분에 가려져 diff 를 통과한다
docker exec devloop-plan001-neo4j cypher-shell -u neo4j -p devloop-test-password 'MATCH (n) RETURN count(n) AS c'
pnpm apply-schema
pnpm --filter pipeline sync-neo4j --project tc-ocr --data-dir "$D" | tee /tmp/after.summary.txt
# 위 두 Cypher 를 다시 실행해 /tmp/after.nodes.txt · /tmp/after.rels.txt 로 저장
diff "$B.summary.txt" /tmp/after.summary.txt
diff "$B.nodes.txt" /tmp/after.nodes.txt
diff "$B.rels.txt" /tmp/after.rels.txt
```

속성 값까지 전부 비교하지는 마라. 무겁고, `resolved.jsonl` 바이트 동등(Phase 03)이
다른 각도에서 잡아 준다.

**`git stash` 로 이전 코드를 되살려 뽑지 마라.** 그 시점에는 `resolve/` 아래 추적되지 않는
새 파일이 있고, `git stash` 는 `-u` 없이 untracked 를 담지 않는다.
`sync.ts` 만 되돌아가고 `resolve/` 는 남아 빌드가 어중간한 상태가 된다.

`--data-dir` 은 반드시 절대 경로다. 상대 경로는 pipeline 패키지 기준으로 풀려 파일을 못 찾는다.

비교 대상에 `droppedRelationships.count` 를 반드시 포함하라 — 위 4번 항목(누적 리포트)이
지켜졌는지가 이 숫자에 드러난다.

기준값을 못 뽑은 채 구현부터 시작했으면 `git worktree add` 로 이 phase 착수 커밋의 사본을 만들어
거기서 뽑아라. 어느 방법을 썼는지 보고에 적는다.

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

- 테스트용 Neo4j 인스턴스(7690)가 없어 적재 동등성을 확인할 수 없으면
  `PHASE_BLOCKED: 테스트 Neo4j 부재로 적재 동등성 검증 불가` 를 출력하고,
  **함수 본문 동등성과 단위 테스트까지는 완료한 상태로** 종료한다.
  7688·7687 로 대체하지 마라

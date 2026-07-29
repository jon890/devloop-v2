# Phase 03 — resolve-graph 명령과 입출력 계층을 붙인다

**Execution profile**: standard
**Status**: pending

---

## 목표

Phase 02 에서 만든 순수 함수 `resolveGraph` 에 **입출력을 붙여 CLI 단계로 만든다.**
정규화 결과를 파일로 내놓아 별칭 사전 변경 효과를 **적재 없이** 비교할 수 있게 한다.

```bash
# cwd: 저장소 루트
pnpm --filter pipeline resolve-graph --out /tmp/before.jsonl
# 사전 수정
pnpm --filter pipeline resolve-graph --out /tmp/after.jsonl
cmp /tmp/before.jsonl /tmp/after.jsonl
```

**범위 외**

- `sync-neo4j` 축소·`reset-neo4j` 신설·죽은 마이그레이션 삭제 — Phase 04
- `sync-neo4j` 가 `resolved.jsonl` 을 **읽게 만들지 마라.** 이건 설계 결정이다 (아래 의도 메모 참조)

---

## 작업 항목 (4)

### 1. `apps/pipeline/src/resolve/io.ts` — 읽기·쓰기 계층

```ts
export async function readResolveInput(dataDir: string, project: string): Promise<ResolveInput>;
export async function writeResolved(outPath: string, result: ResolveResult): Promise<void>;
export async function writeResolveReport(outPath: string, result: ResolveResult): Promise<void>;
```

`readResolveInput` 은 세 입력을 읽는다.

| 입력 | 경로 | 없을 때 |
| --- | --- | --- |
| `parsed.jsonl` | `<dataDir>/graph/<project>/` | **즉시 실패.** 필수 입력이다 |
| `inferred.jsonl` | 같은 위치 | **경고하고 빈 배열로 진행.** 구조만으로도 그래프가 성립한다 |
| Concept 사전 | `<dataDir>/concepts/<project>.json` | 코어 사전만으로 진행 (기존 동작) |

읽기 함수를 옮겨 온다 — `sync.ts` 의 `readJsonlRecords`(197행)와 `loadConceptDictionary`(98행)다.
**이 이동이 사전 로딩 중복을 없앤다.** 현재 `infer` 와 `sync` 가 각자 구현하고 있다.
`infer` 쪽(`llm-extractor.ts:108` `readProjectConcepts`)도 이 함수를 쓰게 바꿀 수 있는지 확인하고
결과를 보고하라. 시그니처가 어긋나 위험하면 바꾸지 말고 근거를 적어라.

### 2. 출력 순서를 고정한다

**같은 입력이면 바이트 동등해야 한다.** dry-run 비교의 전제다.

- 노드는 `라벨 → 키` 순
- 관계는 `유형 → 시작키 → 끝키` 순
- 정렬은 기존 `compareCodePoints` 를 재사용한다 (Phase 02 에서 `resolve/node-merge.ts` 로 옮겨진다)

`resolved.jsonl` 형식은 `parsed.jsonl`·`inferred.jsonl` 과 **같다.** 한 줄에 노드 하나 또는 관계 하나다.
기존 `graph-record.schema.ts` 를 재사용한다.

```jsonl
{"label":"Task","key":"483","properties":{"number":483,"subject":"..."}}
{"type":"MENTIONS","startKey":"Task:483","endKey":"Concept:api gateway","properties":{}}
```

**`resolved.jsonl` 첫 줄에 메타데이터를 넣지 마라.** 읽는 쪽이 모두 그 줄을 건너뛰어야 하고
그 규칙을 잊으면 조용히 깨진다. 리포트는 별도 파일이다.

### 3. `resolve-graph` 단계 등록

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/main.ts` | 스테이지 분기에 `resolve-graph` 추가 |
| `apps/pipeline/src/cli-options.ts` | `KNOWN_STAGES` 에 추가. `readFlag` 를 `sync.ts` 에서 이곳으로 올려 공용화한다 |
| `apps/pipeline/package.json` | `"resolve-graph": "pnpm build && node dist/resolve/resolve.js"` 형태로 추가 |

인자는 이렇다.

```
--project <code>      기본값은 기존 DEFAULT_PROJECT
--data-dir <절대경로>  기본값은 기존 sync-neo4j 와 동일
--out <경로>          기본값 <dataDir>/graph/<project>/resolved.jsonl
```

**`--data-dir` 은 절대 경로를 요구한다.** 상대 경로가 pipeline 패키지 기준으로 풀려
파일을 못 찾는 함정을 이미 겪었다. 상대 경로가 오면 거부하거나 명확히 해석하고 근거를 보고하라.

리포트 경로는 `--out` 과 같은 디렉터리에 `resolve-report.json` 으로 둔다.

### 4. 표준출력 요약

`sync-neo4j` 와 같은 형태의 JSON 요약을 낸다 — 노드·관계 수, 미매칭 Concept, 건너뛴 관계, 버린 관계.
Neo4j 통계는 없다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/resolve/io.ts` | 신규 |
| `apps/pipeline/src/resolve/resolve.ts` | 수정 — CLI 진입점 추가 |
| `apps/pipeline/src/main.ts` | 수정 — 스테이지 분기 |
| `apps/pipeline/src/cli-options.ts` | 수정 — 스테이지 목록, `readFlag` 공용화 |
| `apps/pipeline/src/neo4j/sync.ts` | 수정 — 읽기를 `io.ts` 로 넘기고 자체 `readFlag` 제거 |
| `apps/pipeline/package.json` | 수정 — 스크립트 추가 |
| `packages/shared/src/graph/graph.const.ts` | 수정 — `RESOLVED_GRAPH_FILE` 상수 추가 |
| 테스트 | 추가 — 아래 검증 참조 |

---

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

`pnpm --filter api test` 는 쓰지 마라 — exit 0 으로 조용히 통과한다. 테스트 **개수**를 확인하라.

### 재현성 (이 phase 의 핵심 통과 조건)

```bash
# cwd: 저장소 루트
pnpm --filter pipeline resolve-graph --project <코드> --data-dir <절대경로> --out /tmp/r1.jsonl
pnpm --filter pipeline resolve-graph --project <코드> --data-dir <절대경로> --out /tmp/r2.jsonl
cmp /tmp/r1.jsonl /tmp/r2.jsonl && echo "바이트 동등"
```

**차이가 나오면 이 단계의 존재 이유가 없다.** 정렬이 결정적이지 않은 지점을 찾아 고쳐라.

### 정렬 안정성 테스트 (필수)

`cmp` 통과는 우연일 수 있다. 테스트로 고정하라.

- 입력 레코드 순서를 뒤섞어도 출력이 같은지 단언한다
- **변이 검증** — 정렬 호출을 지웠을 때 그 테스트가 실제로 실패하는지 확인하고 원복한다.
  `git status` 가 깨끗한지 보여라

### 입력 부재 처리 테스트

- `parsed.jsonl` 없음 → 실패
- `inferred.jsonl` 없음 → 경고 후 진행, 구조 노드만 담긴 결과

---

## 의도 메모 (왜)

- **`sync-neo4j` 가 `resolved.jsonl` 을 읽지 않는 이유** — 정규화는 공짜다.
  결과를 캐싱해 적재에 먹여도 아끼는 것이 없고 **stale 위험만 생긴다.**
  앞 단계를 고치고 `resolve-graph` 를 안 돌리면 옛 결과로 적재된다.
  이 저장소는 같은 계열의 함정을 여러 번 겪었다 — Vite 사전 번들 캐시, 테스트 glob, 문서의 옛 참조
- **`--out` 을 둔 이유** — 사전 변경 전후를 비교하려면 두 파일이 필요하다
- **형식을 `parsed`·`inferred` 와 같게 두는 이유** — 기존 스키마를 재사용하고,
  사람이 나란히 놓고 무엇이 바뀌었는지 볼 수 있다
- 이 phase 가 Phase 04 의 무엇을 막아주나 — 읽기가 `io.ts` 로 빠지므로
  Phase 04 는 `sync.ts` 에서 **쓰기만 남기면** 된다

근거 문서 — `docs/adr/0004-resolve-as-inspection-stage.md`, `docs/data-schema.md`

---

## Blocked 조건

- 로컬 그래프 산출물이 없어 재현성을 확인할 수 없으면
  `PHASE_BLOCKED: 로컬 그래프 산출물 부재로 재현성 검증 불가` 를 출력하고 종료한다.
  `apps/pipeline/data/` 는 gitignore 대상이라 워크트리에 복제되지 않는다

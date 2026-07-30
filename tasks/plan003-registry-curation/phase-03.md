# Phase 03 — 사전 합성을 한 곳으로 모으고 재생성이 판단을 지우지 못하게 한다

**Execution profile**: standard
**Status**: completed

---

## 목표

**이 plan 의 본체다.** 앞 두 phase 는 그릇이었다.

판단을 표준 사전에 합성해 파이프라인이 실제로 쓰게 만들고,
`seed-concepts` 가 사람 판단을 지우지 못하게 판정 규칙을 고친다.

**범위 외**

- 실제 판단 주입 — Phase 04
- 정규화 판정 규칙 변경. `normalizeText`·`normalizeConceptKey` 의 **동작을 바꾸지 마라**
- LLM 추출 프롬프트 변경

---

## 배경 — 지금 판단이 지워지는 경로

실측으로 확인한 두 규칙이 맞물려 있다.

- `concepts/concept-seeder.ts` 의 `titleConcepts` 가 업무 제목에서 영문 토막을 뽑아
  **표준어(canonical)로 다시 만든다.** `Gateway` 가 그렇게 되살아난다
- 같은 파일의 `removeConflictingAliases` 가 **다른 항목의 표준어와 겹치는 별칭을 버린다.**
  그래서 `OCR API Gateway` 의 별칭 `Gateway` 가 사라진다

그리고 기존 사전 항목은 **원천에서 다시 만들어진 경우에만** 살아남는다.

```ts
for (const existing of existingConcepts) {
  if (concepts.has(existing.canonical)) mergeConcept(concepts, existing);
}
```

즉 판단을 사전 파일에 적어도 재생성이 지운다. 그것이 이 plan 이 존재하는 이유다.

---

## 작업 항목 (5)

### 1. `normalizeConceptKey` 계열을 `packages/shared` 로 옮긴다

registry 와 resolve 가 **같은 함수**를 써야 한다. 두 정규화가 갈리면 판단이 조용히 어긋난다.

- `resolve/concept-alias.ts` 의 `normalizeText`·`normalizeConceptKey`·`conceptLookupKeys` 를
  `packages/shared/src/concept/` 으로 옮긴다
- **본문을 고치지 마라.** 이동만 한다. import 줄과 `export` 추가만 허용된다
- 순수 TS 이므로 웹 번들에 문제가 없다
- Phase 02 가 이미 이 이동을 수행했다면 건너뛰고 그 사실을 보고하라

`normalizeText` 는 참조 해석(`addEndpointAlias`·`resolveEndpoint`)에도 쓰인다.
**함부로 바꾸면 관계가 깨진다.** 이동만 하는 이유가 그것이다.

### 2. 사전 합성을 한 함수로 모은다

지금 사전 읽기가 두 곳에 있다.

| 위치 | 문제 |
| --- | --- |
| `resolve/io.ts` 의 `loadConceptDictionary` | 판단을 여기에만 반영하면 추출이 못 본다 |
| `infer/llm-extractor.ts:108` 의 `readProjectConcepts` | 자체 구현이라 판단이 반영되지 않는다 |

**하나로 통일한다.** 생성 사전과 판단을 받아 `ConceptDictionary` 를 만드는 함수 하나를 두고
두 경로가 그것을 쓴다. `readProjectConcepts` 는 제거한다.

합성 규칙이다.

- 판단의 `merge_alias` 는 해당 `canonical` 항목의 별칭으로 들어간다
- 판단이 별칭으로 선언한 이름이 생성 사전에서 **독립 표준어로 존재하면 그 항목을 제거**하고
  별칭으로 흡수한다. 남기면 표준어와 별칭이 충돌해 적재가 예외로 죽는다
- 판단의 `block` 은 자동 병합 차단 목록으로 들어간다.
  `resolve/concept-alias.const.ts` 의 `CONCEPT_KEY_MERGE_DENYLIST` 를 대체한다
- 합성 결과의 순서가 **결정적**이어야 한다. `resolve-graph` 의 바이트 동등이 여기에 달렸다

### 3. `seed-concepts` 가 판단을 이기지 못하게 한다

`concept-seeder.ts` 를 고친다.

- 판단을 읽어, **판단이 별칭으로 선언한 이름을 표준어로 만들지 않는다** (`titleConcepts` 결과에서 제외)
- **`removeConflictingAliases` 가 판단으로 등록된 별칭을 버리지 않는다**
- 판단 조회 실패는 즉시 실패다. 판단을 조용히 빼고 사전을 만들면 잘못된 사전이 산출된다
- 판단이 0건인 것은 정상이다. "판단 0건 적용" 을 출력해 **없다** 와 **못 읽었다** 를 구분한다

### 4. 전역 canonical override 를 제거하고 legacy 차단은 임시 fallback 으로 유지한다

`CONCEPT_KEY_CANONICAL_OVERRIDES` 는 빈 Map 이므로 없앤다.
`CONCEPT_KEY_MERGE_DENYLIST` 의 기존 2건은 이 phase 에서 제거하지 않고 임시 fallback 으로 유지한다.

- 차단 2건은 Phase 04 가 DB 로 주입한 뒤 fallback 을 제거한다.
  이 순서로 보호가 비는 구간을 없애고 판단 0건 산출물 불변을 보장한다
- `CONCEPT_KEY_CANONICAL_OVERRIDES` 제거 근거는
  [ADR 0005](../../docs/adr/0005-curation-in-relational-store.md) 에 있다
- 임시 fallback 은 Phase 04 완료 전까지만 존재한다.
  DB 주입 후에도 남겨 두면 판단 저장소와 코드가 같은 값을 중복 소유하므로 반드시 제거한다

### 5. `sync-neo4j`·`resolve-graph` 의 읽기 경계 유지

`resolve/io.ts` 의 `readResolveInput` 이 판단을 조회해 `ResolveInput` 에 담는다.

- **`resolveGraph` 를 건드리지 마라.** 순수 함수로 유지한다.
  판단은 이미 합성된 사전으로 들어온다 ([ADR 0004](../../docs/adr/0004-resolve-as-inspection-stage.md))
- 조회는 `io.ts` 안에서만 한다. `resolve/` 의 다른 파일이 DB 를 알면 안 된다

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `packages/shared/src/concept/*` | 수정 — 정규화 함수 이동 |
| `packages/registry/src/curation.service.ts` | 수정 — 필요 시 조회 표면 조정 |
| `apps/pipeline/src/resolve/io.ts` | 수정 — 판단 조회와 합성 |
| `apps/pipeline/src/resolve/concept-alias.ts` | 수정 — 이동한 함수 import |
| `apps/pipeline/src/resolve/concept-alias.const.ts` | 수정 — 빈 canonical override 제거, legacy 차단 fallback 유지 |
| `apps/pipeline/src/concepts/concept-seeder.ts` | 수정 — 판정 규칙 |
| `apps/pipeline/src/infer/llm-extractor.ts` | 수정 — `readProjectConcepts` 제거 |
| 테스트 | 추가·수정 |

---

## 검증

```bash
# cwd: 저장소 루트
pnpm --filter @devloop/shared build
pnpm -r build
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

**`packages/shared` 를 고쳤으므로 먼저 재빌드해야 한다.**
`pnpm --filter api test:unit` 은 shared 를 재빌드하지 않아, 빠뜨리면 변경이 반영되지 않은
상태로 통과한다 — 이 저장소에서 실제로 그것에 속아 "가드가 없다" 고 오판한 전례가 있다.

### 판단이 재생성을 견디는지 (이 phase 의 핵심 통과 조건)

```bash
# cwd: 저장소 루트
# 1. 판단 1건을 넣는다 (Gateway → OCR API Gateway)
pnpm --filter pipeline import-curation --project tc-ocr --file <절대경로>
# 2. 사전을 재생성한다
pnpm --filter pipeline seed-concepts --project tc-ocr
# 3. 생성된 사전에서 확인한다
```

- `Gateway` 가 **독립 표준어로 존재하지 않는다**
- `OCR API Gateway` 의 별칭에 `Gateway` 가 **남아 있다**

**이 확인이 이 plan 전체의 목적이다.** 실패하면 나머지가 다 통과해도 의미가 없다.

### 산출물 동등성

판단이 **0건일 때** 이 변경은 동작 불변이어야 한다.

```bash
# cwd: 저장소 루트
# 판단이 비어 있는 상태에서
pnpm --filter pipeline resolve-graph --project tc-ocr \
  --data-dir "$(pwd)/apps/pipeline/data" --out /tmp/r-after.jsonl
cmp /tmp/r-before.jsonl /tmp/r-after.jsonl
```

`/tmp/r-before.jsonl` 은 이 phase 시작 전 코드로 뽑는다. **어떻게 뽑았는지 보고에 적어라.**
차이가 나면 합성 과정이 판단 없이도 사전을 바꾼 것이다 — 원인을 찾아 보고하라.

### 변이 검증 (필수)

- `removeConflictingAliases` 의 판단 예외를 무력화 → 재생성 견디기 테스트가 실패하는지
- 합성 결과 정렬을 무력화 → 바이트 동등 테스트가 실패하는지
- 각각 확인 후 원복하고 `git status` 가 깨끗한지 보여라

### 사전 읽기 단일화 확인

```bash
# cwd: 저장소 루트
grep -rn "readProjectConcepts" apps/pipeline/src --include="*.ts"
```

출력이 0줄이어야 한다.

---

## 의도 메모 (왜)

- **사전 읽기를 통일하는 이유** — 두 곳에 있으면 판단이 한쪽에만 반영된다.
  추출은 옛 사전을, 적재는 새 사전을 보는 상태가 조용히 생긴다
- **판단이 표준어를 이기게 하는 이유** — 원천 제목은 사람이 뜻을 확인하지 않은 문자열이고,
  판단은 사람이 근거를 확인한 결론이다. 뒤쪽이 이겨야 한다
- **상수를 지금 없애는 이유** — 두 곳에 차단이 있으면 어느 쪽이 적용됐는지 알 수 없다.
  Phase 04 가 바로 이어지므로 비어 있는 구간은 짧다
- **판단 0건 동작 불변을 요구하는 이유** — 합성을 넣은 것만으로 결과가 바뀌면
  Phase 04 에서 무엇이 판단 효과이고 무엇이 합성 부작용인지 가릴 수 없다

---

## Blocked 조건

- `postgres-test` 를 띄울 수 없어 재생성 견디기를 확인할 수 없으면
  `PHASE_BLOCKED: 테스트 Postgres 부재로 재생성 견디기 검증 불가` 를 출력하고,
  **단위 테스트와 산출물 동등성까지는 완료한 상태로** 종료한다
- `apps/pipeline/data/` 가 없어 산출물 동등성을 확인할 수 없으면
  `PHASE_BLOCKED: 로컬 그래프 산출물 부재` 를 출력한다. gitignore 대상이라 워크트리에 복제되지 않는다

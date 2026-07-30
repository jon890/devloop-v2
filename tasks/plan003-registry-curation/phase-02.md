# Phase 02 — repository 와 service 계층을 만들고 주고받기 명령을 붙인다

**Execution profile**: standard
**Status**: completed

---

## 목표

Phase 01 의 표 위에 **읽기·쓰기 계층**을 올리고 `import-curation`·`export-curation` 을 만든다.
파이프라인 단계는 아직 이 계층을 쓰지 않는다 — Phase 03 이 연결한다.

계층 경계 규칙은 `docs/code-architecture.md` 의 "repository 는 트랜잭션을 열지 않는다" 절이 소유한다.
**그 문서를 다시 쓰지 마라.** 어긋나면 보고하라.

**범위 외**

- 사전 합성·seeder 수정 — Phase 03
- 실제 판단 주입 — Phase 04
- HTTP 엔드포인트. 화면은 plan004 다

---

## 작업 항목 (5)

### 1. `curation.schema.ts` — 주고받는 JSON 계약

zod 로 쓴다. 이 저장소 관례는 zod 를 `*.schema.ts` 에 두는 것이다.

```json
{
  "project": "tc-ocr",
  "merges": [
    { "canonical": "OCR API Gateway", "aliases": ["Gateway", "api gateway"],
      "reason": "...", "approvedAt": "2026-07-28" }
  ],
  "blocks": [{ "key": "gateway api", "reason": "..." }]
}
```

- `reason` 은 **필수다.** 근거 없는 판단을 넣을 수 없게 한다.
  왜 합쳤는지가 판단과 같은 파일에 있어야 반년 뒤에 되짚을 수 있다
- `approvedAt` 은 선택이다 (`block` 에는 승인 개념이 약하다)
- **봉투에 `exportedAt` 같은 시각을 넣지 마라.** 내용이 같아도 매번 바이트가 달라져
  비교로 변경을 읽을 수 없게 된다

### 2. `curation.repo.ts` — repository

**트랜잭션을 열지 않는다.** 실행자를 인자로 받는다.

```ts
type Executor = NodePgDatabase | PgTransaction;

export function selectDecisions(db: Executor, projectId: number): Promise<DecisionRow[]>;
export function insertDecisions(db: Executor, rows: NewDecisionRow[]): Promise<void>;
export function deleteDecisionsByProject(db: Executor, projectId: number): Promise<number>;
```

`selectDecisions` 의 **정렬을 시그니처 주석에 명시한다.**
`ORDER BY canonical, key_norm` 처럼 결정적이어야 한다 —
정렬이 없으면 실행마다 순서가 달라지고, Phase 03 이 그 결과로 사전을 합성하므로
`resolve-graph` 의 바이트 동등이 조용히 깨진다.

### 3. `curation.service.ts` — service

**트랜잭션은 여기서만 연다.**

```ts
export function readCuration(db: NodePgDatabase, project: string): Promise<Curation>;
export function upsertCuration(db: NodePgDatabase, project: string, input: Curation): Promise<WriteResult>;
export function replaceCuration(db: NodePgDatabase, project: string, input: Curation): Promise<WriteResult>;
```

- `replaceCuration` 은 삭제와 삽입이 **한 원자 단위**여야 하므로 트랜잭션으로 감싼다
- `readCuration` 은 **트랜잭션을 감싸지 마라.** 읽기 전용이다.
  습관적으로 감싸면 무엇이 원자 단위인지가 흐려진다
- 입력 검증 실패는 쓰기 전에 행별 `rejected` 로 걸러낸다.
  `reason` 누락, 입력 안의 `key_norm` 중복, 같은 별칭이 두 canonical 에 붙은 경우가 여기에 해당한다
- 없는 프로젝트는 쓰기 전에 실패하고 **등록된 프로젝트 목록을 함께 출력**한다
- 사전 검증을 통과한 행의 `delete`·`insert` 또는 upsert 전체는 한 트랜잭션으로 적용한다
- 사전 검증을 통과했는데 unique·check 같은 DB 제약이 실패하면 버그나 경쟁 상태로 보고
  **전체 롤백하며 명령을 0이 아닌 종료 코드로 끝낸다**
- 트랜잭션이 성공해도 `rejected` 는 결과에 포함한다.
  어느 판단이 왜 빠졌는지가 다음 행동을 결정한다

`key_norm` 계산이 필요하다. `normalizeConceptKey` 를 **복제하지 마라** —
Phase 03 이 `packages/shared` 로 옮긴다. 이 phase 에서 먼저 필요하면
**Phase 03 의 이동을 이 phase 로 끌어와 수행하고 그 사실을 보고하라.**
복제본을 만들면 두 정규화가 갈려 판단이 조용히 어긋난다.

### 4. 프로젝트 등록과 `import-curation` 명령

판단을 넣기 전에 프로젝트와 선택적 소스를 명시적으로 등록한다.

```bash
pnpm --filter pipeline register-project --code <code> --name <name> \
  [--source-kind dooray|github] [--source-key <external-key>]
```

- 프로젝트 코드를 코드나 기본값에 박지 않고 인자로만 받는다
- `project.code` 와 `source(kind, external_key)` 유일 제약을 이용해 멱등하게 만든다.
  두 번째 실행은 "이미 등록됨" 을 출력하고 성공한다
- `--source-kind` 와 `--source-key` 는 함께 주거나 함께 생략한다. 한쪽만 주면 거부한다
- 접속 대상을 출력할 때 비밀번호는 가리고 host·port 는 남긴다
- `import-curation` 은 없는 프로젝트를 자동 생성하지 않는다.
  실패하고 등록된 프로젝트 목록을 출력해 코드 오타를 드러낸다

```
pnpm --filter pipeline import-curation --project <code> --file <절대경로> [--replace] [--dry-run]
```

- **`--file` 은 절대 경로만 받는다.** 상대 경로가 패키지 기준으로 풀려 파일을 못 찾는 함정을 겪었다
- 기본은 `upsert` 다. `--replace` 만 프로젝트 단위 교체를 한다 —
  기본을 교체로 두면 옛 덤프를 잘못 넣었을 때 나중에 화면에서 입력한 판단까지 날아간다
- `--dry-run` 은 무엇이 바뀔지만 출력하고 쓰지 않는다
- 표준출력은 JSON 요약이다 (`sync-neo4j` 와 같은 형태)

```json
{ "project": "tc-ocr", "applied": { "merges": 5, "blocks": 2 },
  "skipped": { "unchanged": 0 }, "rejected": [] }
```

### 5. `export-curation` 명령

```
pnpm --filter pipeline export-curation --project <code> --out <절대경로>
```

**같은 DB 상태면 같은 바이트가 나와야 한다.** 배열을 결정적으로 정렬하라.
이것이 지켜지지 않으면 비공개 보관본을 비교해 변경을 읽을 수 없다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `packages/registry/src/curation.schema.ts` | 신규 |
| `packages/registry/src/curation.repo.ts` | 신규 |
| `packages/registry/src/curation.service.ts` | 신규 |
| `packages/registry/src/project.repo.ts` | 신규 |
| `apps/pipeline/src/registry/import-curation.ts` | 신규 |
| `apps/pipeline/src/registry/export-curation.ts` | 신규 |
| `apps/pipeline/src/registry/register-project.ts` | 신규 |
| `apps/pipeline/src/main.ts` | 수정 — 명령 분기 |
| `apps/pipeline/package.json` | 수정 — 스크립트 |
| 테스트 | 추가 |

---

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

테스트 **개수**를 확인하라. api 51 불변, pipeline 은 120 에서 늘어야 하며
Phase 01 결과보다도 줄지 않아야 한다.

### 왕복 동등성 (이 phase 의 핵심 통과 조건)

```bash
# cwd: 저장소 루트
export NEO4J_URI=bolt://localhost:7690   # plan002 이후 필수값이라 설정만 통과시키려면 필요
export REGISTRY_DATABASE_URL=postgresql://devloop:devloop-test-password@localhost:15435/devloop_registry
docker compose --profile test up -d postgres-test
pnpm --filter pipeline register-project --code tc-ocr --name tc-ocr --source-kind dooray --source-key tc-ocr
pnpm --filter pipeline export-curation --project tc-ocr --out /tmp/c1.json
pnpm --filter pipeline import-curation --project tc-ocr --file /tmp/c1.json --replace
pnpm --filter pipeline export-curation --project tc-ocr --out /tmp/c2.json
cmp /tmp/c1.json /tmp/c2.json && echo "왕복 바이트 동등"
```

차이가 나오면 정렬이 결정적이지 않거나 봉투에 시각이 들어간 것이다.
**대상은 `postgres-test`(15435) 다.** 개발 인스턴스를 실험으로 더럽히지 마라.

### 계층 경계 확인 (필수)

- `curation.repo.ts` 에 `transaction` 호출이 **없다**

    ```bash
    grep -n "transaction" packages/registry/src/*.repo.ts
    ```

    출력이 0줄이어야 한다. 있으면 경계 위반이다

- `replaceCuration` 이 중간에 실패하면 삭제도 되돌아간다 —
  삽입 중 제약 위반을 강제로 일으켜 확인하고, 기존 행이 그대로 남아 있는지 단언한다
- **변이 검증** — `replaceCuration` 의 트랜잭션을 벗겨냈을 때 그 테스트가 실제로 실패하는지
  확인하고 원복한다. `git status` 가 깨끗한지 보여라

### 거부 처리 확인

- 같은 별칭이 두 canonical 에 붙은 입력 → 그 행만 `rejected`, 나머지는 적용
- `reason` 이 없는 입력 → 스키마 단계에서 거부
- 없는 프로젝트 → 실패하고 등록된 목록 출력

---

## 의도 메모 (왜)

- **service 를 패키지 안에 두는 이유** — plan004 의 API 가 같은 불변식을 써야 한다.
  서비스가 앱 쪽에 있으면 트랜잭션 경계가 두 곳으로 복제되고 두 경로가 갈린다
- **`reason` 을 필수로 하는 이유** — 판단의 값은 결론이 아니라 근거다.
  근거가 없으면 다음 사람이 되짚을 수 없어 다시 조사하게 된다
- **거부를 전체 롤백으로 처리하지 않는 이유** — 5쌍 중 1쌍이 틀렸을 때 4쌍을 버릴 이유가 없다.
  무엇이 왜 거부됐는지가 다음 행동을 결정한다
- 이 phase 가 Phase 03 의 무엇을 막아주나 — 읽기 계층이 결정적 순서를 보장하므로
  Phase 03 은 **합성만** 하면 된다

---

## Blocked 조건

- `postgres-test`(15435)를 띄울 수 없으면 `PHASE_BLOCKED: 테스트 Postgres 부재` 를 출력하고
  **단위 테스트까지는 완료한 상태로** 종료한다. 개발 인스턴스로 대체하지 마라

# Phase 01 — Postgres 와 registry 패키지 골격을 세운다

**Execution profile**: standard
**Status**: pending

---

## 전제

이 phase 는 **plan002 가 만드는 `apps/pipeline/src/config/` 를 전제한다.**
접속 설정을 그 모듈 위에 얹기 때문이다.
base 브랜치에 그 디렉터리가 없으면 멈추고 조정자에게 알려라.

---

## 목표

판단 저장소를 담을 그릇을 만든다. 표와 접속과 마이그레이션 적용까지다.
**판단을 읽거나 쓰는 코드는 만들지 않는다** — Phase 02 의 몫이다.

설계 근거는 [ADR 0005](../../docs/adr/0005-curation-in-relational-store.md) 와
`docs/data-schema.md` 의 "판단 저장소" 절이다. **그 문서를 다시 쓰지 마라.**

**범위 외**

- repository·service·CLI 명령 — Phase 02
- 사전 합성과 seeder 수정 — Phase 03
- 판단 주입 — Phase 04
- `source` 표에 수집 설정·마지막 수집 시각 컬럼 추가. 쓰지 않을 컬럼을 미리 만들지 않는다

---

## 작업 항목 (4)

### 1. `docker-compose.yml` 에 서비스 둘을 더한다

기존 `neo4j`·`neo4j-test` 구성을 그대로 대칭 복제한다.

| 서비스 | 포트 | 성격 |
| --- | --- | --- |
| `postgres` | `15434` → 5432 | 볼륨 유지 |
| `postgres-test` | `15435` → 5432 | `profiles: ["test"]`, `tmpfs`, `healthcheck` |

포트는 실측으로 비어 있는 값을 골랐다. **5432·15432·15433 은 다른 프로젝트가 쓴다.**
띄우기 전에 다시 확인하고, 점유돼 있으면 임의로 바꾸지 말고 조정자에게 알려라.

`healthcheck` 는 `neo4j-test` 와 같은 형태로 만든다 — 컨테이너가 준비되기 전에 테스트가
붙어 실패하는 것과, 테스트가 실제로 실패하는 것을 구분해야 한다.
이 저장소는 그 구분이 안 되어 e2e 결함이 오래 숨어 있던 전례가 있다.

### 2. `packages/registry` 신설

```
packages/registry/
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── migrations/            생성된 .sql — 커밋한다
└── src/
    ├── index.ts
    ├── client.ts          연결 풀 생성
    └── schema.ts          표 정의 (단일 소스)
```

의존은 `drizzle-orm`·`pg` (런타임), `drizzle-kit` (개발)이다.

**`packages/shared` 에 넣지 마라.** 웹이 `packages/shared` 를 import 하므로
Node 전용 코드가 브라우저 번들로 끌려간다. 이것이 별도 패키지인 유일한 이유다.

`client.ts` 는 **설정을 검증하지 않는다.** 검증된 값을 인자로 받는다 —
검증은 `apps/pipeline/src/config/` 의 책임이다.

### 3. `schema.ts` — 표 3개

정확한 컬럼·키·제약은 `docs/data-schema.md` 의 "판단 저장소" 절이 소유한다.
그 문서를 읽고 1:1 로 옮겨라. 어긋나면 **문서를 고치지 말고 보고하라.**

특히 지켜야 할 것 세 가지다.

- `concept_decision` 에 `unique (project_id, key_norm)` — **이 표의 존재 이유다**
- `kind` 는 `merge_alias`·`block` 두 값만 허용한다. `override` 는 만들지 않는다
- `canonical` 은 `merge_alias` 일 때만 있어야 한다. check 제약으로 강제한다

`key_norm` 은 `normalizeConceptKey` 결과다. **그 함수를 registry 안에 복제하지 마라** —
Phase 03 이 `packages/shared` 로 옮긴다. 이 phase 에서는 정규화가 필요한 코드를 쓰지 않으므로
의존이 아직 없다.

### 4. `migrate-registry` 명령

```
pnpm migrate-registry
```

- `apps/pipeline/src/registry/migrate.ts` 에 둔다. `apply-schema` 가 `neo4j/` 에 있는 것과 같은 대칭이다
- 마이그레이션은 `drizzle-kit` 으로 생성하고 **생성된 `.sql` 을 커밋한다.**
  표·컬럼 이름뿐이라 사내 정보가 없다
- 적용 후 적용 건수를 출력한다 (`apply-schema` 가 문장 수를 출력하는 것과 같은 형태)
- 두 번 실행해도 안전해야 한다. 두 번째 실행에서 적용 0건이 나오는지 확인하라

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `docker-compose.yml` | 수정 — 서비스 2개 |
| `packages/registry/**` | 신규 |
| `apps/pipeline/src/registry/migrate.ts` | 신규 |
| `apps/pipeline/src/config/pipeline-config.schema.ts` | 수정 — 접속 설정 추가 |
| `apps/pipeline/package.json`·루트 `package.json` | 수정 — 스크립트 |
| `pnpm-workspace.yaml` | 확인 — `packages/*` 가 이미 포함되는지 |

---

## 검증

```bash
# cwd: 저장소 루트
pnpm install
pnpm -r build
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

`pnpm --filter api test` 는 쓰지 마라 — exit 0 으로 조용히 통과한다. 테스트 **개수**를 확인하라.

### 마이그레이션 적용 확인

```bash
# cwd: 저장소 루트
docker compose up -d postgres
pnpm migrate-registry          # 적용 건수 > 0
pnpm migrate-registry          # 적용 건수 0
```

두 번째 실행이 0건이 아니면 멱등하지 않다. 고쳐라.

### 제약이 실제로 막는지 확인 (필수)

표만 만들고 넘어가면 제약이 동작하는지 알 수 없다. **직접 넣어 보고 거부되는지 확인하라.**

- 같은 `(project_id, key_norm)` 을 두 번 넣으면 거부된다
- `kind = 'block'` 인데 `canonical` 이 있으면 거부된다
- `kind = 'merge_alias'` 인데 `canonical` 이 없으면 거부된다
- 없는 `project_id` 를 참조하면 거부된다
- `project` 를 지우면 `source`·`concept_decision` 이 함께 사라진다

`postgres-test`(15435)에서 확인하고 **어느 포트를 썼는지 보고에 적어라.**
`15434` 는 개발용이므로 제약 실험으로 더럽히지 마라.

---

## 의도 메모 (왜)

- **표만 만들고 읽기·쓰기를 안 만드는 이유** — 스키마가 틀리면 그 위에 쌓은 계층을 전부 고쳐야 한다.
  제약이 실제로 막는지 먼저 확인하고 계층을 올린다
- **`source` 에 안 쓸 컬럼을 만들지 않는 이유** — 마이그레이션이 있으므로 필요할 때 더하면 된다.
  미리 만든 컬럼은 무엇이 실제로 쓰이는지 흐린다
- **`override` 를 만들지 않는 이유** — 지금 그 표가 빈 Map 이고, 그것이 풀어 주려던 키 충돌이
  `unique` 제약으로 등록 시점에 차단된다. ADR 0005 에 근거가 있다
- 이 phase 가 뒤 phase 의 무엇을 막아주나 — 제약을 먼저 확인하므로 Phase 02 의 서비스가
  **불변식을 코드로 다시 구현하지 않아도 된다**

---

## Blocked 조건

- `15434` 또는 `15435` 가 점유돼 있으면 `PHASE_BLOCKED: 포트 점유` 를 출력하고
  **임의로 다른 포트를 고르지 말고** 조정자에게 알린다
- `docs/data-schema.md` 의 스키마 서술과 구현이 어긋나면
  `PHASE_BLOCKED: 문서와 스키마 불일치` 를 출력하고 문서를 고치지 않는다

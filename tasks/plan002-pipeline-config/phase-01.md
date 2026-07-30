# Phase 01 — 설정 모듈을 만들고 `.env` 를 읽는다

**Execution profile**: standard
**Status**: pending

---

## 목표

파이프라인에 검증된 설정 모듈을 만든다. 값 이관은 다음 phase 들이 한다.
이 phase 는 **그릇과 주입 경로만** 만든다.

`apps/api/src/config/` 가 같은 일을 이미 하고 있다. 그것을 대칭 복제한다 — 새 장치를 발명하지 마라.

**범위 외**

- `NEO4J_*` 이관 — Phase 02
- `LLM_*`·`PIPELINE_DATA_DIR` 이관 — Phase 03
- API 쪽 설정 변경. `apps/api` 를 건드리지 마라

---

## 배경

파이프라인이 `process.env` 를 16곳에서 직접 읽는다. 그래서 두 문제가 있다.

- 어떤 값이 필수이고 어떤 값에 기본값이 있는지 한곳에서 볼 수 없다
- **`.env` 를 아무도 읽지 않는다.** `node dist/main.js` 로 뜨기 때문이다.
  지금 `sync-neo4j` 가 7687 에 붙는 것은 환경변수 덕이 아니라 **코드 기본값 덕**이다

두 번째가 위험하다. API 에서 같은 구조 때문에 문서에 확정됐다고 적힌 모델이 아닌 모델로
질의가 돌고 있었다 ([ADR 0003](../../docs/adr/0003-fail-fast-config.md)).

---

## 작업 항목 (3)

### 1. `apps/pipeline/src/config/` 신설

`apps/api/src/config/` 의 파일 구성을 그대로 따른다.

| 파일 | 내용 |
| --- | --- |
| `pipeline-config.const.ts` | 기본값 상수 |
| `pipeline-config.schema.ts` | zod 스키마. **필수 값에는 기본값을 두지 않는다** |
| `pipeline-config.module.ts` | `@nestjs/config` 등록 |
| `index.ts` | 공개 표면 |

이번 phase 의 스키마에는 **아직 아무 값도 넣지 않는다.** 빈 스키마가 통과하는 것을 확인만 한다.
값은 Phase 02·03 이 하나씩 옮기며 추가한다. 그래야 어느 이관이 무엇을 깨뜨렸는지 가릴 수 있다.

### 2. `.env` 로딩을 켠다

`ConfigModule` 의 `envFilePath` 로 저장소 루트의 `.env` 를 읽게 한다.

- 파이프라인은 `apps/pipeline` 에서 실행되므로 **루트 `.env` 경로를 정확히 지정**해야 한다.
  상대 경로 해석이 실행 위치에 좌우되지 않는지 확인하라
- 이미 프로세스 환경에 있는 값이 `.env` 값을 **이긴다**. 명령줄에서 `NEO4J_URI=... pnpm ...` 로
  덮어쓰는 기존 사용법이 깨지면 안 된다. 이 우선순위를 테스트로 고정하라
- `.env` 가 없어도 기동은 성공해야 한다 (필수 값이 프로세스 환경에 있으면 된다)

### 3. 설정을 단계 함수로 내리는 경로를 만든다

단계 명령들은 DI 밖 평범한 함수다 (`main.ts` 의 스테이지 분기가 직접 호출한다).
**설정을 인자로 받는 형태**로 바꿀 통로를 만든다.

- `main.ts` 가 애플리케이션 컨텍스트에서 설정을 꺼내 단계 함수에 넘긴다
- 이번에는 통로만 만들고 실제로 넘기는 값은 없다. Phase 02 가 첫 값을 태운다
- **전역 접근자(어디서나 `getConfig()`)를 만들지 마라.** 그러면 값이 다시 흩어져 이관의 의미가 없다

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/config/*` | 신규 4개 |
| `apps/pipeline/src/app.module.ts` | 수정 — 모듈 import |
| `apps/pipeline/src/main.ts` | 수정 — 설정을 꺼내 단계로 내리는 통로 |
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

`pnpm --filter api test` 는 쓰지 마라 — `test` 스크립트가 없어 **exit 0 으로 조용히 통과**한다.
기대값 — api 51 불변, pipeline 91 에서 **늘어야 한다.**

### 동작 불변 확인

이 phase 는 값을 옮기지 않으므로 모든 단계가 그대로 동작해야 한다.

```bash
# cwd: 저장소 루트
NEO4J_URI=bolt://localhost:7690 pnpm --filter pipeline resolve-graph \
  --project tc-ocr --data-dir "$(pwd)/apps/pipeline/data" --out /tmp/p1-after.jsonl
```

변경 전 산출물과 `cmp` 로 비교하라. 변경 전 값은 `git stash` 또는 기준 커밋 사본에서 뽑는다.
**어느 방법을 썼는지 보고에 적어라.**

### `.env` 우선순위 테스트 (필수)

- 프로세스 환경에 있는 값이 `.env` 값을 이긴다
- `.env` 가 없어도 기동이 성공한다
- **변이 검증** — 우선순위를 뒤집었을 때 그 테스트가 실제로 실패하는지 확인하고 원복한다.
  `git status` 가 깨끗한지 보여라

---

## 의도 메모 (왜)

- **스키마를 빈 상태로 시작하는 이유** — 값을 한꺼번에 옮기면 회귀가 났을 때 어느 값 때문인지 가릴 수 없다.
  이 저장소는 포맷터를 전체에 돌려 기능 변경 93줄이 316줄 diff 에 묻힌 전례가 있다
- **`.env` 로딩을 켜는 이유** — 켜지 않으면 다음 phase 에서 `NEO4J_URI` 를 필수로 만들 수 없다.
  코드 기본값이 사실상 설정 역할을 하는 상태를 먼저 끊어야 한다
- **전역 접근자를 만들지 않는 이유** — `process.env` 를 전역에서 읽는 것과 차이가 없어진다

---

## Blocked 조건

- 루트 `.env` 가 없어 로딩 경로를 확인할 수 없으면
  `PHASE_BLOCKED: .env 부재로 로딩 경로 확인 불가` 를 출력하고 조정자에게 알린다.
  `.env` 는 gitignore 대상이라 워크트리에 복제되지 않는다

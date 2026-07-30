# Phase 03 — LLM 과 데이터 디렉터리 변수를 이관한다

**Execution profile**: standard
**Status**: pending

---

## 목표

남은 여섯 종을 설정 모듈로 옮겨 `process.env` 직접 읽기를 0으로 만든다.
**동작은 바꾸지 않는다** — 필수화는 Phase 02 의 `NEO4J_URI` 하나로 끝났다.

**범위 외**

- `NEO4J_*` — Phase 02 에서 끝났다
- LLM 어댑터의 호출 방식·모델 선택 로직. 값을 어디서 읽는지만 바꾼다

---

## 이관 대상 (9곳)

| 파일·줄 | 변수 | 현재 기본값 |
| --- | --- | --- |
| `main.ts:20` | `LLM_PROVIDER` | `codex` |
| `main.ts:66` | `LLM_MODEL` | 없음 |
| `main.ts:73` | `LLM_CONCURRENCY` | `4` |
| `main.ts:74` | `LLM_TIMEOUT_MS` | `120000` |
| `llm/codex-cli.adapter.ts:9` | `LLM_MODEL` | 없음 |
| `llm/codex-cli.adapter.ts:11` | `LLM_REASONING_EFFORT` | 없음 |
| `llm/claude-cli.adapter.ts:14` | `LLM_MODEL` | 없음 |
| `infer/llm-extractor.ts:351` | `LLM_REASONING_EFFORT` | 없음 |
| `cli-options.ts:83` | `PIPELINE_DATA_DIR` | 없음 |

줄 번호는 작성 시점 기준이다. 옮기기 전에 실제 위치를 다시 확인하라.

---

## 작업 항목 (4)

### 1. 스키마에 여섯 값을 더한다

| 값 | 필수 | 기본값 | 형태 |
| --- | --- | --- | --- |
| `LLM_PROVIDER` | 선택 | `codex` | **열거형으로 좁힌다** |
| `LLM_MODEL` | 선택 | 없음 | 문자열 |
| `LLM_REASONING_EFFORT` | 선택 | 없음 | 열거형 |
| `LLM_CONCURRENCY` | 선택 | `4` | 양의 정수 |
| `LLM_TIMEOUT_MS` | 선택 | `120000` | 양의 정수 |
| `PIPELINE_DATA_DIR` | 선택 | 없음 | 문자열 |

`LLM_PROVIDER` 를 열거형으로 좁히는 이유 — 오타(`codexx`)가 조용히 기본값으로 흘러가면
**의도한 것과 다른 CLI 로 추출이 돌아간다.** API 쪽 스키마가 같은 이유로 열거형을 쓴다.
그 목록을 재사용할 수 있는지 확인하고, 못 하면 근거를 적어라.

`LLM_MODEL` 을 필수로 만들지 마라. 어댑터가 모델 없이도 동작하는 경로가 있다
(`-m` 플래그를 붙이지 않는다). 그 동작을 바꾸는 것은 이 phase 범위가 아니다.

### 2. 아홉 곳을 설정 인자로 바꾼다

`process.env` 직접 읽기를 남기지 마라. 이관 후 확인한다.

```bash
# cwd: 저장소 루트
grep -rn "process.env" apps/pipeline/src --include="*.ts" | grep -v test
```

`config/` 안에서 읽는 것 외에 남으면 **왜 남겼는지 근거를 적어라.**

### 3. `cli-options.ts` 의 플래그 우선순위를 유지한다

`readDataDirFlag` 가 `--data-dir` 플래그를 환경변수보다 **먼저** 본다.
이 순서를 바꾸지 마라. 측정 스크립트가 플래그로 대상을 지정하는 것에 의존한다.

`--data-dir` 이 절대 경로를 요구하는 판정도 그대로 둔다.

### 4. `infer-knowledge` 경로 확인

`infer/llm-extractor.ts:351` 은 `options.effort` 가 있으면 그것을 쓰고 없으면 환경변수를 본다.
이 우선순위도 유지한다 — 호출자가 준 값이 이긴다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/pipeline/src/config/pipeline-config.schema.ts` | 수정 — 여섯 값 추가 |
| `apps/pipeline/src/main.ts` | 수정 |
| `apps/pipeline/src/llm/codex-cli.adapter.ts` | 수정 |
| `apps/pipeline/src/llm/claude-cli.adapter.ts` | 수정 |
| `apps/pipeline/src/infer/llm-extractor.ts` | 수정 |
| `apps/pipeline/src/cli-options.ts` | 수정 |
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

테스트 **개수**를 확인하라. api 51 불변, pipeline 은 Phase 02 결과에서 늘어야 한다.

### 동작 불변 확인 (필수)

**`infer-knowledge` 전체를 실행하지 마라 — 문서 537건에 LLM 을 호출한다.**

대신 아래로 확인한다.

- 어댑터가 만드는 인자 배열을 단위 테스트로 비교한다. 모델·effort 가 없을 때
  플래그를 **아예 붙이지 않는** 현재 동작이 유지되는지 단언한다.
  이 동작이 깨지면 CLI 가 자기 기본 모델로 돌아가고, 문서에 적힌 모델이 아닌 모델로 추출된다 —
  실제로 겪은 사고다
- `LLM_PROVIDER` 오타가 거부되는지 단언한다
- `readDataDirFlag` 의 플래그 우선순위와 절대 경로 요구를 단언한다

### 변이 검증 (필수)

- `LLM_PROVIDER` 열거형 판정을 무력화 → 오타 거부 테스트가 실패하는지
- 어댑터의 "값 없으면 플래그 생략" 을 무력화 → 인자 배열 테스트가 실패하는지
- 각각 확인 후 원복하고 `git status` 가 깨끗한지 보여라

### 마지막 확인

```bash
# cwd: 저장소 루트
grep -c "process.env" apps/pipeline/src/config/*.ts
grep -rn "process.env" apps/pipeline/src --include="*.ts" | grep -v test | grep -v "src/config/"
```

두 번째 명령의 출력이 **0줄**이어야 한다. 남았으면 근거를 보고하라.

---

## 의도 메모 (왜)

- **필수화를 더 하지 않는 이유** — LLM 값들은 없어도 동작하는 경로가 설계상 존재한다.
  없는 것을 오류로 만들면 동작 변경이 되고, 이 phase 는 불변 이관이다
- **열거형으로 좁히는 것은 필수화가 아니다** — 값이 없는 것은 허용하고 **틀린 값만** 막는다.
  조용히 다른 CLI 로 도는 사고를 막는 최소 조치다
- **`infer-knowledge` 를 돌리지 않는 이유** — 캐시 키에 `promptVersion` 이 들어 있어
  프롬프트를 건드리지 않으면 캐시가 맞지만, 어댑터 인자를 바꿨다면 캐시가 빗나갈 수 있다.
  537회 호출을 감수할 이유가 없다. 인자 배열 단위 테스트가 같은 것을 더 싸게 보장한다

---

## 마지막 phase 마무리

이 plan 의 마지막 phase 다. 검증을 모두 통과한 뒤 다음을 처리한다.

- `tasks/plan002-pipeline-config/index.json` 에서 이 phase 의 `status` 를 `completed` 로 바꾼다
- 세 phase 가 모두 `completed` 이면 최상위 `status` 도 `completed` 로 바꾼다
- 어느 phase 든 `PHASE_BLOCKED` 로 끝났으면 **`completed` 로 바꾸지 말고** 그 사유를 보고한다

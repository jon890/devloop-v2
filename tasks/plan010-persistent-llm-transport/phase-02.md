# Phase 02 — API 와 파이프라인을 상주 전송으로 옮기고 codex exec 를 제거한다

**Execution profile**: standard
**Status**: pending

---

## 목표

Phase 01 이 만든 전송 계층으로 두 앱의 호출자를 옮긴다. **프롬프트는 한 글자도 건드리지 않는다.**

전송만 바꾸는 이유다. 프롬프트를 함께 바꾸면 Phase 03 에서 지연이 줄었을 때 그것이 상주 모드
덕인지 프롬프트 덕인지 가를 수 없다. `plan008` 에서 두 지레를 함께 당겨 개선분의 원인을
잘못 이해한 사건이 이미 있었다 (`eval/reports/2026-08-04-plan009-comment-enrich.md`).

**이 phase 는 Phase 01 이 만드는 `packages/llm` 을 전제한다.**
`packages/llm/src/index.ts` 가 없으면 base 를 확인하고 멈춘다.

**범위 외**

- `outputSchema` 와 프롬프트 형식 문구 제거 — Phase 04
- 측정 — Phase 03
- 파이프라인 추출 프롬프트와 `EXTRACTION_PROMPT_VERSION` — **건드리지 마라.**
  바꾸면 캐시 537건이 무효화돼 재추출과 그래프 재적재가 딸려 온다
- `claude -p` 어댑터 — 각 앱에 그대로 남긴다

---

## 작업 항목 (5)

### 1. API 어댑터를 갈아 끼운다

`apps/api/src/llm/llm-cli.ts` 의 현재 구조다.

| 요소 | 처리 |
| --- | --- |
| `LlmCli` 인터페이스·`LLM_CLI` 심볼·`LlmResult` | 유지한다. 호출자 계약을 바꾸지 않는다 |
| `ChildProcessCliAdapter` (추상 기반) | `claude` 만 쓰게 남긴다 |
| `CodexCliAdapter` | **제거한다** |
| `ClaudeCliAdapter` | 유지한다 |
| `createLlmCli` | `provider === "claude"` 가 아니면 상주 어댑터를 준다 |

`apps/api/src/llm-cli.ts` 는 1줄 재export 파일이다 — 그대로 둔다.

**`complete` 의 시그니처를 바꾸지 마라.** `query.service.ts` 의 `completeStructured` 가
`(prompt, options)` 로 부른다. 이 phase 에서 호출자는 수정 대상이 아니다.

### 2. API 기동·종료에 서버 생명주기를 묶는다

`apps/api/src/app.module.ts` 가 `createLlmCli` 를 `LLM_CLI` 로 제공한다.

- 서버는 **기동 시 띄운다.** 첫 질의에서 늦게 띄우지 않는다 — 그러면 첫 질의만 느리고,
  실패했을 때 원인이 "서버 없음" 인지 "질의 오류" 인지 흐려진다
- 준비 확인에 실패하면 **기동을 실패시킨다** (ADR 0003 과 같은 결)
- 프로세스가 끝날 때 서버를 죽인다. NestJS 종료 훅에 붙인다
- `provider === "claude"` 면 서버를 띄우지 않는다. 안 쓰는 프로세스를 띄우면 안 된다

### 3. 파이프라인 어댑터를 갈아 끼운다

`apps/pipeline/src/llm/` 의 처리다.

| 파일 | 처리 |
| --- | --- |
| `codex-cli.adapter.ts` | **제거한다** (`buildCodexArgs` 포함) |
| `claude-cli.adapter.ts` | 유지한다 |
| `cli-process.ts` | `claude` 어댑터가 쓰면 남기고, 아무도 안 쓰면 제거한다 |
| `llm-cli.ts` (`LlmCli`·`LlmOptionsSchema`) | 유지한다. 단계 코드가 이 계약으로 부른다 |
| `index.ts` | 내보내는 목록을 맞춘다 |

파이프라인 CLI 는 **한 번 실행에 여러 호출**을 한다. 서버를 호출마다 띄우면 이득이 사라진다.
명령 시작에 한 번 띄우고 끝날 때 죽인다.

지금 `buildCodexArgs` 가 넘기는 값과 상주 모드의 대응이다. 실측으로 확인했다.

| 지금 | 상주 모드 |
| --- | --- |
| `--sandbox read-only` | `thread/start` 의 `sandbox: "read-only"` |
| `--ephemeral` | `thread/start` 의 `ephemeral: true` |
| `-m <모델>` | `turn/start` 의 `model` |
| `-c model_reasoning_effort=<값>` | `turn/start` 의 `effort` |
| `--output-last-message <경로>` | 필요 없다. `delta` 를 이어 붙여 본문을 만든다 |

`--output-last-message` 용 임시 디렉터리 생성·삭제 코드도 함께 사라진다.

### 4. 테스트를 계약에 맞춘다

**두 파일 모두 `codex exec` 인자를 검증한다.** 그 대상이 사라지므로 함께 고친다.

- `apps/pipeline/src/llm/cli-adapter.test.ts` — `buildCodexArgs` 테스트 3건을 지우고
  `buildClaudeArgs` 테스트 2건은 남긴다. 상주 어댑터의 계약 검증은 `packages/llm` 이 갖는다
- `apps/api/test/llm-cli.test.js` — codex 인자 검증 부분을 지우고 claude 쪽은 남긴다.
  `createLlmCli` 가 provider 에 따라 옳은 어댑터를 주는지도 확인한다

`apps/api/package.json` 의 `test:unit` 은 **테스트 파일을 하나씩 열거한다.**
파일을 더하거나 지우면 그 목록도 함께 고쳐야 한다. 빠뜨리면 새 테스트가 조용히 안 돌아간다.

파이프라인 `test` 스크립트는 `dist/llm/*.test.js` 글롭이라 목록 수정이 필요 없다.

### 5. 실제 호출 한 번으로 살아 있는지 확인한다

단위 테스트는 가짜 서버만 본다. 실제 `codex` 로 한 번은 확인해야 한다.

```bash
# cwd: 저장소 루트
cd apps/api && set -a && . ../../.env && set +a && nohup node dist/main.js >| /tmp/api-plan010.log 2>&1 &
# 기동 로그에 서버 주소가 찍히는지 확인한 뒤
curl -s -X POST localhost:3000/api/query -H 'content-type: application/json' \
  -d '{"question":"API 게이트웨이 요청 크기 제한은 어떻게 결정됐나"}' | head -c 400
```

`pnpm api` 를 백그라운드 명령 안에서 쓰지 마라 — 셸이 끝날 때 EPIPE 로 죽는다.
실측으로 측정 36회 중 35회를 `fetch failed` 로 잃은 사건이 있었다
(`docs/pitfalls/measurement.md`).

확인 후 프로세스를 정리한다. 남겨 두면 다음에 무엇이 살아 있는지 헷갈린다
(`docs/pitfalls/process-cleanup.md`).

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/api/src/llm/llm-cli.ts` | 수정 — `CodexCliAdapter` 제거 |
| `apps/api/src/app.module.ts` | 수정 — 서버 생명주기 |
| `apps/api/package.json` | 수정 — `@devloop/llm` 의존, 테스트 목록 |
| `apps/api/test/llm-cli.test.js` | 수정 |
| `apps/pipeline/src/llm/codex-cli.adapter.ts` | 제거 |
| `apps/pipeline/src/llm/index.ts` | 수정 |
| `apps/pipeline/src/llm/cli-adapter.test.ts` | 수정 |
| `apps/pipeline/package.json` | 수정 — `@devloop/llm` 의존 |

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter @devloop/llm test
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

`codex exec` 가 정말 사라졌는지 센다. **출력이 0줄이어야 한다.**

```bash
# cwd: 저장소 루트
grep -rn '"exec"' apps/api/src apps/pipeline/src --include='*.ts'
```

API 테스트 개수는 codex 인자 검증이 빠지므로 **줄어들 수 있다.** 줄어든 만큼이 지운 것과
맞는지 확인한다. 파이프라인 테스트도 같다.

## 의도 메모 (왜)

- **프롬프트를 안 건드리는 이유** — Phase 03 이 전송 전환만의 효과를 재야 한다. 두 지레를 함께
  당기면 무엇이 들었는지 모른다. `plan008` 에서 실제로 그렇게 됐다
- **`claude` 경로를 남기는 이유** — 모델 공급자를 바꿔 벤치마크할 여지를 남긴다 (ADR 0002).
  상주 모드는 `codex` 전용 프로토콜이라 그쪽에 같은 구조를 만들 수 없다
- **기동 시 서버를 띄우는 이유** — 늦게 띄우면 첫 질의만 느려지고, 실패 원인이 흐려진다.
  기동에서 실패하면 즉시 드러난다
- **파이프라인이 명령 단위로 서버를 갖는 이유** — CLI 는 한 번 실행에 여러 문서를 처리한다.
  호출마다 띄우면 상주의 의미가 없다

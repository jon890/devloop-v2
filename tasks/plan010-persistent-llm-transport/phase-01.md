# Phase 01 — packages/llm 에 상주 app-server 클라이언트와 서버 생명주기를 만든다

**Execution profile**: standard
**Status**: completed

---

## 목표

지금은 LLM 호출마다 `codex` 프로세스를 새로 띄운다. 그 기동에 약 8초가 든다.
질의당 호출이 3~5회이므로 **기동만으로 24~40초**가 나가고, 관측된 질의 지연 44~59초의 대부분이다.

상주 `codex app-server` 는 한 번 띄워 두고 WebSocket 으로 요청만 보낸다. 실측이다.

| 호출 방식 | 최소 프롬프트 | 27KB 프롬프트 |
| --- | --- | --- |
| `codex exec` | 8.0~12.0초 | 11.3~14.4초 |
| 상주 모드 | 2.0~5.5초 | 3.9~8.5초 |

이 phase 는 그 전송 계층만 만든다. **호출자를 바꾸지 않는다** — Phase 02 가 옮긴다.

설계 근거는 [ADR 0008](../../docs/adr/0008-persistent-llm-transport.md) 과
`docs/code-architecture.md` 의 `packages/llm` 절이다.

**범위 외**

- API·파이프라인 어댑터 교체와 `codex exec` 제거 — Phase 02
- 지연 측정 — Phase 03
- `outputSchema` — Phase 04. 이 phase 는 `outputSchema` 를 **전달만 할 수 있게** 열어 두고 쓰지 않는다
- `claude -p` 어댑터 — 각 앱에 그대로 남는다. 이 패키지로 옮기지 않는다
- 파이프라인 추출 프롬프트 — 건드리지 않는다. 캐시 537건이 무효화된다

---

## 작업 항목 (5)

### 1. 패키지 골격을 만든다

`pnpm-workspace.yaml` 은 이미 `packages/*` 를 담고 있어 **수정하지 않는다.**

`packages/registry` 를 본떠 만든다. 의존은 최소로 둔다.

```json
{
  "name": "@devloop/llm",
  "version": "0.0.0",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "pnpm build && node --test dist/*.test.js"
  }
}
```

`tsconfig.json` 은 `packages/registry/tsconfig.json` 과 같은 형태다 (`extends`·`outDir`·`rootDir`).

**새 런타임 의존을 넣지 마라.** WebSocket 은 Node 전역이다 (이 저장소는 Node 24 에서 돈다).
`ws` 같은 패키지를 추가하지 않는다.

### 2. 프로토콜 로직을 전송에서 떼어 낸다

**이게 이 phase 의 핵심 설계다.** 프로토콜 규칙을 순수하게 떼면 실제 서버 없이 테스트할 수 있다.

```ts
export interface JsonRpcTransport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  close(): void;
}
```

WebSocket 을 쓰는 구현과, 테스트에서 쓰는 메모리 구현이 이 인터페이스를 만족한다.
**서버를 띄우는 테스트로 프로토콜을 검증하려 하지 마라** — Node 에는 WebSocket 서버가 없어
의존을 새로 추가해야 하고, 검증 대상이 프로토콜이 아니라 네트워크가 된다.

프로토콜 규칙이다. 전부 스키마와 실측으로 확인한 것이다.

- 순서는 `initialize` → `thread/start` → `turn/start` 다.
  `initialize` 의 인자는 `{ clientInfo: { name, version } }` 다 — `clientName` 은 구세대 형식이라 거부된다
- **`turn/start` 는 즉시 응답하고 완료는 `turn/completed` 알림으로 온다.** 그 알림을 기다려야 한다
- **실패는 JSON-RPC 오류가 아니라 `turn/completed` 의 `turn.status === "failed"` 로 온다.**
  이걸 안 보면 실패를 성공으로 읽는다. `turn.error` 를 오류 메시지에 담는다
- 응답 본문은 `item/agentMessage/delta` 알림의 `delta` 를 이어 붙여 만든다.
  이 알림은 `threadId` 와 `turnId` 를 함께 실어 오므로 **동시 호출을 그 값으로 갈라낸다.**
  전역 변수 하나에 이어 붙이면 질의 두 건이 동시에 오면 본문이 섞인다
- **호출마다 새 thread 를 쓴다.** `thread/start` 인자는
  `{ model, cwd, sandbox: "read-only", approvalPolicy: "never", ephemeral: true }` 다.
  `sandbox` 와 `approvalPolicy` 를 빼면 모델이 명령을 실행하려 하거나 승인을 기다려 멈춘다
- 모델과 추론 강도는 `turn/start` 의 `model`·`effort` 로 넘긴다.
  지금 `codex exec` 의 `-m`·`-c model_reasoning_effort=` 와 같은 값이다
- 시간 초과 시 `turn/interrupt` 를 보낸 뒤 거부한다. 정리 없이 거부하면 서버에 턴이 남는다

thread 식별자는 `thread/start` 응답의 `thread.id` 다.
스키마상 `ThreadStartResponse` 는 `thread` 를 필수로 갖고 `Thread` 는 `id` 를 필수로 갖는다.
실측 탐침도 그 경로로 읽어 동작했다.

### 3. 서버 생명주기를 만든다

```ts
export interface AppServerHandle {
  readonly url: string;
  close(): Promise<void>;
}
export function startAppServer(opts: { cwd: string; readyTimeoutMs?: number }): Promise<AppServerHandle>;
```

규칙이다. 포트 자동 배정은 실측으로 확인했다.

- `codex app-server --listen ws://127.0.0.1:0` 으로 띄운다. **포트를 직접 고르지 마라** —
  고르면 이미 쓰는 포트와 부딪히고, 두 앱이 동시에 돌 때 충돌한다
- 서버가 배정된 포트를 **stdout 에 출력한다.** 그 줄을 파싱해 접속 주소를 얻는다

  ```
  codex app-server (WebSockets)
    listening on: ws://127.0.0.1:62734
    readyz: http://127.0.0.1:62734/readyz
  ```

- `http://127.0.0.1:<port>/readyz` 가 200 을 줄 때까지 기다린다.
  제한 시간 안에 안 되면 **거부한다.** 부분 성공을 허용하지 않는다 —
  서버 없이 뜬 API 는 모든 질의가 실패하므로 늦게 드러날 뿐이다 (ADR 0003)
- `close()` 는 자식 프로세스를 죽인다. 프로세스가 끝날 때 반드시 불리게 한다
- **서버 stdout·stderr 를 버리지 마라.** 원인을 볼 곳이 이것뿐이다.
  로그로 남기거나 오류 메시지에 마지막 몇 줄을 담는다

### 4. 어댑터를 공개한다

```ts
export interface LlmCompleteOptions {
  model: string;
  effort?: string;
  timeoutMs?: number;
  outputSchema?: Record<string, unknown>;
}
export interface LlmCompleteResult {
  text: string;
  elapsedMs: number;
}
```

`outputSchema` 는 **인자로만 열어 두고 이 phase 에서 쓰지 않는다.** Phase 04 가 채운다.
`model` 을 필수로 둔다 — 빠지면 CLI 기본 모델로 조용히 돌아가는 사고가 이미 있었다 (ADR 0003).

**어댑터가 서버 handle 을 소유하고 `close()` 를 노출한다.** 이게 공개 계약이다.

```ts
export interface LlmTransport {
  complete(prompt: string, opts: LlmCompleteOptions): Promise<LlmCompleteResult>;
  close(): Promise<void>;
}
```

`close()` 는 자기가 띄운 서버와 전송을 함께 닫는다. 호출자는 어댑터 하나만 들고 다니면 된다.

handle 을 호출자에게 따로 돌려주는 형태(`{ adapter, handle }`)를 쓰지 않는 이유다.
그러면 두 앱의 생성 지점이 각각 handle 을 보관할 자리를 만들어야 하고, 보관을 빠뜨리면
**서버를 죽일 대상이 사라져도 컴파일이 통과한다.** 어댑터가 소유하면 그 실수가 불가능하다.

`index.ts` 는 위 타입과 `startAppServer`, 어댑터 클래스만 내보낸다.
프로토콜 내부 구조를 밖으로 내보내지 않는다.

### 5. 테스트를 붙인다

메모리 전송으로 **프로토콜**을 검증한다.

- `turn/start` 응답만 오고 `turn/completed` 가 안 오면 완료로 판정하지 않는다
- `turn.status === "failed"` 면 거부하고 `turn.error` 가 메시지에 들어간다
- `delta` 를 이어 붙여 본문을 만든다
- **다른 `threadId` 의 `delta` 가 섞여 들어와도 본문이 오염되지 않는다**
- 호출을 두 번 하면 `thread/start` 도 두 번 불린다 (thread 재사용 금지)
- `thread/start` 인자에 `sandbox: "read-only"`·`approvalPolicy: "never"` 가 들어간다
- `model` 이 없으면 호출을 거부한다
- 시간이 초과되면 `turn/interrupt` 를 보낸 뒤 거부한다
- `close()` 가 서버 자식 프로세스를 죽이고, 두 번 불려도 안전하다 (호출자가 종료 훅과 정상 경로
  양쪽에서 부를 수 있다)

생명주기는 **가짜 실행 파일**로 검증한다. `apps/api/test/llm-cli.test.js` 가 임시 디렉터리에
가짜 `codex` 를 쓰고 `PATH` 를 앞에 붙이는 방식을 이미 쓴다 — 그 패턴을 따른다.

- stdout 에 `listening on: ws://127.0.0.1:<포트>` 를 흘리면 그 주소를 읽는다
- `readyz` 가 응답하지 않으면 제한 시간 뒤 거부한다
- `close()` 가 자식 프로세스를 죽인다

**실제 `codex` 를 부르는 테스트를 만들지 마라.** 구독 계정과 네트워크에 의존해 재현되지 않는다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `packages/llm/package.json` | 신설 |
| `packages/llm/tsconfig.json` | 신설 |
| `packages/llm/src/index.ts` | 신설 |
| `packages/llm/src/app-server.client.ts` | 신설 — 프로토콜 |
| `packages/llm/src/app-server.process.ts` | 신설 — 생명주기 |
| `packages/llm/src/llm.types.ts` | 신설 |
| `packages/llm/src/*.test.ts` | 신설 |

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter @devloop/llm test
pnpm format:check
```

`pnpm -r build` 가 새 패키지를 함께 빌드하는지 확인한다.

이 phase 는 아직 아무도 이 패키지를 의존하지 않으므로 **기존 테스트 개수가 그대로여야 한다.**
절대값으로 확인한다 — 변경 전은 **api 75, pipeline 163(5 건너뜀)** 이다
(`docs/pitfalls/testing.md` 와 일치하는 실측).

```bash
# cwd: 저장소 루트
pnpm --filter api test
pnpm --filter pipeline test
```

새 패키지 테스트 개수는 별도로 센다. `pnpm --filter @devloop/llm test` 가 0건이면 test glob 이
파일을 못 잡은 것이다 — `test` 스크립트가 없으면 exit 0 으로 조용히 통과한다.
`packages/registry` 에는 `test` 스크립트가 없으므로 이 스크립트는 본뜨는 것이 아니라 신설이다.

**변이 검증** — 둘 다 확인하고 원복한다. 테스트가 있다는 것과 그 테스트가 무언가를 보호한다는
것은 다르다 (`docs/pitfalls/testing.md`).

| 무력화할 것 | 왜 |
| --- | --- |
| `turn/completed` 대기를 없애고 `turn/start` 응답만으로 완료 판정 | 이 계층에서 가장 틀리기 쉬운 지점이다. 실패를 성공으로 읽는다 |
| `close()` 를 no-op 으로 바꾼다 | handle 소유가 이 phase 의 새 공개 계약이다. 안 죽이면 자식이 남는다 |

## 의도 메모 (왜)

- **전송을 인터페이스로 뺀 이유** — 프로토콜 규칙(완료 대기·실패 판정·동시 호출 분리)이 이 phase
  결과물의 값이고, 그걸 실제 서버 없이 검증할 수 있어야 한다. 서버를 띄우는 테스트는 새 의존을
  부르고 검증 대상을 네트워크로 바꾼다
- **호출마다 새 thread 를 쓰는 이유** — 같은 thread 는 앞 턴을 다음 턴 프롬프트에 남긴다.
  지금 세 호출(앵커·Cypher·답변)은 서로 독립이라고 가정하고 프롬프트가 쓰여 있어, 문맥이 섞이면
  지연만 고치려던 변경이 답변 품질까지 바꾼다. `thread/start` 는 0.14초라 대가가 거의 없다
- **포트를 0 으로 맡기는 이유** — 두 앱이 각자 서버를 띄우므로 고정 포트는 반드시 부딪힌다.
  서버가 배정 결과를 stdout 에 알려 주므로 맡기는 쪽이 단순하다
- **`exec-server` 를 쓰지 않는 이유** — 미구현이다. `thread/start` 가
  `exec-server stub does not implement` 를 반환한다. `app-server` 만 동작한다

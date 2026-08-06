# Phase 01 — packages/llm 에 Responses 직접 전송을 만든다

**Execution profile**: standard
**Status**: pending

---

## 목표

상주 `app-server` 는 **에이전트 턴**을 돌린다. Codex 시스템 프롬프트·도구 정의·지시 파일이
호출마다 함께 간다. 우리 질의 엔진은 도구를 쓰지 않고 프롬프트 하나에 JSON 하나를 받으므로
그 비계가 전부 낭비다.

같은 프롬프트(16KB)·같은 스키마를 두 전송으로 **번갈아** 6라운드씩 돌린 실측이다.

| 전송 | 중위 | 평균 | 범위 | 평균 답변 | 문자당 |
| --- | ---: | ---: | --- | ---: | ---: |
| `app-server` 상주 | 15.7초 | 15.3초 | 13.8\~17.0초 | 554자 | 27.6ms |
| Responses 직접 호출 | 11.1초 | 9.7초 | 7.5\~11.7초 | 712자 | 13.6ms |

구간이 겹치지 않는다. 이 phase 는 그 전송을 만든다. **호출자를 바꾸지 않는다** — Phase 03 이 바꾼다.

설계 근거는 [ADR 0009](../../docs/adr/0009-direct-responses-transport.md) 와
`docs/code-architecture.md` 의 `packages/llm` 절이다.

**범위 외**

- API·파이프라인 전환 — Phase 03
- 추론 강도 설정 — Phase 02. 이 phase 는 `effort` 를 **전달만** 하고 기본값을 정하지 않는다
- 측정 — Phase 04
- 상주 전송 제거 — **하지 않는다.** 되돌릴 길이다
- **종량제 API 제공자 — 만들지 마라.** `ADR 0002` 가 금지한다. 이음매만 두고 계정 제공자 하나만 구현한다

---

## 작업 항목 (5)

### 1. 자격증명과 주소를 요청 조립에서 뗀다

두 경로가 같은 Responses 형식을 쓰고 주소·헤더만 갈린다. 그 차이만 담는 파일을 만든다.

```ts
// responses.credentials.ts
export interface ResponsesEndpoint {
  readonly url: string;
  readonly headers: Record<string, string>;
}
export function chatgptAccountEndpoint(): ResponsesEndpoint;
```

`~/.codex/auth.json` 을 읽어 만든다. **파일 구조는 확인했다.**

```
{ "OPENAI_API_KEY": null,
  "tokens": { "id_token": "...", "access_token": "...", "refresh_token": "...", "account_id": "..." },
  "last_refresh": "..." }
```

- 주소는 `https://chatgpt.com/backend-api/codex/responses` 다
- 헤더는 실측으로 통한 조합을 쓴다

  | 헤더 | 값 |
  | --- | --- |
  | `authorization` | `Bearer <tokens.access_token>` |
  | `chatgpt-account-id` | `<tokens.account_id>` |
  | `content-type` | `application/json` |
  | `openai-beta` | `responses=experimental` |
  | `originator` | `codex_cli_rs` |
  | `session_id` | 호출마다 새 UUID |

- **`id_token` 을 쓰지 마라.** 수명이 1시간이고 실제로 만료된 값이 파일에 남아 있다.
  쓰는 것은 `access_token`(수명 240시간)과 `account_id` 다
- **호출할 때마다 파일을 읽는다.** 기동 시 한 번 읽어 캐시하면 `codex` 가 갱신해도 못 따라간다
- **토큰을 로그·오류 메시지에 절대 넣지 마라.** 길이나 만료 시각까지만 남긴다
- `tokens.access_token` 이나 `account_id` 가 없으면 즉시 실패시킨다

### 2. 요청 조립과 SSE 파싱을 만든다

```ts
// responses.client.ts
export function createResponsesTransport(opts: { endpoint: () => ResponsesEndpoint }): LlmTransport;
```

요청 본문은 실측으로 통한 형태다.

```json
{
  "model": "<모델>",
  "instructions": "<시스템 지시>",
  "input": [{ "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "<프롬프트>" }] }],
  "stream": true,
  "store": false,
  "text": { "format": { "type": "json_schema", "name": "<이름>", "strict": true, "schema": { } } },
  "reasoning": { "effort": "<강도>" }
}
```

규칙이다.

- **`stream: true` 로 보내고 SSE 를 읽는다.** `data:` 로 시작하는 줄만 보고, `[DONE]` 은 건너뛴다.
  최종 텍스트는 `response.output_text.delta` 이벤트의 `delta` 를 이어 붙여 만든다
- **`store: false` 를 쓴다.** 대화를 서버에 남길 이유가 없다
- `outputSchema` 가 없으면 `text` 키를 아예 싣지 않는다. `effort` 도 같은 규칙이다
- **오류 이벤트와 빈 응답을 실패로 올린다.** 최종 텍스트가 비었는데 성공으로 넘기면
  계약 검증이 엉뚱한 곳에서 터진다
- **401 은 별도 오류로 구분한다.** 메시지에 `codex` 를 한 번 실행해 토큰을 갱신하라고 담는다.
  **갱신을 우리가 시도하지 마라** — 자격증명을 다루는 코드를 늘리지 않는다
- 시간 초과는 `AbortController` 로 끊는다
- SSE 한 줄이 여러 청크에 걸쳐 오므로 **버퍼에 모아 개행 단위로 끊는다.** 청크마다 파싱하면 깨진다

`instructions` 는 **한 곳에서 정한 짧은 문장**을 쓴다. 에이전트 프롬프트를 흉내내지 마라 —
그걸 벗기는 것이 이 변경의 목적이다.

### 3. 어댑터가 전송을 고르게 한다

`llm.adapter.ts` 가 이미 상주 전송을 붙인다. 여기에 선택을 더한다.

- 전송 이름은 열거형으로 두고 **기본값을 이 phase 에서 정하지 않는다.** Phase 03 이 정한다
- `close()` 는 직접 호출에서는 할 일이 없다. 그래도 **계약을 지켜 존재해야 한다** —
  호출자가 전송에 따라 분기하면 전송을 고른 의미가 없어진다

### 4. 테스트를 붙인다

**실제 엔드포인트를 부르는 테스트를 만들지 마라.** 구독·네트워크에 의존해 재현되지 않는다.
`fetch` 를 주입하거나 대체해 검증한다.

- 헤더 여섯 개가 실린다. `authorization` 이 `Bearer ` 로 시작한다
- **`id_token` 이 요청에 실리지 않는다**
- 오류 메시지·로그에 토큰 문자열이 들어가지 않는다
- `outputSchema` 를 주면 `text.format.json_schema` 로 실리고 `strict: true` 다
- `outputSchema` 나 `effort` 가 없으면 그 키가 요청에 없다
- SSE 조각이 **줄 중간에서 끊겨 도착해도** 텍스트가 온전히 조립된다
- `[DONE]` 과 알 수 없는 이벤트를 건너뛴다
- 401 이면 갱신 안내가 담긴 오류를 던진다
- 최종 텍스트가 비면 실패로 올린다
- `auth.json` 에 `access_token` 이 없으면 즉시 실패한다

`packages/llm` 의 `test` 스크립트가 `dist/*.test.js` 글롭이라 파일을 더해도 목록 수정이 필요 없다.

### 5. 검증용 진단 스크립트를 남긴다

실제 호출이 되는지 사람이 한 번 확인할 길이 필요하다. `packages/llm/scripts/probe.mjs` 로 둔다.

- 인자로 모델과 전송을 받아 짧은 프롬프트를 한 번 보내고 지연과 응답 앞부분을 출력한다
- **토큰을 출력하지 않는다**
- 이건 테스트가 아니라 진단 도구다. `test` 스크립트에 넣지 마라

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `packages/llm/src/responses.credentials.ts` | 신설 |
| `packages/llm/src/responses.client.ts` | 신설 |
| `packages/llm/src/llm.adapter.ts` | 수정 — 전송 선택 |
| `packages/llm/src/llm.types.ts` | 수정 — 전송 열거형·옵션 |
| `packages/llm/src/index.ts` | 수정 |
| `packages/llm/src/responses.*.test.ts` | 신설 |
| `packages/llm/scripts/probe.mjs` | 신설 |

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter @devloop/llm test
pnpm format:check
```

토큰이 새어 나갈 자리가 없는지 센다. **출력이 0줄이어야 한다.**

```bash
# cwd: 저장소 루트
grep -rn "id_token" packages/llm/src
```

이 phase 는 아직 아무 앱도 새 전송을 쓰지 않으므로 **API·파이프라인 테스트 개수는 그대로여야 한다.**

**변이 검증** — SSE 버퍼링을 없애 청크마다 파싱하게 만든 뒤 "줄 중간에서 끊겨 도착" 테스트가
실제로 실패하는지 확인하고 원복한다. 이게 이 계층에서 가장 틀리기 쉬운 지점이다.

## 의도 메모 (왜)

- **자격증명을 뗀 이유** — 종량제 API 로 가는 결정이 나중에 내려지면 주소·헤더만 다른 제공자를
  더하는 일이 된다. 요청 조립과 SSE 파싱은 그대로 쓴다. 지금은 그 제공자를 만들지 않는다
- **토큰 갱신을 안 하는 이유** — `codex` 가 이미 한다. 우리가 refresh 흐름을 구현하면 자격증명을
  쓰는 코드가 늘고, 그 코드가 틀렸을 때 피해가 크다
- **`instructions` 를 짧게 두는 이유** — 에이전트 비계를 벗기는 것이 이 변경의 값이다.
  다시 채워 넣으면 얻는 게 없다
- **`close()` 를 빈 구현으로라도 두는 이유** — 호출자가 전송 종류를 알아야 하면 추상화가 깨진다

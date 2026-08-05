---
id: RETRO-0017
plan: plan010-persistent-llm-transport
date: 2026-08-05
phase: code-reviewer 검사
status: 해결
category: 결함
promotion: 검토 중
---

# 소켓이 끊기면 호출이 실패하지 않고 무한히 매달린다

## 관찰

독립 code-reviewer 가 누적 diff 검사에서 찾았다. team-lead 가 재현해 확정했다.

`packages/llm/src/llm.adapter.ts:28-51` 의 `connectWebSocketTransport` 가
`"message"`·`"error"`·`"open"` 만 듣는다. **`"close"` 리스너가 없다.**

`packages/llm/src/app-server.client.ts:160-171` 의 `request()` 에 제한 시간이 없다.

`complete()` 의 실행 순서가 문제를 만든다.

| 지점 | 보호 |
| --- | --- |
| `:66` `await this.ensureInitialized()` | 없다 |
| `:69` `await this.request("thread/start", ...)` | 없다 |
| `:93` 제한 시간 타이머 생성 | `thread/start` 가 돌아온 **뒤** |
| `:114` `await this.request("turn/start", ...)` | 없다 (race 밖) |

`timeoutMs` 는 `turn/completed` 대기 구간만 보호한다.
서버가 죽거나 소켓이 닫힌 순간에 `initialize`·`thread/start`·`turn/start` 중 하나가 진행 중이면
그 Promise 는 **영원히 settle 되지 않는다.**

`ensureInitialized`(`:144-158`)는 더 나쁘다. `initializing` 을 캐시하고 reject 시에만 비우므로,
그 한 번이 끝나지 않으면 **이후 모든 호출이 같은 Promise 에 매달린다.**

## 원인

두 겹이다.

- **phase-01·02 파일에 접속 끊김 처리 요구가 없었다.** 프로토콜 규칙(완료 대기·실패 판정·동시 호출
  분리)과 서버 생명주기는 상세히 못박았지만 전송이 끊기는 경우를 다루지 않았다. 명세되지 않은 공백이다.
- **`codex exec` 시절에는 이 경우가 자식 프로세스 타임아웃으로 덮였다.**
  `apps/api/src/llm/llm-cli.ts` 의 `ChildProcessCliAdapter` 가 프로세스를 죽이면 호출이 끝났다.
  상주 전송으로 옮기면서 그 안전망이 사라졌고, 대체 장치를 넣지 않았다.

## 영향

**ADR 0008 이 약속한 동작과 반대다.** "대가" 절이 "서버 하나에 질의 전부가 매달린다.
죽으면 모든 호출이 실패한다" 고 적었는데 실제는 실패가 아니라 무한 대기다.

- API 는 요청 핸들러가 끝나지 않는다
- 파이프라인 `infer-knowledge` 는 단계가 멈춘다
- `ensureInitialized` 캐시 때문에 첫 호출이 걸리면 그 프로세스의 모든 후속 호출이 함께 멈춘다

측정·구현 과정에서는 드러나지 않았다. 서버가 정상 동작하는 경로만 실행됐기 때문이다.

## 대응

세 곳을 고쳤다.

- `connectWebSocketTransport` 에 `"close"` 리스너를 붙이고 `JsonRpcTransport` 에 `onClose(handler)` 를 더했다.
  테스트의 메모리 전송도 같은 형태를 만족한다
- `AppServerClient` 가 `onClose` 알림을 받으면 `pendingRequests`·`pendingTurns` 를 전부 거부한다.
  **`close()` 와 다르게 클라이언트를 닫힌 상태로 만들지 않는다** — 서버를 다시 띄워 붙일 수 있으므로
  `initializing` 캐시만 비워 다음 호출이 재시도하게 한다
- `request()` 에 제한 시간을 뒀다 (`DEFAULT_REQUEST_TIMEOUT_MS = 30_000`, `requestTimeoutMs` 로 조정 가능).
  `initialize` 0.00초·`thread/start` 0.14초 실측에 비해 넉넉하다

`initialize` 캐시의 경합도 함께 처리했다. 실패한 시도를 비울 때 `this.initializing === attempt` 를
확인해, 이미 다른 시도로 교체됐으면 건드리지 않는다.

## 검증

테스트 4건을 더했다 (`@devloop/llm` 15 → 19). 세 축을 각각 덮는다.

| 테스트 | 덮는 축 |
| --- | --- |
| 소켓이 끊기면 턴을 기다리던 호출이 거부된다 | `turn/completed` 대기 구간 |
| 소켓이 끊기면 응답을 기다리던 `thread/start` 도 거부된다 | 제한 시간 밖 구간 |
| 소켓이 끊긴 뒤 `initialize` 를 다시 시도한다 | 캐시가 영구히 막지 않는다 |
| 요청이 응답 없이 제한 시간을 넘기면 거부된다 | `request()` 제한 시간 |

통합 검증 — 빌드 통과, `@devloop/llm` 19 · api 83 · pipeline 160(5 건너뜀), `format:check` 통과.

## 배운 점

**안전망이 사라진 것을 알아채기 어렵다.** `codex exec` 의 프로세스 타임아웃은 명시적 기능이 아니라
구조가 준 부수 효과였다. 그것을 상주 전송으로 대체할 때 "무엇이 없어지는가" 를 목록으로 만들지 않았다.

phase 파일이 프로토콜 성공 경로와 서버 생명주기를 매우 상세히 적었는데도 이 공백이 남았다.
**정상 경로를 자세히 쓰는 것과 실패 경로를 빠뜨리지 않는 것은 다른 일이다.**

독립 검토가 이걸 찾았다는 점도 남긴다. 구현자와 team-lead 는 성공 경로를 다섯 번(측정 4회, 실호출 2회)
실행했지만 이 경로는 한 번도 지나가지 않았다.

## 후속

`docs/pitfalls/testing.md` 승격을 검토한다. 규칙 한 줄로 줄이면 이렇다 —
**구조가 주던 안전망을 다른 구조로 옮길 때, 없어지는 것을 목록으로 만들어라.**

`readyTimeoutMs` 가 두 단계에 각각 적용돼 최악 대기가 2배(60초)인 것은 이번에 고치지 않았다.
실패 경로에서만 나타나고 영향이 작다고 판정했다.

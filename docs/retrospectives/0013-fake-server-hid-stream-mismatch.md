---
id: RETRO-0013
plan: plan010-persistent-llm-transport
date: 2026-08-04
phase: phase-02
status: 해결
category: 결함
promotion: 검토 중
---

# 가짜 서버가 stdout 을 써서 실제 서버의 stderr 배너를 못 잡았다

## 관찰

Phase 01 이 만든 `startAppServer` 는 자식 `codex app-server` 의 stdout 만 훑어 접속 주소를 읽었다.
테스트 13건이 전부 통과했고 변이 검증 2건도 정상 검출됐다.

Phase 02 가 실제 `codex` 를 처음 부르자 두 경로가 같은 지점에서 멈췄다.

- API 기동이 30초 뒤 `codex app-server 가 30000ms 안에 접속 주소를 알리지 않았다` 로 실패
- 파이프라인 `infer-knowledge` 도 같은 메시지로 exit 1

실측하면 배너가 전부 stderr 로 온다 (codex-cli 0.146.0).

```
STDOUT 바이트: 0     ""
STDERR 바이트: 222   "codex app-server (WebSockets)\n  listening on: ws://127.0.0.1:55256\n  readyz: ...\n"
```

## 원인

두 겹이다.

- **spec 이 틀렸다.** phase-01 파일이 "서버가 배정된 포트를 **stdout 에 출력한다**" 를 실측으로 적었다.
  포트 자동 배정과 배너 형식은 맞았지만 어느 스트림으로 오는지는 확인되지 않은 값이었다.
- **테스트가 그 틀린 전제를 그대로 굳혔다.** 가짜 `codex` 실행 파일이 `process.stdout.write` 로 배너를
  쓰도록 만들어져, 구현과 테스트가 같은 오해를 공유했다. 그래서 13건 전부 통과했다.

변이 검증도 이걸 잡지 못한다. 무력화 대상이 "stdout 훑기" 였고 가짜 서버도 stdout 을 쓰므로
검출은 되지만, 검출된 것은 "stdout 경로가 살아 있다" 일 뿐이다.

## 영향

실제 피해는 없었다. Phase 02 가 실제 `codex` 를 부르는 검증을 담고 있어 머지 전에 드러났다.
그 검증이 없었다면 `codex` provider 로 API 가 아예 뜨지 못하는 상태로 머지됐다.

## 대응

- `app-server.process.ts` 의 stdout 핸들러 몸통을 `scan` 함수로 뽑아 stdout·stderr 가 같은 함수를 쓰게 했다.
  공개 계약은 바꾸지 않았고 순변경 2줄이다.
- stderr 로 알리는 가짜 서버 테스트 1건을 더했다. 기존 stdout 테스트도 남겨 둘 다 지원함을 고정했다.
  가짜 서버는 stdout 판을 문자열 치환해 만들어 두 경로가 같은 배너를 쓴다.
- 실측 근거를 `LISTENING_PATTERN` 주석에 남겨 다음 사람이 다시 조사하지 않게 했다.

## 검증

- stderr 훑기를 되돌리면 새 테스트만 실패한다 (`5000ms 안에 접속 주소를 알리지 않았다`). 원복 후 14건 전부 통과.
- 실제 `codex` 로 API 질의가 근거 있는 답변을 33.2초에 돌려줬다.
- 파이프라인 `--docs Task:483` 이 `cacheHits=1 calls=0` 을 냈다.
- 두 경로 모두 종료 후 `pgrep -f 'app-server --listen ws://'` 가 0줄이다.

## 배운 점

**대역이 계약을 정의하면 그 계약이 실제와 어긋나도 테스트는 통과한다.**
가짜 서버를 만들 때 "실제 서버가 이렇게 동작한다" 는 전제가 들어가고, 그 전제가 틀리면
테스트는 구현이 아니라 오해를 검증한다. 계층 테스트의 개수·통과율로는 알 수 없다.

그래서 실제 대상을 한 번 부르는 검증이 필요하다. 이 plan 에서는 critic 이 v3 권고로
"파이프라인 경로가 한 번도 실제로 실행되지 않는다" 를 지적해 그 검증이 phase-02 에 들어갔고,
같은 phase 의 API 실제 호출이 이 결함을 잡았다.

## 후속

`docs/pitfalls/testing.md` 승격을 검토한다. 기존 항목 "가드를 추가하면 변이로 검증하라" 와
성격이 다르다 — 변이 검증으로도 잡히지 않는 부류이고, 대역의 전제 자체를 의심해야 한다는 규칙이다.

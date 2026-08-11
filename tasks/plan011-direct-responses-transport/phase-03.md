# Phase 03 — 기본 전송을 직접 호출로 바꾸고 상주 전송을 스위치로 남긴다

**Execution profile**: standard
**Status**: completed

---

## 목표

Phase 01 이 만든 전송을 **기본으로 올린다.** 상주 `app-server` 는 지우지 않고 설정으로 고를 수
있게 남긴다 — 직접 호출이 쓰는 엔드포인트가 문서화되지 않은 내부 경로라, 바뀌면 설정 하나로
돌아갈 길이 있어야 한다 ([ADR 0009](../../docs/adr/0009-direct-responses-transport.md)).

**이 phase 는 Phase 01 의 전송과 Phase 02 의 강도 명시를 전제한다.**
둘 중 하나라도 없으면 base 를 확인하고 멈춘다.

**범위 외**

- 프롬프트 내용 — **한 글자도 건드리지 마라.** Phase 04 가 전송 하나의 효과를 재야 한다
- 상주 어댑터 제거 — 하지 않는다
- 측정 — Phase 04

---

## 작업 항목 (4)

### 1. 설정에 전송 스위치를 만든다

- 이름은 값이 무엇을 고르는지 드러나게 짓는다. 전송 종류가 셋이라는 사실이 보여야 한다
  (직접 호출·상주·`claude` 자식 프로세스)
- **기본값은 직접 호출이다.** 환경변수가 없어도 직접 호출로 돈다
- 허용 목록 밖 값은 기동 시 거부한다 ([ADR 0003](../../docs/adr/0003-fail-fast-config.md))
- `LLM_PROVIDER=claude` 와의 관계를 한 곳에서 정한다. **두 설정이 모순되면 기동을 실패시킨다** —
  조용히 한쪽을 무시하면 어느 전송으로 돌고 있는지 아무도 모른다

### 2. API 를 새 기본 전송으로 돌린다

`app.module.ts` 가 전송을 만들어 `LLM_CLI` 로 제공한다.

- **직접 호출을 골랐으면 `app-server` 를 띄우지 않는다.** 안 쓰는 프로세스를 띄우면 안 된다
- 종료 훅은 그대로 둔다. 직접 호출의 `close()` 는 할 일이 없다
- **기동 로그에 어느 전송으로 도는지 한 줄 남긴다.** 이게 없으면 측정 결과를 보고도
  어느 전송이었는지 증명할 수 없다

### 3. 파이프라인도 같은 스위치를 따르게 한다

`infer-knowledge` 가 전송을 만든다. 같은 설정을 읽게 하고, 직접 호출일 때 서버를 띄우지 않는다.

**추출 프롬프트와 `EXTRACTION_PROMPT_VERSION` 을 건드리지 마라.** 캐시 537건이 무효화된다.

### 4. 실제 호출 한 번으로 살아 있는지 확인한다

```bash
# cwd: 저장소 루트
pnpm -r build
cd apps/api && set -a && . ../../.env && set +a && nohup node dist/main.js >| /tmp/api-plan011.log 2>&1 &
```

기동 로그에서 **전송 이름 한 줄**을 확인한 뒤, 별도 호출로 질의를 보낸다.

```bash
# cwd: 저장소 루트
curl -s -X POST localhost:3000/api/query -H 'content-type: application/json' \
  -d '{"question":"API 게이트웨이 요청 크기 제한은 어떻게 결정됐나"}' | head -c 400
```

`pnpm api` 를 백그라운드 명령 안에서 쓰지 마라 — 셸이 끝날 때 EPIPE 로 죽는다.
측정 36회 중 35회를 `fetch failed` 로 잃은 실측이 있다 (`docs/pitfalls/measurement.md`).

**전송 스위치를 상주로 돌려 같은 질의를 한 번 더 보낸다.** 되돌릴 길이 실제로 작동하는지
여기서 확인하지 않으면 그 길이 있다고 말할 수 없다.

확인 후 프로세스를 정리한다 (`docs/pitfalls/process-cleanup.md`).

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `apps/api/src/config/api-config.const.ts` | 수정 — 전송 열거형·기본값 |
| `apps/api/src/config/api-config.schema.ts` | 수정 |
| `apps/api/src/app.module.ts` | 수정 — 전송 선택과 기동 로그 |
| `apps/pipeline/src/config/*` | 수정 |
| `apps/pipeline/src/infer/*` | 수정 — 전송 선택 |
| `apps/api/test/api-config.test.js` | 수정 |

## 검증

```bash
# cwd: 저장소 루트
pnpm -r build
pnpm --filter @devloop/llm test
pnpm --filter api test:unit
pnpm --filter pipeline test
pnpm format:check
```

프롬프트가 안 바뀌었는지 센다. **출력이 0줄이어야 한다.**

```bash
# cwd: 저장소 루트
git diff origin/main -- apps/api/src/query/query.service.ts | grep -E "^[-+]" | grep -E '"(질문|응답|Question|Evidence)'
```

추출 캐시가 살아 있는지 센다. 변경 전후 파일 수가 같아야 한다.

```bash
# cwd: 저장소 루트
find apps/pipeline/data/cache -type f | wc -l
```

새 테스트가 덮어야 할 것이다.

- 설정이 없으면 직접 호출이 선택된다
- 허용 목록 밖 값은 기동 시 거부된다
- `LLM_PROVIDER=claude` 와 상주 전송을 함께 지정하면 기동이 실패한다
- 직접 호출을 골랐을 때 `app-server` 를 띄우지 않는다

## 의도 메모 (왜)

- **기동 로그에 전송을 남기는 이유** — Phase 04 가 두 전송을 번갈아 재는데, 어느 회차가 어느
  전송이었는지 로그로 증명되지 않으면 그 측정을 신뢰할 수 없다
- **모순 설정을 기동 실패로 만드는 이유** — 조용히 한쪽을 무시하면 측정 결과의 전제가 무너진다.
  값 미지정으로 조용히 기본값을 쓰던 사고가 ADR 0003 을 낳았다
- **상주로 한 번 되돌려 보는 이유** — 되돌릴 길은 써 봐야 있는 것이다

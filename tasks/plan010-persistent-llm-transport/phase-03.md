# Phase 03 — 전송 전환만의 지연·회수 효과를 측정한다

**Execution profile**: standard
**Status**: pending

---

## 목표

Phase 02 는 프롬프트를 안 건드렸다. 그래서 이 측정은 **전송 방식 하나의 효과만** 담는다.

두 가지를 확인한다.

- **지연이 줄었나** — 이게 이 plan 의 목표다
- **회수가 안 나빠졌나** — 지연을 얻고 품질을 잃으면 안 된다

`outputSchema` 를 넣기 전에 재는 이유다. 나중에 지표가 움직였을 때 상주 모드 탓인지
스키마 탓인지 가를 수 있는 유일한 지점이 여기다.

**이 phase 는 Phase 02 가 머지된 상태를 전제한다.**

**범위 외**

- 코드 변경 — 이 phase 는 측정만 한다. 결과가 나쁘더라도 여기서 고치지 않고 보고한다
- 의미 판정 (두 판정자 채점) — 하지 않는다. 목표 지표가 결정적 축이고, plan006 에서 36회 중
  22회가 채점자 불일치로 `REVIEW` 였던 실측이 있어 정보량이 낮다
- 평가 세트 수정 — **한 글자도 건드리지 마라.** 세트를 바꾸면 기준선과 비교선이 끊긴다

---

## 작업 항목 (4)

### 1. 측정 전에 함정 파일을 읽는다

`docs/pitfalls/measurement.md` 를 읽는다. 아래 셋은 여기서 반드시 지킨다.

- API 를 `pnpm` 으로 백그라운드에 띄우지 않는다. 실측으로 36회 중 35회를 잃은 사건이 있다
- 기동과 측정을 같은 명령에 묶지 않는다
- 측정 중 같은 API 로 다른 질의를 하지 않는다. LLM 호출이 경쟁한다

### 2. 같은 코드로 두 번 측정한다

**포트 3000 을 쓰지 마라.** 다른 워킹 트리의 API 가 점유하고 있다 (실측: main 워킹 트리의
`node dist/main.js`, 22시간 경과). 3000 으로 띄우면 기동이 실패하고, 그것을 못 알아챈 채 질의하면
**옛 `codex exec` 코드가 정상 응답을 준다.** 어느 인스턴스에 붙었는지 모르는 상태가 이 저장소에서
사고로 이어졌다 (`docs/pitfalls/measurement.md`).

`.env` 에 `PORT` 줄이 없어 환경변수로 덮을 수 있다. 코드를 고칠 필요가 없다.

```bash
# cwd: 저장소 루트
rm -rf apps/api/dist apps/pipeline/dist packages/llm/dist
pnpm -r build
cd apps/api && set -a && . ../../.env && set +a && PORT=3100 nohup node dist/main.js >| /tmp/api-plan010-p03.log 2>&1 &
```

`dist` 를 먼저 지우는 이유다. `tsc` 는 지운 소스의 산출물을 남기고 파이프라인 test 는 글롭이라
지운 테스트가 계속 돈다 (`docs/retrospectives/0014-stale-dist-runs-deleted-tests.md`).

기동 로그에서 app-server 주소가 찍혔는지 확인하고, **그 포트의 리스너가 워크트리 것인지도 확인한다.**

```bash
# cwd: 저장소 루트
lsof -nP -iTCP:3100 -sTCP:LISTEN
lsof -a -p <위에서 나온 PID> -d cwd -Fn
```

cwd 가 워크트리 `apps/api` 여야 한다. 확인한 뒤 **별도 호출로** 측정을 돌린다.

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/run.mjs \
  --suite eval/suites/tc-ocr-api-gateway.json \
  --stage plan010-transport \
  --api-base-url http://localhost:3100 \
  --query-model gpt-5.6-terra \
  --out eval/runs/plan010-transport-1.json
```

같은 명령을 `-2.json` 으로 한 번 더 돌린다. **한 번만 재고 판정하지 마라** —
코드·그래프를 안 바꾼 두 측정에서 attempt 36건 중 8건이 이동한 실측이 있다.

`--query-model` 은 선언값일 뿐이고 런타임 모델을 증명하지 않는다. 리포트에 그렇게 적는다.

### 3. 지연을 직접 계산한다

**`compare.mjs` 는 지연을 비교하지 않는다.** 확인했다 — 그 스크립트에 지연 관련 코드가 없다.
그래서 지연은 출력 파일에서 직접 뽑는다. `attempts[].latencyMs` 에 attempt 마다 들어 있다.

```bash
# cwd: 저장소 루트
node -e "
const d=require(process.argv[1]);
const v=d.attempts.map(a=>a.latencyMs).filter(n=>typeof n==='number').sort((a,b)=>a-b);
const avg=v.reduce((s,x)=>s+x,0)/v.length;
console.log('건수',v.length,'평균',(avg/1000).toFixed(1)+'초','중위',(v[Math.floor(v.length/2)]/1000).toFixed(1)+'초','최대',(v.at(-1)/1000).toFixed(1)+'초');
" "$(pwd)/eval/runs/plan010-transport-1.json"
```

이 명령은 기존 파일로 검증했다 — `plan008-confirm.json` 에서 36건 평균 70.2초가 나오고
그 값이 `eval/reports/2026-08-04-plan009-comment-enrich.md` 의 표와 일치한다.

**기준값은 리포트에 있다.** plan009 확인 측정이 회수 실패 2 · `ANSWER` 2 · 평균 지연 59.7초다.

### 지연을 해석할 때 알아야 하는 값

Phase 02 실행자가 실측한 것이다. 이 값을 모르면 "왜 기대만큼 안 줄었나" 를 오해한다.

| 항목 | 값 |
| --- | --- |
| 프로세스 기동 (없어진 비용) | 호출당 약 8초 |
| `thread/start` 마다 기동하는 MCP 서버 | 5개, 호출당 약 3초 |

ADR 0008 은 호출당 12초에서 5초 수준으로 내려간다고 적었다. **그 예측에 MCP 기동 3초는 들어 있지 않다.**
즉 호출당 기대 절감은 8초가 아니라 약 5초이고, 질의당 호출 3~5회면 15~25초다.
실측이 그보다 적게 줄었다면 이 값을 먼저 확인하고, 그래도 설명이 안 되면 원인을 분해한다.

`thread/start` 를 호출마다 새로 하는 것은 ADR 0008 의 결정이다 (같은 thread 는 앞 턴을 다음
프롬프트에 남긴다). **그 결정을 이 phase 에서 뒤집지 마라** — 측정만 하고 보고한다.

### 4. 회수는 compare.mjs 로 비교한다

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/compare.mjs \
  --baseline <plan009 확인 측정 파일> \
  --candidate eval/runs/plan010-transport-1.json
```

`eval/runs/` 는 gitignore 대상이라 plan009 원시 파일이 남아 있지 않을 수 있다.
**없으면 억지로 만들지 마라.** 없으면 리포트의 수치(회수 2 · `ANSWER` 2 · 59.7초)를
기준값으로 삼고 "원시 파일 없음, 리포트 수치와 대조" 라고 적는다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/runs/plan010-transport-{1,2}.json` | 생성 (gitignore 대상. 커밋하지 않는다) |
| `eval/reports/2026-08-XX-plan010-transport.md` | 신설 |

## 검증

리포트가 아래를 담아야 한다. 빠지면 미완이다.

- **실제로 측정한 문항 수와 attempt 수** — 부분 재측정으로 전체를 단정한 사건이 있었다
- 두 측정의 지연 (평균·중위·최대) 과 회수 실패·`ANSWER` 건수
- plan009 기준값과의 대조, 그리고 **두 측정 구간이 기준값과 겹치는지**
- 겹치면 "개선이라 부를 수 없다" 고 적는다. 총수만 보고 개선이라 부르지 않는다
- 그래프 상태 (노드·관계·Concept 수) 와 이번에 그래프를 건드리지 않았다는 사실
- 의미 판정을 하지 않았다는 것과 그 이유

측정 후 띄운 프로세스를 정리하고, 무엇을 남기고 무엇을 지웠는지 보고에 적는다.

## 의도 메모 (왜)

- **`outputSchema` 전에 재는 이유** — 이 지점이 전송 효과를 단독으로 잴 수 있는 유일한 곳이다.
  `plan008` 은 두 변경을 함께 넣어 개선분의 원인을 잘못 이해했다
- **회수를 함께 보는 이유** — 상주 모드는 프롬프트를 안 바꿨으니 회수가 그대로여야 한다.
  움직였다면 그건 실행 간 변동이거나 전송 계층 결함이고, 둘 중 무엇인지 두 번 재야 갈린다
- **지연을 직접 계산하는 이유** — 비교 스크립트가 지연을 안 본다. 없는 기능을 있다고 가정해
  비교를 요구한 사건이 이미 있었다

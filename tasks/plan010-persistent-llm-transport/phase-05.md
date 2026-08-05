# Phase 05 — 재측정하고 리포트를 남긴다

**Execution profile**: standard
**Status**: completed

---

## 목표

Phase 04 의 `outputSchema` 효과를 Phase 03 구간과 대조한다.
그리고 plan 전체(전송 전환과 스키마)의 결과를 기준선 대비로 정리한다.

이 리포트가 **다음 작업의 기준선**이 된다. 그래서 지연을 절대값으로 남기는 것이 중요하다.
지연 필드가 없어 비교를 못 한 사건이 이미 있었다 (`docs/pitfalls/measurement.md`).

**이 phase 는 Phase 03 리포트와 Phase 04 구현을 전제한다.**

**범위 외**

- 코드 변경 — 측정과 문서화만 한다. 지표가 나쁘면 고치지 말고 원인 분해까지만 하고 보고한다
- 평가 세트 확장 — 다음 plan 이다. 이 세트는 12문항 중 11개가 전회 통과라 개선을 더 재기 어렵다
- 의미 판정 — 하지 않는다. 이유는 Phase 03 과 같다

---

## 작업 항목 (4)

### 1. 같은 코드로 두 번 측정한다

Phase 03 과 **같은 세트·같은 모델·같은 반복 수**로 돌린다. 하나라도 다르면 비교선이 끊긴다.

```bash
# cwd: 저장소 루트
node .claude/skills/kg-eval/scripts/run.mjs \
  --suite eval/suites/tc-ocr-api-gateway.json \
  --stage plan010-outputschema \
  --api-base-url http://localhost:3100 \
  --query-model gpt-5.6-terra \
  --out eval/runs/plan010-schema-1.json
```

`-2.json` 으로 한 번 더 돌린다.

API 기동은 Phase 03 의 방식을 쓰되 **로그 경로를 `/tmp/api-plan010-p05.log` 로 바꾼다.**
Phase 03 과 같은 경로를 쓰면 그 측정의 로그가 지워져 원인을 되짚을 수 없다.

포트도 Phase 03 과 같이 **3100** 을 쓴다. 3000 은 다른 워킹 트리의 API 가 점유하고 있어,
거기에 질의하면 이 plan 의 코드가 아닌 것을 재게 된다. 리스너 cwd 확인도 그 phase 와 같이 한다.

### 2. 세 구간을 나란히 놓는다

| 구간 | 무엇을 담나 |
| --- | --- |
| plan009 확인 | 기준값 — 회수 실패 2 · `ANSWER` 2 · 평균 지연 59.7초 |
| plan010 전송 (Phase 03) | 전송 방식만 바뀐 상태 |
| plan010 스키마 (이 phase) | 전송과 `outputSchema` 를 함께 |

각 구간은 **두 측정의 범위**로 적는다. 단일 값으로 적지 마라 — 코드·그래프를 안 바꾼 두
측정에서 attempt 36건 중 8건이 이동한 실측이 있다.

**구간이 겹치면 개선이라 부르지 않는다.** 겹친다고 적는다.

### 3. 리포트를 쓴다

`eval/reports/2026-08-XX-plan010-persistent-transport.md` 에 담는다.

- **실제로 측정한 문항 수와 attempt 수**, 오류 건수
- 세 구간의 지연 (평균·중위·최대) 과 회수 실패·`ANSWER`·`NONE` 건수
- 문항별 결과. 남은 실패가 있으면 그 문항과 못 찾은 근거를 적는다
- 그래프 상태와 **이 plan 이 그래프를 건드리지 않았다는 사실**
- 의미 판정을 하지 않았다는 것과 그 이유
- 원시 실행 결과는 `eval/runs/` 에 있고 gitignore 대상이라 커밋하지 않는다는 것
- `--query-model` 은 선언값이고 런타임 모델을 증명하지 않는다는 것
- **재시도 빈도는 확인할 수 없다는 것과 그 이유.** `apps/api/src/query/query.service.ts` 에
  `Logger`·`console` 이 하나도 없어(실측 0건) `completeStructured` 의 재시도가 로그에 남지 않는다.
  그래서 `outputSchema` 의 값을 **"지연 감소" 가 아니라 "실패 경로 제거" 로 적는다.**
  지연이 Phase 03 대비 거의 안 움직여도 그건 정상이다 — 형식 위반이 드물었다는 뜻이다.
  **추정치를 만들지 마라.** 재시도 계측은 이 plan 범위 밖이고 후속으로 남긴다

**얻은 방법론**과 **다음 병목**을 남긴다. 지금 알려진 것이다.

- `AGW-H03` 하나가 남아 있다. 483의 댓글 두 건이 업무당 상한 8 밖인지 **확인되지 않았다**
- 이 세트로는 개선을 더 재기 어렵다. 다음은 차별 대역 문항 확보다.
  재료는 `eval/questions-{human,ai}-tc-ocr.json` 34문항에 있고 현재 어느 스크립트도 읽지 않는다

`docs/retrospectives/RUNS.md` 에 실행 기록 한 줄을 더한다.

### 4. plan 을 완료로 표시한다

`tasks/plan010-persistent-llm-transport/index.json` 의 `status` 를 `completed` 로 바꾸고
phase 5개의 `status` 도 모두 `completed` 로 바꾼다. 각 phase 파일 머리의 `**Status**` 도 맞춘다.

상태를 안 바꾸면 다음 세션이 미완으로 읽고 다시 실행한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/runs/plan010-schema-{1,2}.json` | 생성 (gitignore 대상. 커밋하지 않는다) |
| `eval/reports/2026-08-XX-plan010-persistent-transport.md` | 신설 |
| `docs/retrospectives/RUNS.md` | 끝에 행 추가 |
| `CLAUDE.md` | 수정 — 구조 트리에 `packages/llm` 추가. "지금 어디에 있나" 는 필요할 때만 |

## 검증

- 세 구간이 같은 세트 해시로 측정됐는지 확인한다. 출력 파일의 `suiteHash` 가 같아야 한다
- 리포트의 모든 수치가 출력 파일에서 나온 것인지 확인한다. 리포트 간 전사로 옮긴 값이 있으면
  그렇다고 적는다
- `CLAUDE.md` 의 "지금 어디에 있나" 는 **짧게 유지한다.** 수치를 복제하지 않고 리포트를 가리킨다
- `CLAUDE.md` 구조 트리(14행 근처)에 `packages/llm` 이 없다. 역할 표에는 이미 있으므로 트리에만 더한다.
  `packages/registry` 도 같은 상태지만 **이 plan 이 만든 누락이 아니므로 건드리지 않는다**

측정 후 띄운 프로세스를 정리하고, 무엇을 남기고 무엇을 지웠는지 보고에 적는다.
Codex 앱이 소유한 `app-server` 프로세스는 건드리지 마라 — 이 저장소가 띄운 것만 지운다.

## 의도 메모 (왜)

- **세 구간으로 적는 이유** — 전송과 스키마를 따로 넣었으므로 각각의 효과가 분리돼 있다.
  이 구조를 리포트가 유지해야 다음에 되짚을 수 있다
- **재시도 빈도 미확인을 리포트에 적는 이유** — `outputSchema` 의 이득은 "형식 위반이 잦았다" 는
  전제 위에 있다. 그 전제를 재지 못한 채 지연 감소를 스키마 덕으로 적으면 `plan008` 과 같은 오해가
  된다. 그래서 재지 못했다는 사실 자체를 남긴다
- **다음 병목을 리포트에 남기는 이유** — 이 세트가 포화됐다는 사실이 다음 plan 의 출발점이다

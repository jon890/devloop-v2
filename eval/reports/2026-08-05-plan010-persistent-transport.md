# Plan010 Phase 05 — 전송 전환과 outputSchema 를 합친 최종 대조 리포트

Phase 04 에서 도입한 `outputSchema` 를 Phase 03(전송 전환만)과 대조하고, plan 전체(전송 전환과
`outputSchema` 를 함께)의 결과를 plan009 확인 기준값과 대조한다.

## 실행 조건

- 평가 세트: `eval/suites/tc-ocr-api-gateway.json` — 한 글자도 건드리지 않았다
- 질의 모델 선언값: `gpt-5.6-terra`. **`--query-model` 은 선언값일 뿐이고 런타임 모델을 증명하지 않는다**
- API: `PORT=3100`, `node dist/main.js` 직접 기동 (PID 28682).
  리스너 cwd 확인 — `/Users/nhn/personal/devloop-v2/worktrees/plan010-persistent-llm-transport/apps/api`
  (`lsof -a -p 28682 -d cwd` 로 확인)
- 그래프 상태: 노드 3,082 (Comment 854·Concept 968·Decision 535·Person 187·Project 1·Task 490·Wiki 47),
  관계 13,002 — `/api/graph/stats` 로 조회했다. Phase 03 리포트의 값과 일치한다.
  **이 phase 는 그래프를 건드리지 않았다** — `sync-neo4j`·`reset-neo4j`·`apply-schema` 를 쓰지 않았고 읽기만 했다
- **실제로 측정한 문항 수: 12/12**, 두 측정 모두 36/36 attempts, 오류 0건. 합계 attempt 72건
- `suiteHash` 는 두 회차와 Phase 03 이 동일하다 (`e90f5130182154bb31a82830ab0fb53a310d68ab88ab4ece9d1cf220aeabc43e`)
- 원시 실행 결과 `eval/runs/plan010-schema-{1,2}.json` 은 gitignore 대상이라 커밋하지 않는다

## 세 구간 대조 — 두 측정의 범위로 적는다

| 구간 | attempt | 평균 | 중위 | 최소 | 최대 | `RETRIEVAL` | `ANSWER` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| plan009 확인 (기준값, 리포트 수치, 단일 측정) | 36 | 59.7초 | — | — | — | 2 | 2 |
| plan010 전송 (Phase 03, 두 측정) | 36×2 | 41.6\~44.2초 | 40.4\~42.8초 | 27.9\~29.1초 | 61.4\~93.5초 | 0\~2 | 3, 3 |
| plan010 스키마 (이 phase, 두 측정) | 36×2 | 54.1\~59.5초 | 50.5\~54.7초 | 35.2\~36.4초 | 108.3\~116.9초 | 2, 2 | 2, 3 |

수치는 `eval/runs/plan010-schema-{1,2}.json` 의 `attempts[].latencyMs` 와
`attempts[].deterministicChecks.failureBoundary` 를 직접 집계했다.
`compare.mjs` 는 쓰지 않았다 — `docs/retrospectives/0015-compare-script-fails-with-exit-zero.md` 대로
`summary.questions` 형식을 요구해 실행되지 않는다.

## 판정 1 — 전송 전환은 개선이다

41.6\~44.2초(Phase 03) 대 기준값 59.7초. 구간이 겹치지 않고 차이가 15.5\~18.1초다.
이 판정은 Phase 03 리포트가 이미 내렸고 이 phase 에서 뒤집지 않는다.

## 판정 2 — `outputSchema` 는 지연을 늘렸다

54.1\~59.5초(이 phase) 대 41.6\~44.2초(Phase 03). **두 구간이 겹치지 않는다.** 증가폭이 9.9\~17.9초다.

Phase 04 의 전제("형식 위반 재시도가 잦았다")가 맞다면 지연이 거의 안 움직이는 것이 정상이라고
phase 파일에 적혀 있었지만, **실측은 늘어났다.** 늘었다는 사실 자체가 이 phase 의 발견이다.

분포도 벌어졌다.

| 구간 | 최대 |
| --- | ---: |
| 전송 (Phase 03) | 61.4초, 93.5초 |
| 스키마 (이 phase) | 108.3초, 116.9초 |

스키마 쪽 최대가 108\~117초로 전송 쪽보다 크게 벌어진다. 평균만 보면 이 꼬리가 안 보인다.

## 판정 3 — 최종 상태는 기준값과 사실상 구분되지 않는다

스키마 구간 상한 59.5초와 기준값 59.7초의 차이는 **0.2초**다.

산술적으로는 겹치지 않지만 이 차이를 개선이라 부르지 않는다.

- 같은 코드로 두 번 잰 스키마 구간 자체가 5.4초 폭이다 (54.1\~59.5초)
- 전송 구간도 2.6초 폭이었다
- 0.2초는 이 측정 잡음 폭 안에 완전히 묻힌다

**plan 전체(전송 전환과 `outputSchema` 를 함께)의 지연 개선은 기준값 대비로 사실상 사라졌다.**
얻은 것은 전송 전환 단독의 개선(15.5\~18.1초)이고, `outputSchema` 가 그 절반 이상(9.9\~17.9초)을
되돌려 놓았다.

## 판정 4 — 회수는 지키고 있다

다섯 측정(기준값 1건, 전송 2건, 스키마 2건) 전부 `RETRIEVAL` 실패가 0\~2건으로 기준값 2건을 포함한다.
이 phase 두 회차는 모두 2건이었고, 둘 다 `AGW-H03` 문항이다.

### `AGW-H03` — 남은 실패의 근거

두 회차 모두 같은 근거 항목이 빠졌다.

```
missingRequiredEvidence: ["comment-483-lb-blocked", "comment-483-trust-fixed"]
```

`graph.status` 는 PASS(앵커 `task-483`·`task-494` 의 노드·관계는 재현됨), `retrieval.status` 만 FAIL 이다.
483 의 댓글 두 건이 업무당 상한 8 밖인지는 **확인되지 않았다** — phase 파일이 이미 지목한 미확인
사항이고 이 phase 에서도 원인을 파지 않았다(범위 외).

## 판정 5 — `ANSWER` 경계는 실행 간 변동이다 (Phase 03 결론과 일치)

| 측정 | `ANSWER` |
| --- | ---: |
| 스키마 1회차 | 3 |
| 스키마 2회차 | **2** |

1회차는 `AGW-A01` 3회 전부 실패, 2회차는 그중 하나가 통과해 `ANSWER` 가 2로 돌아왔다.
Phase 03 이 `AGW-A01` 의 `order` 검사가 답변 서두 요약 문장의 범위 표기("496\~499")에 취약하다고
규명했고, 값이 2\~3 을 오간 이 회차 결과가 그 결론을 뒷받침한다. **회귀가 아니고 다시 조사하지 않았다.**

## 트레이드오프의 한쪽만 측정됐다

`outputSchema` 의 비용(지연 증가 9.9\~17.9초)은 측정됐다. **이득(형식 위반 재시도 경로 제거)은
측정하지 못했다.** `apps/api/src/query/query.service.ts` 에 `Logger`·`console` 이 하나도 없어
(실측 0건) `completeStructured` 의 재시도 발생 빈도가 로그에 남지 않는다.
재시도 계측은 이 plan 범위 밖이고 추정치를 만들지 않았다.

즉 **`outputSchema` 를 되돌릴지 판단할 근거는 아직 반쪽이다** — 비용은 확인됐고 이득은 미확인이다.

## 의미 판정 범위

두 판정자 의미 판정을 하지 않았다. Phase 03 과 같은 이유다 — 목표 지표(지연·회수)가 결정적 축이고,
plan006 에서 36회 중 22회가 채점자 불일치로 `REVIEW` 였던 실측이 있어 정보량이 낮다.
답변 품질의 변화는 판정하지 않았다.

## 프로세스 정리

측정에 쓴 API 인스턴스(`node dist/main.js`, PID 28682, `PORT=3100`)와 그 자식 프로세스
(`codex app-server --listen ws://127.0.0.1:59269`)를 종료했다.

- 지운 것: PID 28682(API)와 그 자식 app-server
- 남긴 것: 다른 워크트리 소유 API·`Codex.app` 소유 `--listen stdio://` 프로세스는 건드리지 않았다
- 정리 후 `pgrep -f 'app-server --listen ws://'` 0줄, `lsof -nP -iTCP:3100 -sTCP:LISTEN` 0줄로 확인했다

## 다음 병목

1. **`outputSchema` 유지 여부 판단** — 지연 비용(9.9\~17.9초 증가)은 확인됐고 이득(재시도 경로 제거
   빈도)은 미측정이다. 재려면 `completeStructured` 에 카운터 로그가 필요하다
2. **`order` 검사가 요약 문장의 범위 표기·문단 내 교차 언급에 취약하다** (Phase 03 발견, 미해결)
3. **`compare.mjs` 가 `run.mjs` 출력 형식과 안 맞고 종료 코드 0 으로 조용히 실패한다**
   (`docs/retrospectives/0015-compare-script-fails-with-exit-zero.md`)
4. `AGW-H03` 하나가 남아 있고 483 의 댓글 두 건이 업무당 상한 8 밖인지 확인되지 않았다
5. 이 세트로는 개선을 더 재기 어렵다(12문항 중 11개 전회 통과 이력). 다음은 차별 대역 문항 확보다.
   재료는 `eval/questions-{human,ai}-tc-ocr.json` 34문항에 있고 현재 어느 스크립트도 읽지 않는다

## 결론

- **전송 전환은 개선이다.** 41.6\~44.2초 구간이 기준값 59.7초와 겹치지 않는다
- **`outputSchema` 는 지연을 늘렸다.** 54.1\~59.5초 구간이 전송 구간과 겹치지 않고 9.9\~17.9초 늘었다
- **plan 전체의 지연 개선은 기준값 대비로 사실상 사라졌다.** 스키마 구간 상한(59.5초)과 기준값
  (59.7초)의 차이 0.2초는 측정 잡음 폭(스키마 구간 자체 폭 5.4초) 안에 묻혀 개선이라 부르지 않는다
- **회수는 지키고 있다.** 다섯 측정 모두 `RETRIEVAL` 실패 0\~2건으로 기준값을 포함한다.
  남은 실패는 `AGW-H03` 하나이고 근거는 `comment-483-lb-blocked`·`comment-483-trust-fixed` 미회수다
- **`ANSWER` 경계 2\~3 은 회귀가 아니다.** Phase 03 이 규명한 `order` 검사 취약점과 일치하는 실행 간 변동이다
- **`outputSchema` 를 되돌릴지는 이 phase 에서 판단하지 않는다.** 비용은 쟀고 이득은 못 쟀다
- 이 phase 는 측정만 했다. 코드·프롬프트·그래프를 고치지 않았다

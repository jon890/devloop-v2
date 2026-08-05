---
id: RETRO-0015
plan: plan010-persistent-llm-transport
date: 2026-08-05
phase: phase-03
status: 진행 중
category: 결함
promotion: 검토 중
---

# 비교 스크립트가 형식 불일치로 죽는데 종료 코드가 0 이다

## 관찰

phase-03 이 회수 비교에 `compare.mjs` 를 쓰라고 지시했지만 그 명령이 실행되지 않는다.

```
$ node .claude/skills/kg-eval/scripts/compare.mjs \
    --baseline eval/runs/plan010-transport-1.json \
    --candidate eval/runs/plan010-transport-2.json
summary questions must be an array
--- exit=0 ---
```

두 스크립트의 형식이 어긋난다.

| 스크립트 | 형식 |
| --- | --- |
| `compare.mjs:38-42` | `summary.questions` 배열을 요구한다 |
| `run.mjs:433-447` | `attempts` 배열을 낸다. `questions` 필드가 없다 |

**종료 코드가 0 이다.** 오류 메시지를 내고도 성공으로 보인다.

## 원인

`run.mjs` 의 출력 형식이 attempt 단위로 바뀐 뒤 `compare.mjs` 가 따라가지 않은 것으로 보인다.
`compare.mjs` 는 문항 단위 요약을 전제한다.

종료 코드 0 은 오류를 잡아 메시지만 찍고 정상 종료하는 경로가 있기 때문이다.

## 영향

이번에는 executor 가 출력을 읽어 알아챘고, 회수·경계 집계를 
`attempts[].deterministicChecks.failureBoundary` 직접 집계로 대신했다.
team-lead 가 같은 값을 독립 집계해 일치를 확인했으므로 리포트 수치는 신뢰할 수 있다.

**위험은 종료 코드만 보는 경우다.** 자동화나 스크립트가 `&&` 로 이어 붙이면 비교가 안 됐는데도
다음 단계로 넘어간다. "비교했고 차이가 없었다" 와 "비교 자체가 안 됐다" 가 구분되지 않는다.

## 대응

이 plan 에서는 직접 집계로 우회했다. 스크립트 수정은 범위 밖이라 하지 않았다.
리포트(`eval/reports/2026-08-05-plan010-transport.md`)에 우회 사실과 근거를 남겼다.

## 검증

- `compare.mjs` 를 두 회차 파일로 돌려 같은 오류와 종료 코드 0 을 재현했다
- 직접 집계 값이 team-lead 독립 집계와 일치했다

## 배운 점

`docs/pitfalls/testing.md` 는 "`pnpm --filter api test` 가 `test` 스크립트가 없으면 exit 0 으로
조용히 통과한다" 를 기록했다. **같은 부류가 평가 도구에도 있다.**
이 저장소의 측정은 종료 코드가 아니라 출력 내용을 읽어야 신뢰할 수 있다.

phase 파일이 명령을 지시할 때 **그 명령이 실제로 실행되는지 확인하지 않으면 spec 결함이 된다.**
critic 이 v1 에서 `compare.mjs` 가 지연을 비교하지 않는다는 것은 확인했지만
실행 자체가 되는지는 확인하지 않았다.

## 후속

`compare.mjs` 를 `run.mjs` 출력 형식에 맞추거나, 최소한 **형식 불일치에서 0 이 아닌 코드로 끝나게**
고친다. 후자만으로도 조용한 실패는 사라진다.
`docs/pitfalls/measurement.md` 승격을 검토한다 — 측정 직전에 읽는 파일이라 그쪽이 맞다.

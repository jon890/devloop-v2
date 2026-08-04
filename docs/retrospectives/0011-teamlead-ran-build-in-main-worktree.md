---
id: RETRO-0011
plan: plan010-persistent-llm-transport
date: 2026-08-04
phase: critic 평가 대기 중 (phase 실행 전)
status: 해결
category: 프로세스
promotion: 검토 중
---

# team-lead 가 기준값 측정을 main 워킹 트리에서 돌렸다

## 관찰

워크트리를 만들고 critic 평가를 기다리는 동안 변경 전 테스트 개수 기준값을 재려고
`pnpm -r build` 와 `pnpm --filter api test` 를 백그라운드로 띄웠다.
그 명령이 워크트리가 아니라 **main 워킹 트리(`/Users/nhn/personal/devloop-v2`)에서 실행됐다.**
세션 cwd 가 여전히 main 이었고 명령에 `cd` 를 붙이지 않았다.

## 원인

cwd 격리 가드가 executor 스폰 프롬프트에만 적용된다고 읽었다.
가드의 대상은 executor 지만, 격리를 깨뜨릴 수 있는 주체는 team-lead 도 같다.
team-lead 는 자기 셸에서 검증 명령을 직접 돌리는데 그 셸의 cwd 를 매번 확인하지 않았다.

## 영향

실제 피해는 없었다. 산출물이 `dist/` 로 gitignore 대상이고 추적 파일을 고치지 않았다.
`git -C <main> status --short` 가 이전과 같은 추적되지 않은 문서 2개만 보고했다.
다만 같은 실수가 `git commit`·`git checkout` 이었으면 main 이 origin 과 갈라졌다.

## 대응

명령을 즉시 중단하고 `cd <워크트리>` 를 앞에 붙여 다시 돌렸다.
이후 백그라운드 명령의 첫 줄에 `pwd` 를 넣어 실행 위치를 출력으로 남겼다.

## 검증

- 재실행 출력 첫 줄이 워크트리 절대경로였다
- `git -C /Users/nhn/personal/devloop-v2 status --short` 가 추적되지 않은 문서 2개만 보고했다
- 기준값을 워크트리에서 다시 확보했다 — api 75, pipeline 163(5 건너뜀)

## 배운 점

cwd 격리는 executor 전용 가드가 아니다.
team-lead 도 검증 명령을 자기 셸에서 돌리므로 같은 함정에 걸린다.
백그라운드 명령은 실행 위치가 출력에 남지 않아 사후에 어디서 돌았는지 알 수 없다 —
그래서 첫 줄에 `pwd` 를 찍는 것이 사후 확인의 유일한 근거가 된다.

## 후속

`build-with-teams` 의 cwd 격리 가드를 team-lead 자신에게도 적용하도록 승격할지 검토한다.

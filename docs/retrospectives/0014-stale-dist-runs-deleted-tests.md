---
id: RETRO-0014
plan: plan010-persistent-llm-transport
date: 2026-08-04
phase: phase-02
status: 해결
category: 환경
promotion: 검토 중
---

# 지운 테스트가 옛 dist 산출물로 계속 돌았다

## 관찰

Phase 02 가 `apps/pipeline/src/llm/codex-cli.adapter.ts` 와 그 테스트를 지운 뒤
`pnpm --filter pipeline test` 가 없는 모듈을 찾으며 죽었다.

```
Cannot find module '../dist/llm/codex-cli.adapter'
```

소스에서는 이미 사라진 테스트였다.

## 원인

셋이 겹칠 때 생긴다.

1. `src/**/*.test.ts` 를 지우거나 이름을 바꾼다
2. `dist` 를 지우지 않고 `tsc` 를 다시 돌린다 — `pnpm build` 가 그렇다.
   `tsc` 는 지운 소스의 산출물을 지우지 않는다
3. test 스크립트가 파일 열거가 아니라 **글롭**이다 (`dist/llm/*.test.js`)

`apps/pipeline` 의 `test` 가 디렉터리별 글롭이라 이 조건에 걸린다.
`apps/api` 의 `test:unit` 은 파일을 하나씩 열거하므로 이 증상이 나지 않는다.

## 영향

이번에는 즉시 드러났다. 지운 모듈을 `require` 해서 죽었기 때문이다.

**반대 방향이 더 위험하다.** 지운 테스트가 옛 산출물로 **계속 통과하면**,
지운 줄 알았던 계약을 아직 검증하고 있는 것으로 착각한다.
그때는 개수 확인으로도 안 잡힌다 — 옛 테스트가 통과하면 개수가 오히려 맞아 보인다.

## 대응

소스 파일을 지우거나 옮긴 뒤 해당 패키지의 `dist` 를 지우고 빌드한다.

```bash
# cwd: 저장소 루트
rm -rf apps/pipeline/dist apps/api/dist packages/llm/dist && pnpm -r build
```

team-lead 의 독립 검증도 이 순서로 돌려 executor 보고와 일치함을 확인했다.

## 검증

- `dist` 를 지우고 다시 빌드한 뒤 pipeline 이 160(통과 155, 건너뜀 5)으로 기대치와 맞았다
- `buildCodexArgs` 3건 제거로 163 에서 160 이 된 것이 설명된다

## 배운 점

`docs/pitfalls/testing.md` 는 "개수를 확인하라" 를 반복해서 못박는다.
그 규칙은 **테스트가 빠지는 방향**을 잡지만 **지운 테스트가 남는 방향**은 잡지 못한다.
개수가 맞아 보이는 것이 오히려 증상이다.

소스를 지우는 변경에서는 개수 확인 전에 `dist` 를 지워야 개수 자체가 신뢰할 수 있는 값이 된다.

## 후속

`docs/pitfalls/testing.md` 승격을 검토한다. 기존 "새 테스트 파일은 목록에 넣어야 실행된다" 의
반대 방향이라 같은 절에 짝으로 두면 읽는 사람이 두 방향을 함께 본다.

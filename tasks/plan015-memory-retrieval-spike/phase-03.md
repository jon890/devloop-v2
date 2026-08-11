# Phase 03 — recall과 운영 비용으로 채택 여부를 판정한다

**Execution profile**: deep
**Status**: pending

---

## 목표

실제 miss query에서 세 adapter의 top-k recall과 Retrieval Tax를 반복 측정하고 production 변경 없이 채택·기각·판정 불가를 결론낸다.

**범위 외**: production backend 교체, vector DB 설치, 새로운 Issue를 자동 생성.

---

## 작업 항목 (5)

### 1. 같은 입력을 3회 교차 측정한다

adapter별로 몰아 재지 않고 query마다 lexical → SQLite → hybrid 순서를 회차별로 회전한다.
각 실행은 같은 corpus hash와 top-k를 사용한다.

### 2. recall 개선과 비용을 함께 계산한다

requiredMemoryIds의 top-k recall, search latency, build time, index size, RSS delta, dependency·service 수를 기록한다.
recall만 좋아지고 비용이 과도하면 채택으로 판정하지 않는다.

### 3. 결과 제한을 드러낸다

hashed n-gram hybrid가 의미 모델이 아니라는 점, query 수, task 수, 변동 구간을 report에 명시한다.
입력이 너무 적으면 `INCONCLUSIVE`로 둔다.

### 4. 공개 report를 생성한다

`eval/reports/2026-08-12-plan015-memory-retrieval.json`과 `.md`에 내부 query·Memory 전문 없이 hash, 집계, 비용, 판정만 남긴다.
동일 raw input에서 report가 byte-identical이어야 한다.

### 5. 독립 검증과 완료 마킹을 수행한다

verifier가 miss 추적, corpus/top-k 동일성, 표 집계를 검증한다.
`tasks/plan015-memory-retrieval-spike/index.json`과 phase status를 `completed`로 바꾸고 실행 기록을 추가한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `eval/runs/plan015-retrieval-comparison.json` | raw 비교, commit하지 않음 |
| `eval/reports/2026-08-12-plan015-memory-retrieval.json` | 신규 |
| `eval/reports/2026-08-12-plan015-memory-retrieval.md` | 신규 |
| `tasks/plan015-memory-retrieval-spike/index.json` | 완료 마킹 |
| `tasks/plan015-memory-retrieval-spike/phase-*.md` | 완료 마킹 |
| `docs/retrospectives/RUNS.md` | 실행 기록 추가 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/*.test.mjs
pnpm -r build
pnpm format:check
git diff --check
git status --short
```

private query와 raw 비교 파일은 `git status`에 나타나지 않아야 한다.

## 의도 메모 (왜)

- `no change`와 `INCONCLUSIVE`를 실패로 취급하지 않아 기술 선도입 압력을 막는다.
- production 변경은 이 PR의 결과가 아니라 별도 채택 결정의 책임이다.

## Blocked 조건

- corpus hash나 top-k가 adapter 사이에서 다르면 `PHASE_BLOCKED: retrieval 비교 조건 불일치`로 종료한다.

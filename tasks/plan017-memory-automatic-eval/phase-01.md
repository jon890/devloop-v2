# Phase 01 — automatic retrieval fail-safe를 구현한다

**Execution profile**: deep
**Status**: pending

---

## 목표

plan014의 voluntary 기준선과 같은 `memory-search`를 task 시작 전에 한 번 호출하되 stale·uncertain·low-confidence Memory가 current source를 덮어쓰지 못하는 평가 조건을 구현한다.

**전제**: plan014가 `main`에 병합되고 같은 public suite, private source lock, Memory index, voluntary raw run을 사용할 수 있어야 한다.

**범위 외**: 전역 hook 배포, 모든 결과 무조건 주입, vector retrieval 변경, production 기본값 변경.

---

## 작업 항목 (5)

### 1. automatic condition을 분리한다

`.claude/skills/kg-eval/scripts/memory/automatic-condition.mjs`는 task prompt와 scope로 `memory-search`를 정확히 한 번 호출한다.
product search 결과를 재정렬하거나 별도 backend를 호출하지 않는다.

### 2. 안전한 주입 규칙을 고정한다

`status=active`이고 `confidence=high`인 결과만 본문을 주입한다.
medium은 title·원문 확인 경고만 제공하고 low, uncertain, superseded, deprecated, historical은 본문을 주입하지 않는다.

### 3. current source 우선 규칙을 강제한다

모든 자동 context에 “Memory는 단서이며 current source와 충돌하면 source가 우선” 지시를 넣는다.
Git SourceRef revision과 task source lock이 충돌하면 본문 대신 source confirmation warning만 제공한다.

### 4. 조회와 주입을 별도 계측한다

memoryCalls, retrievedCount, injectedCount, warnedCount, skippedStaleCount, contextBytes를 raw telemetry에 추가한다.
조회했지만 주입하지 않은 task도 불필요한 조회 분모에 포함한다.

### 5. hostile fixture로 fail-safe를 검증한다

stale Memory가 current source와 반대 결론을 갖는 fixture, uncertain high score, low confidence active, revision conflict를 테스트한다.
가드를 하나씩 제거하면 테스트가 실패하는 변이 검증을 수행하고 즉시 원복한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/scripts/memory/automatic-condition.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/condition.mjs` | automatic 조건 추가 |
| `.claude/skills/kg-eval/scripts/memory/telemetry.mjs` | 조회·주입 지표 추가 |
| `.claude/skills/kg-eval/tests/memory-automatic.test.mjs` | fail-safe·변이 테스트 신규 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/memory-automatic.test.mjs
rg -n "vector|embedding|api/query" .claude/skills/kg-eval/scripts/memory/automatic-condition.mjs
git diff --check
```

`rg` 결과는 0줄이어야 한다.

## 의도 메모 (왜)

- high·active만 본문 주입하면 automatic이 오래된 결정을 확신 있게 퍼뜨리는 실패를 줄일 수 있다.
- 조회와 주입을 나누는 이유는 context를 넣지 않아도 tool latency는 이미 지불했기 때문이다.

## Blocked 조건

- plan014와 같은 index hash를 사용할 수 없으면 `PHASE_BLOCKED: automatic 비교 기준선 불일치`로 종료한다.

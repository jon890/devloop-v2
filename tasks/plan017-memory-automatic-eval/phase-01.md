# Phase 01 — automatic retrieval fail-safe를 구현한다

**Execution profile**: deep
**Status**: pending

---

## 목표

plan014의 voluntary 기준선과 같은 `memory-search`를 task 시작 전에 한 번 호출하되 stale·uncertain·low-confidence Memory가 current source를 덮어쓰지 못하는 평가 조건을 구현한다.

**전제**: plan014가 완료 상태로 `main`에 병합되고 이 worktree가 최신 `origin/main` 이후여야 한다. 같은 public suite, private source lock, Memory index, ignored `eval/runs/plan014-utility.json`을 복사할 수 있어야 한다. 삭제된 Plan014 Wiki index 원문은 이전 실행 기록에서 복구한 뒤 exact byte hash `sha256:8709e0a8f3443eb067f30c9a535ccd489ac4fdc0528278ce1c671e838bac00fd`를 확인해 ignored `apps/pipeline/data/memory/tc-ocr/`에 배치한다. hash가 다르면 재추출하거나 새 corpus로 대체하지 않으며, 이 복구에는 LLM을 호출하지 않는다.

착수 전에 `git fetch origin`, `git merge-base --is-ancestor origin/main HEAD`, plan014 `index.json`의 `completed`, 공개 report 존재를 확인한다.
하나라도 실패하면 구현하지 않고 `PHASE_BLOCKED: plan014 미병합 또는 branch base 불일치`로 종료한다.

**범위 외**: 전역 hook 배포, 모든 결과 무조건 주입, vector retrieval 변경, production 기본값 변경.

---

## 작업 항목 (5)

### 1. automatic condition을 분리한다

`.claude/skills/kg-eval/scripts/memory/automatic-condition.mjs`는 plan014 voluntary와 같은 source lock `oracleQuery`로 `memory-search`를 정확히 한 번 호출한다.
product search 결과를 재정렬하거나 별도 backend를 호출하지 않는다.
query는 source lock의 `oracleQuery`, scope는 task repository와 allowed path의 공통 경계, top-k는 plan014와 같은 10으로 결정적으로 만든다.
`run-memory.mjs`는 `automatic`을 experimental condition으로만 허용하고 기존 세 기준선 조건 목록·동일성 검사를 바꾸지 않는다.

### 2. 안전한 주입 규칙을 고정한다

`status=active`, `confidence=high`, freshness=`current`인 결과만 본문을 주입한다.
medium은 title·원문 확인 경고만 제공하고 low, uncertain, superseded, deprecated, historical은 본문을 주입하지 않는다.

freshness 판정은 다음 표로 고정한다.

| SourceRef와 source lock 관계 | freshness | 처리 |
| --- | --- | --- |
| Git repository가 task repository와 같고 revision이 `baseRevision` 또는 `targetRevision` | `current` | status·confidence 판정 통과 시 본문 주입 |
| 같은 repository지만 revision이 두 lock revision 밖 | `stale` | 본문 금지, revision conflict 경고 |
| 다른 Git repository 또는 Git SourceRef가 없음 | `unknown` | 본문 금지, 원문 확인 경고 |
| Dooray task·comment·wiki SourceRef만 존재 | `unknown` | 본문 금지, HTTP 원문 확인 경고 |

한 Memory에 여러 SourceRef가 있으면 하나라도 `stale`이면 stale이고, stale이 없으며 현재 task repository의 `current` Git ref가 하나 이상일 때만 current다.
repository는 SourceRef `repository`와 source lock `sourceUrl`에서 얻은 canonical repository 이름을 대소문자 구분 없이 비교한다.
`sourceUrl`은 `URL`로 파싱하고 pathname의 `/commit/` 또는 `/blob/` 직전 segment를 percent-decode한 뒤 `.git` suffix를 제거한다.
두 marker가 없거나 repository 이름을 얻지 못하면 freshness를 추측하지 않고 해당 task를 차단한다.

### 3. current source 우선 규칙을 강제한다

모든 자동 context에 “Memory는 단서이며 current source와 충돌하면 source가 우선” 지시를 넣는다.
Git SourceRef revision과 task source lock이 충돌하면 본문 대신 source confirmation warning만 제공한다.

### 4. 조회와 주입을 별도 계측한다

기존 top-level `attempts` schema를 유지하고 각 automatic attempt에 memoryCalls, retrievedCount, injectedCount, warnedCount, skippedStaleCount, contextBytes, staleInjectionCount를 flat field로 추가한다.
조회했지만 주입하지 않은 task도 불필요한 조회 분모에 포함한다.

### 5. hostile fixture로 fail-safe를 검증한다

stale Memory가 current source와 반대 결론을 갖는 fixture, uncertain high score, low confidence active, revision conflict, voluntary와 automatic query 동일성을 테스트한다.
가드를 하나씩 제거하면 테스트가 실패하는 변이 검증을 수행하고 즉시 원복한다.

---

## Critical Files

| 파일 | 변경 |
| --- | --- |
| `.claude/skills/kg-eval/scripts/memory/automatic-condition.mjs` | 신규 |
| `.claude/skills/kg-eval/scripts/memory/condition.mjs` | 기존 기준선과 분리된 automatic builder 추가 |
| `.claude/skills/kg-eval/scripts/run-memory.mjs` | experimental condition 실행·prompt·flat attempt 저장 보강 |
| `.claude/skills/kg-eval/scripts/memory/telemetry.mjs` | 조회·주입 지표 추가 |
| `.claude/skills/kg-eval/references/result-contract.md` | automatic flat attempt field 계약 보강 |
| `.claude/skills/kg-eval/tests/memory-automatic.test.mjs` | fail-safe·변이 테스트 신규 |
| `.claude/skills/kg-eval/tests/run-memory.test.mjs` | automatic 실행·재개·기준선 비회귀 보강 |

## 검증

```bash
# cwd: 저장소 루트
node --test .claude/skills/kg-eval/tests/memory-automatic.test.mjs
node --test .claude/skills/kg-eval/tests/run-memory.test.mjs
test "$(rg -c 'vector|embedding|api/query' .claude/skills/kg-eval/scripts/memory/automatic-condition.mjs || true)" = "0"
test "$(shasum -a 256 apps/pipeline/data/memory/tc-ocr/wiki-generations/wiki-9df083959e2b83b7324eabb67197cbcaacd1797f32e77b148cfc47c9969909eb/index.json | awk '{print $1}')" = "8709e0a8f3443eb067f30c9a535ccd489ac4fdc0528278ce1c671e838bac00fd"
git diff --check
```

`rg` 결과는 0줄이어야 한다.

## 의도 메모 (왜)

- high·active만 본문 주입하면 automatic이 오래된 결정을 확신 있게 퍼뜨리는 실패를 줄일 수 있다.
- 조회와 주입을 나누는 이유는 context를 넣지 않아도 tool latency는 이미 지불했기 때문이다.

## Blocked 조건

- plan014와 같은 index hash를 사용할 수 없으면 `PHASE_BLOCKED: automatic 비교 기준선 불일치`로 종료한다.

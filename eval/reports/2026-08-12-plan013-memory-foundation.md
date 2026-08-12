# Plan013 Memory Evaluation Foundation

## 상태

COMPLETED.

phase-03의 코드 보완, 4개 target packet 기반 Memory 생성 경로, source-state stable window와 두 Agent smoke를 검증했다.
private source lock과 raw runs는 ignored `eval/runs/` 아래에만 보존한다.
이 보고서는 hash, count, anonymous measurement만 기록한다.

## Source Lock

| Item | Value |
| --- | ---: |
| Public suite tasks | 4 |
| Private source lock tasks | 4 |
| Suite hash | `484a42b87cf0c79421ba1db14f74cb561701450bfef1e1bb09686d73d5a09bff` |
| Source lock hash | `84972a90277b2df5a80f24c33ba575f2247fc5ed048bf4c69403d2e43c6de94a` |
| Categories | 2 code-only, 2 experience-needed |
| Relationship-heavy tasks | 1 |

## Coverage

| Item | Count |
| --- | ---: |
| Isolated git repositories in normalize snapshot | 9 |
| Target commit packets present | 4 |
| Target commit packets missing | 0 |
| Exact-id extraction selected packets | 4 |
| Exact-id extraction succeeded packets | 4 |
| Exact-id extraction failed packets | 0 |
| Extracted Memory records | 9 |
| Immediate cache rerun calls | 0 |
| Immediate cache rerun hits | 4 |

## Source Grounding

현재 immutable source generation의 manifest와 evidence packet을 다시 대조했다.
Dooray 업무, 댓글, Wiki와 OCR Git 저장소가 모두 같은 generation에 포함되어 있다.

| Source | Count |
| --- | ---: |
| Dooray tasks | 507 |
| Dooray comments | 897 |
| Dooray Wiki pages | 47 |
| OCR Git repositories | 9 |
| Dooray task evidence packets | 507 |
| Dooray Wiki evidence packets | 47 |
| Git commit evidence packets | 2,073 |
| Git file evidence packets | 39 |

모든 evidence segment는 HTTP SourceRef를 가지며 원문을 다시 따라갈 수 있다.
source generation은 content hash로 고정되고 동일 generation ID의 byte 불일치는 거부한다.

## Benchmark Wiki

| Item | Value |
| --- | ---: |
| Complete | false |
| Memory records | 9 |
| Index hash | `sha256:8709e0a8f3443eb067f30c9a535ccd489ac4fdc0528278ce1c671e838bac00fd` |
| Documents with HTTP SourceRef links | 9 |
| Oracle search checks | 4 |
| Oracle search checks with results | 4 |

Wiki는 선택한 4개 packet에서 생성된 incomplete benchmark Wiki다.
전체 source generation의 모든 packet을 추출한 것이 아니므로 `complete=false`가 정상이다.

## Agent Smoke

| Agent | Category | Agent exit | Validation | Task success | Memory calls | Result |
| --- | --- | ---: | ---: | --- | ---: | --- |
| Codex | code-only | 0 | 0 | true | 0 | pass |
| Claude | experience-needed | 143 | 2 | false | 2 | timeout observation |
| Claude | experience-needed | 0 | 0 | true | 2 | pass |

현재 source lock의 첫 Claude task는 voluntary Memory 검색을 2회 수행했지만 10분 제한을 넘겨 실패 관측값으로 보존했다.
같은 source lock과 Memory index의 두 번째 experience-needed task는 72초 안에 검색 2회, source read 4회, validation 성공, wrong edit 0건으로 완료했다.
과거 다른 source lock에서 subscription limit로 종료된 attempt는 acceptance 근거로 사용하지 않았다.
no metered API 조건 때문에 fallback API로 우회하지 않았다.

## Source State

| Check | Count |
| --- | ---: |
| Controlled source repos compared | 4 |
| Stable branch, HEAD, and status excluding runtime data | 4 |
| Status excluding runtime data stable | 4 |

최종 fresh controlled window에서 원본 source repo 4개의 branch, HEAD, `.omc/` 제외 status가 모두 같았다.
runner는 ignored isolated snapshot과 per-run workspace만 썼고 원본 source repo에는 checkout, reset, clean, fetch, write를 수행하지 않았다.

## Validation

| Command | Result |
| --- | --- |
| `node --test .claude/skills/kg-eval/tests/*.test.mjs` | pass, 77 tests |
| `pnpm --filter pipeline test` | pass, 218 tests |
| `node .claude/skills/kg-eval/scripts/validate-memory-suite.mjs ...` | pass |
| `node .claude/skills/kg-eval/scripts/memory/privacy.mjs ...` | pass, violations 0 |
| `node .claude/skills/kg-eval/scripts/validate-suite.mjs ...` | not applicable to Memory suite schema |

## Result

code-only skip과 experience-needed voluntary trigger를 두 Agent에서 확인했다.
실패 attempt를 숨기지 않고 보존했으며, 현재 source lock의 성공 smoke와 독립 code·docs 검토를 완료 근거로 사용한다.

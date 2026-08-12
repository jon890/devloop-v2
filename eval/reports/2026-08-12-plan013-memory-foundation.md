# Plan013 Memory Evaluation Foundation

## 상태

PHASE_BLOCKED.

phase-03의 코드 보완과 4개 target packet 기반 Memory 생성 경로, source-state stable window를 검증했지만, 최종 acceptance 조건 중 subscription Agent smoke가 충족되지 않았다.
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
| Claude | experience-needed | not run | not run | not run | not run | blocked |

과거 Claude attempt는 서로 다른 source lock에서 subscription limit로 종료되어 현재 source lock의 acceptance 근거로 사용하지 않는다.
현재 source lock의 Claude smoke는 subscription reset 뒤 새 output에서 다시 실행해야 한다.
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

## Blocker

현재 acceptance를 낮추지 않고 완료하려면 Claude subscription limit reset 이후 experience-needed smoke를 다시 실행해야 한다.

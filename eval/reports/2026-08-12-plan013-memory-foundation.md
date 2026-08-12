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
| Source lock hash | `dbc2ec8d42f606c266a098e879898c840f437d25f771e16f1de8b023fe7cb360` |
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
| Claude | experience-needed | 1 | 0 | true | 0 | blocked |

Claude subscription smoke는 task validation 자체는 통과했지만, CLI subscription limit 때문에 Agent exit가 비영값이고 voluntary Memory search trigger가 발생하지 않았다.
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
| `node --test .claude/skills/kg-eval/tests/*.test.mjs` | pass, 75 tests |
| `pnpm --filter pipeline test` | pass, 218 tests |
| `node .claude/skills/kg-eval/scripts/validate-memory-suite.mjs ...` | pass |
| `node .claude/skills/kg-eval/scripts/memory/privacy.mjs ...` | pass, violations 0 |
| `node .claude/skills/kg-eval/scripts/validate-suite.mjs ...` | not applicable to Memory suite schema |

## Blocker

현재 acceptance를 낮추지 않고 완료하려면 Claude subscription limit reset 이후 experience-needed smoke를 다시 실행해야 한다.

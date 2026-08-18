# Plan017 Memory Automatic Report

## Summary

| Decision | Priority | Recovered | Unnecessary | Stale | WrongDelta | Regression |
| --- | --- | --- | --- | --- | --- | --- |
| INCONCLUSIVE | 5 | 1 | 6 | 0 | -1 | 0 |

missing token/cost samples or mixed results prevent deterministic adoption

## Hashes

| Key | Value |
| --- | --- |
| Voluntary run hash | `c9f2d325d2e211dc1ef7d3fc324e633eea5f9ca0b59724b612e66d8b0c78fc43` |
| Automatic run hash | `268a2a240986d997891613f4007717cb6d84e2d110c1676b940947cadf0575d6` |
| Suite hash | `484a42b87cf0c79421ba1db14f74cb561701450bfef1e1bb09686d73d5a09bff` |
| Source lock hash | `a6e5a935f43df18809803a6f461479e41367ddafc211db46ab44dd1c0dc01d44` |
| Memory index hash | `sha256:8709e0a8f3443eb067f30c9a535ccd489ac4fdc0528278ce1c671e838bac00fd` |

## Identity

| ComparedAttempts | MatchedPairs | TaskRevisionValidationModelIndex |
| --- | --- | --- |
| 24 | 12 | true |

## Trigger Quality

| Condition | TP | FN | FP | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| voluntary | 0 | 6 | 0 | 6 | null | 0 |
| automatic | 6 | 0 | 6 | 0 | 0.5 | 1 |

## Recovery

| Task | VoluntarySuccess | MissEvidence | AutomaticSuccess | AutomaticWrong |
| --- | --- | --- | --- | --- |
| MEM-EXP-001 | 2 | 3 | 3 | 0 |

## Unnecessary Retrieval

| CodeOnly | Empty | Union |
| --- | --- | --- |
| 6 | 0 | 6 |

## Task Metrics

| Task | Category | VSuccess | ASuccess | VWrong | AWrong | WallDeltaRatio | InputDeltaRatio | OutputDeltaRatio | MemoryCallsDelta | ContextBytesAutomatic | SourceReadsDelta |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MEM-CODE-001 | code-only | 2 | 3 | 0 | 0 | -0.665 | -0.3181 | -0.4609 | 1 | 832 | 0 |
| MEM-CODE-002 | code-only | 3 | 3 | 0 | 0 | -0.3459 | -0.3643 | -0.3281 | 1 | 499 | 0 |
| MEM-EXP-001 | experience-needed | 2 | 3 | 1 | 0 | 0.0021 | -0.3265 | 0.0823 | 1 | 2123 | 0 |
| MEM-EXP-002 | experience-needed | 3 | 3 | 0 | 0 | -0.2344 | -0.2055 | -0.1515 | 1 | 534 | 0 |

## Public Safety

The public report contains only hashes, aggregates, task ids, attempt keys, and classifications.

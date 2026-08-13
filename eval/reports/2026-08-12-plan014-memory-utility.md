# tc-ocr Coding Agent Memory foundation evaluation suite Memory Utility Report

## Goal

Memory Benefit, Retrieval Tax, trigger quality, and failure boundaries are separated so the benchmark does not hide regressions behind aggregate success.

## Hashes

| Key | Value |
| --- | --- |
| Suite hash | `484a42b87cf0c79421ba1db14f74cb561701450bfef1e1bb09686d73d5a09bff` |
| Source lock hash | `a6e5a935f43df18809803a6f461479e41367ddafc211db46ab44dd1c0dc01d44` |
| Memory index hash | `sha256:8709e0a8f3443eb067f30c9a535ccd489ac4fdc0528278ce1c671e838bac00fd` |
| Private miss lock hash | `21ef48365857b532d13b22cde7b523cbfc646ee7a9822bdaf1f3814af8bc8821` |

## Stability

| Task | Condition | Status | Success | Failure | Wrong | Unobserved | Boundary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MEM-CODE-001 | no-memory | UNSTABLE | 2 | 1 | 0 | 0 | null |
| MEM-CODE-001 | agent-triggered | UNSTABLE | 2 | 1 | 0 | 0 | null |
| MEM-CODE-001 | oracle-memory | STABLE_SUCCESS | 3 | 0 | 0 | 0 | null |
| MEM-CODE-002 | no-memory | STABLE_SUCCESS | 3 | 0 | 0 | 0 | null |
| MEM-CODE-002 | agent-triggered | STABLE_SUCCESS | 3 | 0 | 0 | 0 | null |
| MEM-CODE-002 | oracle-memory | STABLE_SUCCESS | 3 | 0 | 0 | 0 | null |
| MEM-EXP-001 | no-memory | STABLE_SUCCESS | 3 | 0 | 0 | 0 | null |
| MEM-EXP-001 | agent-triggered | REGRESSION | 2 | 0 | 1 | 0 | null |
| MEM-EXP-001 | oracle-memory | STABLE_SUCCESS | 3 | 0 | 0 | 0 | null |
| MEM-EXP-002 | no-memory | STABLE_SUCCESS | 3 | 0 | 0 | 0 | null |
| MEM-EXP-002 | agent-triggered | STABLE_SUCCESS | 3 | 0 | 0 | 0 | null |
| MEM-EXP-002 | oracle-memory | STABLE_SUCCESS | 3 | 0 | 0 | 0 | null |

## Memory Benefit

| Task | Condition | Success | Wrong | Rework | SourceReads | MemoryCalls | WallMs | Turns | Tools | InputTokens | OutputTokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MEM-CODE-001 | agent-triggered | null | null | null | null | null | null | null | null | null | null |
| MEM-CODE-001 | oracle-memory | null | null | null | null | null | null | null | null | null | null |
| MEM-CODE-002 | agent-triggered | 0 | 0 | 0 | 0 | 0 | 12272 | 0 | 2 | 34591 | 681 |
| MEM-CODE-002 | oracle-memory | 0 | 0 | 0 | 0 | 1 | 1068 | 0 | 0 | -27020 | 68 |
| MEM-EXP-001 | agent-triggered | null | null | null | null | null | null | null | null | null | null |
| MEM-EXP-001 | oracle-memory | 0 | 0 | 0 | 0 | 1 | 12158 | 0 | 0 | -2790 | 382 |
| MEM-EXP-002 | agent-triggered | 0 | 0 | 0 | 0 | 0 | 12165 | 0 | 1 | 40739 | 378 |
| MEM-EXP-002 | oracle-memory | 0 | 0 | 0 | 0 | 1 | -9939 | 0 | -1 | -13504 | -207 |

## Stable Retrieval Tax

| Condition | Groups | Attempts | Unstable | MemoryCalls | SourceReads | Turns | Tools | WallMs | InputTokens | OutputTokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| no-memory | 3 | 9 | 3 | 0 | 0 | 1 | 4 | 47748 | 154481 | 1760 |
| agent-triggered | 2 | 6 | 6 | 0 | 0 | 1 | 4.5 | 54572 | 182867.5 | 1921 |
| oracle-memory | 4 | 12 | 0 | 1 | 0 | 1 | 2.5 | 39702.5 | 127912 | 1435.5 |

## Unstable Retrieval Tax

| Condition | Groups | Attempts | Unstable | MemoryCalls | SourceReads | Turns | Tools | WallMs | InputTokens | OutputTokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| no-memory | 1 | 3 | 3 | 0 | 0 | 1 | 2 | 26387 | 97623 | 533 |
| agent-triggered | 2 | 6 | 6 | 0 | 0 | 1 | 5 | 73418 | 271452 | 2993 |
| oracle-memory | 0 | 0 | 0 | null | null | null | null | null | null | null |

## Trigger Matrix

| TP | FN | FP | TN | Unobserved | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 6 | 0 | 6 | 0 | null | 0 |

## Failure Boundary

Lexical miss count: 0

Retrieval observation complete: true

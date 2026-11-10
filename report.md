# Test health

Generated 2026-11-10T20:00:22.537Z at `a4b1b9854c64`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1326 (72.3%) |
| Changed since their audit | 0 |
| Never audited | 509 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 15 (completed 13, nothing-to-do 2) |
| Runs by agent | claude-opus-5-5 15 |
| Files audited | 1333 |
| Files changed | 314 |
| Findings | 2101 (1.58 per audited file) |
| By lens | cannot-fail 787, nondeterminism 628, hygiene 297, cost 135, failure-issues 105, overlap 101, not-running 38, tier-and-doubles 10 |
| By action | none 1629, cleanup 176, strengthen 124, deflake 76, file-issue 39, remove 23, rewrite 18, speed-up 11, move-tier 2, split 2, unskip 1 |
| By status | accepted 1629, fixed 372, deferred 72, filed 28 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 117 |
| Mutations killed | 145 |
| Tests made deterministic | 54 |
| Seconds saved per run of the changed files | 73.6 |
| Test declarations in changed files | 3499 before, 3500 after (0 removed, each declared with its obligation map) |
| Executed cases in changed files | 4068 before, 4071 after |
| Executed assertions in changed files | 28417 before, 28581 after |
| Re-audits that found what an earlier audit missed | 1 of 7 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 4 |
| Batches open | 19 (254 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 14 |
| Mean changed files per landed batch | 14.8 |
| Mean hours from first commit to landing | 1.7 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 89 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1292 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

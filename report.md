# Test health

Generated 2026-11-10T20:45:41.231Z at `9250edb6c2c0`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1462 (79.7%) |
| Changed since their audit | 0 |
| Never audited | 373 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 20 (completed 16, nothing-to-do 4) |
| Runs by agent | claude-opus-5-5 20 |
| Files audited | 1479 |
| Files changed | 364 |
| Findings | 2353 (1.59 per audited file) |
| By lens | cannot-fail 865, nondeterminism 699, hygiene 339, cost 155, overlap 122, failure-issues 117, not-running 45, tier-and-doubles 11 |
| By action | none 1799, cleanup 210, strengthen 144, deflake 89, file-issue 42, remove 27, rewrite 20, speed-up 14, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 1799, fixed 437, deferred 88, filed 29 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 135 |
| Mutations killed | 169 |
| Tests made deterministic | 62 |
| Seconds saved per run of the changed files | 73.6 |
| Test declarations in changed files | 3977 before, 3977 after (1 removed, each declared with its obligation map) |
| Executed cases in changed files | 4553 before, 4543 after |
| Executed assertions in changed files | 48568 before, 48751 after |
| Re-audits that found what an earlier audit missed | 1 of 17 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 4 |
| Batches open | 24 (300 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 18 |
| Mean changed files per landed batch | 14.8 |
| Mean hours from first commit to landing | 1.7 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 92 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1295 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

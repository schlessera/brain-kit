# Test health

Generated 2026-11-10T21:29:28.343Z at `738a383d7873`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1602 (87.3%) |
| Changed since their audit | 1 |
| Never audited | 232 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 34 (completed 28, nothing-to-do 6) |
| Runs by agent | claude-opus-5-5 34 |
| Files audited | 1620 |
| Files changed | 435 |
| Findings | 2695 (1.66 per audited file) |
| By lens | cannot-fail 979, nondeterminism 785, hygiene 395, cost 188, overlap 158, failure-issues 128, not-running 50, tier-and-doubles 12 |
| By action | none 2028, cleanup 267, strengthen 173, deflake 95, file-issue 46, remove 36, rewrite 23, speed-up 19, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 2028, fixed 538, deferred 96, filed 33 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 163 |
| Mutations killed | 216 |
| Tests made deterministic | 67 |
| Seconds saved per run of the changed files | 105.1 |
| Test declarations in changed files | 4682 before, 4685 after (2 removed, each declared with its obligation map) |
| Executed cases in changed files | 5461 before, 5454 after |
| Executed assertions in changed files | 55480 before, 55581 after |
| Re-audits that found what an earlier audit missed | 1 of 17 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 6 |
| Batches open | 31 (331 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 19 |
| Mean changed files per landed batch | 16.5 |
| Mean hours from first commit to landing | 2.6 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 107 |
| Sleep-shaped call sites | 888 to 883 |
| Weak matchers | 1295 to 1292 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

# Test health

Generated 2026-11-10T21:07:24.015Z at `39865be95d7c`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1546 (84.3%) |
| Changed since their audit | 0 |
| Never audited | 289 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 24 (completed 20, nothing-to-do 4) |
| Runs by agent | claude-opus-5-5 24 |
| Files audited | 1563 |
| Files changed | 404 |
| Findings | 2551 (1.63 per audited file) |
| By lens | cannot-fail 928, nondeterminism 751, hygiene 374, cost 172, overlap 145, failure-issues 123, not-running 46, tier-and-doubles 12 |
| By action | none 1939, cleanup 247, strengthen 153, deflake 90, file-issue 45, remove 33, rewrite 22, speed-up 14, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 1939, fixed 491, deferred 89, filed 32 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 145 |
| Mutations killed | 191 |
| Tests made deterministic | 63 |
| Seconds saved per run of the changed files | 73.6 |
| Test declarations in changed files | 4346 before, 4346 after (1 removed, each declared with its obligation map) |
| Executed cases in changed files | 5029 before, 5019 after |
| Executed assertions in changed files | 51672 before, 51861 after |
| Re-audits that found what an earlier audit missed | 1 of 17 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 5 |
| Batches open | 26 (328 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 18 |
| Mean changed files per landed batch | 14.2 |
| Mean hours from first commit to landing | 2.2 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 98 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1292 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

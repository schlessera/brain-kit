# Test health

Generated 2026-11-10T20:51:34.329Z at `ee42d4272bb0`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1485 (80.9%) |
| Changed since their audit | 0 |
| Never audited | 350 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 21 (completed 17, nothing-to-do 4) |
| Runs by agent | claude-opus-5-5 21 |
| Files audited | 1502 |
| Files changed | 377 |
| Findings | 2404 (1.6 per audited file) |
| By lens | cannot-fail 878, nondeterminism 714, hygiene 349, cost 161, overlap 124, failure-issues 121, not-running 46, tier-and-doubles 11 |
| By action | none 1832, cleanup 223, strengthen 147, deflake 90, file-issue 42, remove 28, rewrite 20, speed-up 14, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 1832, fixed 455, deferred 88, filed 29 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 138 |
| Mutations killed | 176 |
| Tests made deterministic | 63 |
| Seconds saved per run of the changed files | 73.6 |
| Test declarations in changed files | 4078 before, 4078 after (1 removed, each declared with its obligation map) |
| Executed cases in changed files | 4672 before, 4662 after |
| Executed assertions in changed files | 49024 before, 49208 after |
| Re-audits that found what an earlier audit missed | 1 of 17 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 5 |
| Batches open | 24 (301 changed files waiting) |
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
| Open failure issues | 69 to 93 |
| Sleep-shaped call sites | 888 to 886 |
| Weak matchers | 1295 to 1292 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

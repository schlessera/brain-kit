# Test health

Generated 2026-11-10T21:31:53.816Z at `26213d5c7c4e`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1621 (88.3%) |
| Changed since their audit | 1 |
| Never audited | 213 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 36 (completed 30, nothing-to-do 6) |
| Runs by agent | claude-opus-5-5 36 |
| Files audited | 1639 |
| Files changed | 450 |
| Findings | 2752 (1.68 per audited file) |
| By lens | cannot-fail 997, nondeterminism 805, hygiene 404, cost 191, overlap 163, failure-issues 129, not-running 51, tier-and-doubles 12 |
| By action | none 2056, cleanup 278, strengthen 180, deflake 98, file-issue 47, remove 41, rewrite 23, speed-up 21, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 2056, fixed 557, deferred 105, filed 34 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 170 |
| Mutations killed | 224 |
| Tests made deterministic | 68 |
| Seconds saved per run of the changed files | 105.1 |
| Test declarations in changed files | 4870 before, 4873 after (2 removed, each declared with its obligation map) |
| Executed cases in changed files | 5601 before, 5594 after |
| Executed assertions in changed files | 55977 before, 56056 after |
| Re-audits that found what an earlier audit missed | 1 of 17 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 6 |
| Batches open | 31 (346 changed files waiting) |
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
| Open failure issues | 69 to 110 |
| Sleep-shaped call sites | 888 to 884 |
| Weak matchers | 1295 to 1292 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

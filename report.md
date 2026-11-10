# Test health

Generated 2026-11-10T21:38:02.291Z at `17239ffb2d18`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1629 (88.8%) |
| Changed since their audit | 0 |
| Never audited | 206 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 40 (completed 34, nothing-to-do 6) |
| Runs by agent | claude-opus-5-5 40 |
| Files audited | 1646 |
| Files changed | 453 |
| Findings | 2759 (1.68 per audited file) |
| By lens | cannot-fail 1001, nondeterminism 806, hygiene 405, cost 191, overlap 163, failure-issues 130, not-running 51, tier-and-doubles 12 |
| By action | none 2060, cleanup 279, strengthen 181, deflake 99, file-issue 47, remove 41, rewrite 23, speed-up 21, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 2060, fixed 560, deferred 105, filed 34 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 171 |
| Mutations killed | 225 |
| Tests made deterministic | 69 |
| Seconds saved per run of the changed files | 105.1 |
| Test declarations in changed files | 4873 before, 4876 after (2 removed, each declared with its obligation map) |
| Executed cases in changed files | 5601 before, 5594 after |
| Executed assertions in changed files | 55977 before, 56056 after |
| Re-audits that found what an earlier audit missed | 1 of 17 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 6 |
| Batches open | 31 (349 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 20 |
| Mean changed files per landed batch | 16.5 |
| Mean hours from first commit to landing | 2.6 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 114 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1295 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

# Test health

Generated 2026-11-10T21:47:50.881Z at `f72bd084814b`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1636 (89.2%) |
| Changed since their audit | 1 |
| Never audited | 198 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 40 (completed 34, nothing-to-do 6) |
| Runs by agent | claude-opus-5-5 40 |
| Files audited | 1656 |
| Files changed | 462 |
| Findings | 2799 (1.69 per audited file) |
| By lens | cannot-fail 1015, nondeterminism 819, hygiene 413, cost 194, overlap 164, failure-issues 131, not-running 51, tier-and-doubles 12 |
| By action | none 2084, cleanup 287, strengthen 186, deflake 101, file-issue 48, remove 41, rewrite 23, speed-up 21, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 2084, fixed 575, deferred 105, filed 35 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 176 |
| Mutations killed | 232 |
| Tests made deterministic | 71 |
| Seconds saved per run of the changed files | 105.1 |
| Test declarations in changed files | 5000 before, 5003 after (2 removed, each declared with its obligation map) |
| Executed cases in changed files | 5749 before, 5742 after |
| Executed assertions in changed files | 57013 before, 57095 after |
| Re-audits that found what an earlier audit missed | 1 of 19 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 6 |
| Batches open | 31 (356 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 21 |
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

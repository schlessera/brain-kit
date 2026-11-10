# Test health

Generated 2026-11-10T21:15:57.363Z at `4b9f5d02790b`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1562 (85.1%) |
| Changed since their audit | 0 |
| Never audited | 273 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 28 (completed 24, nothing-to-do 4) |
| Runs by agent | claude-opus-5-5 28 |
| Files audited | 1579 |
| Files changed | 413 |
| Findings | 2588 (1.64 per audited file) |
| By lens | cannot-fail 943, nondeterminism 763, hygiene 379, cost 173, overlap 147, failure-issues 124, not-running 47, tier-and-doubles 12 |
| By action | none 1962, cleanup 252, strengthen 159, deflake 92, file-issue 46, remove 33, rewrite 22, speed-up 14, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 1962, fixed 504, deferred 89, filed 33 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 151 |
| Mutations killed | 197 |
| Tests made deterministic | 65 |
| Seconds saved per run of the changed files | 73.6 |
| Test declarations in changed files | 4442 before, 4442 after (1 removed, each declared with its obligation map) |
| Executed cases in changed files | 5152 before, 5142 after |
| Executed assertions in changed files | 52127 before, 52316 after |
| Re-audits that found what an earlier audit missed | 1 of 17 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 5 |
| Batches open | 28 (337 changed files waiting) |
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
| Open failure issues | 69 to 103 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1292 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

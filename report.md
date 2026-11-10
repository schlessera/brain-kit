# Test health

Generated 2026-11-10T22:01:44.062Z at `53778eb6d2bf`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1656 (90.2%) |
| Changed since their audit | 1 |
| Never audited | 178 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 42 (completed 36, nothing-to-do 6) |
| Runs by agent | claude-opus-5-5 42 |
| Files audited | 1676 |
| Files changed | 466 |
| Findings | 2833 (1.69 per audited file) |
| By lens | cannot-fail 1020, nondeterminism 827, hygiene 417, cost 199, overlap 171, failure-issues 136, not-running 51, tier-and-doubles 12 |
| By action | none 2106, cleanup 290, strengthen 186, deflake 105, file-issue 52, remove 42, rewrite 23, speed-up 21, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 2106, fixed 579, deferred 109, filed 39 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 176 |
| Mutations killed | 232 |
| Tests made deterministic | 72 |
| Seconds saved per run of the changed files | 105.1 |
| Test declarations in changed files | 5037 before, 5040 after (2 removed, each declared with its obligation map) |
| Executed cases in changed files | 5843 before, 5836 after |
| Executed assertions in changed files | 57785 before, 57867 after |
| Re-audits that found what an earlier audit missed | 1 of 19 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 6 |
| Batches open | 31 (360 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 22 |
| Mean changed files per landed batch | 16.5 |
| Mean hours from first commit to landing | 2.6 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 117 |
| Sleep-shaped call sites | 888 to 884 |
| Weak matchers | 1295 to 1292 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

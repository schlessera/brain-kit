# Test health

Generated 2026-11-10T18:59:01.770Z at `4612f55a1ebe`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 899 (49.0%) |
| Changed since their audit | 0 |
| Never audited | 936 |
| Median audit age in days | 0 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 11 (completed 10, nothing-to-do 1) |
| Runs by agent | claude-opus-5-5 11 |
| Files audited | 904 |
| Files changed | 214 |
| Findings | 1441 (1.59 per audited file) |
| By lens | cannot-fail 571, nondeterminism 399, hygiene 202, cost 99, failure-issues 70, overlap 64, not-running 30, tier-and-doubles 6 |
| By action | none 1126, cleanup 117, strengthen 91, deflake 49, file-issue 18, remove 15, rewrite 14, speed-up 9, move-tier 2 |
| By status | accepted 1126, fixed 257, deferred 45, filed 13 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 90 |
| Mutations killed | 105 |
| Tests made deterministic | 33 |
| Seconds saved per run of the changed files | 68.3 |
| Test declarations in changed files | 2446 before, 2446 after (0 removed, each declared with its obligation map) |
| Executed cases in changed files | 2869 before, 2869 after |
| Executed assertions in changed files | 16085 before, 16208 after |
| Re-audits that found what an earlier audit missed | 0 of 5 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 4 |
| Batches open | 17 (154 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 11 |
| Mean changed files per landed batch | 14.8 |
| Mean hours from first commit to landing | 1.7 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 81 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1295 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

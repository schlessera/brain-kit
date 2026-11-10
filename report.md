# Test health

Generated 2026-11-10T21:09:23.050Z at `5bda59a464d9`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1551 (84.5%) |
| Changed since their audit | 0 |
| Never audited | 284 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 25 (completed 21, nothing-to-do 4) |
| Runs by agent | claude-opus-5-5 25 |
| Files audited | 1568 |
| Files changed | 407 |
| Findings | 2559 (1.63 per audited file) |
| By lens | cannot-fail 935, nondeterminism 751, hygiene 375, cost 172, overlap 145, failure-issues 123, not-running 46, tier-and-doubles 12 |
| By action | none 1943, cleanup 248, strengthen 156, deflake 90, file-issue 45, remove 33, rewrite 22, speed-up 14, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 1943, fixed 495, deferred 89, filed 32 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 148 |
| Mutations killed | 194 |
| Tests made deterministic | 63 |
| Seconds saved per run of the changed files | 73.6 |
| Test declarations in changed files | 4380 before, 4380 after (1 removed, each declared with its obligation map) |
| Executed cases in changed files | 5063 before, 5053 after |
| Executed assertions in changed files | 51822 before, 52011 after |
| Re-audits that found what an earlier audit missed | 1 of 17 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 5 |
| Batches open | 27 (331 changed files waiting) |
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
| Open failure issues | 69 to 100 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1289 |
| Conditionally skipped tests | 139 to 137 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

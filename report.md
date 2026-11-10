# Test health

Generated 2026-11-10T18:05:01.984Z at `8baf700769da`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 438 (23.9%) |
| Changed since their audit | 0 |
| Never audited | 1397 |
| Median audit age in days | 0 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 6 (completed 5, nothing-to-do 1) |
| Runs by agent | claude-opus-5-5 6 |
| Files audited | 438 |
| Files changed | 127 |
| Findings | 777 (1.77 per audited file) |
| By lens | cannot-fail 343, nondeterminism 180, hygiene 100, cost 65, failure-issues 43, overlap 24, not-running 20, tier-and-doubles 2 |
| By action | none 582, cleanup 68, strengthen 67, deflake 27, file-issue 12, rewrite 11, speed-up 7, remove 2, move-tier 1 |
| By status | accepted 582, fixed 160, deferred 25, filed 10 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 66 |
| Mutations killed | 72 |
| Tests made deterministic | 18 |
| Seconds saved per run of the changed files | 42.8 |
| Test declarations in changed files | 1583 before, 1583 after (0 removed, each declared with its obligation map) |
| Executed cases in changed files | 1961 before, 1961 after |
| Executed assertions in changed files | 11336 before, 11471 after |
| Re-audits that found what an earlier audit missed | n/a |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 1 |
| Batches open | 14 (126 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 6 |
| Mean changed files per landed batch | 1 |
| Mean hours from first commit to landing | 1.7 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 74 |
| Sleep-shaped call sites | 888 to 888 |
| Weak matchers | 1295 to 1292 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

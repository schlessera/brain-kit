# Test health

Generated 2026-11-10T21:21:44.003Z at `514a9c9c6c27`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1576 (85.9%) |
| Changed since their audit | 0 |
| Never audited | 259 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 30 (completed 25, nothing-to-do 5) |
| Runs by agent | claude-opus-5-5 30 |
| Files audited | 1593 |
| Files changed | 416 |
| Findings | 2605 (1.64 per audited file) |
| By lens | cannot-fail 951, nondeterminism 765, hygiene 382, cost 175, overlap 149, failure-issues 124, not-running 47, tier-and-doubles 12 |
| By action | none 1973, cleanup 254, strengthen 161, deflake 92, file-issue 46, remove 35, rewrite 22, speed-up 14, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 1973, fixed 507, deferred 92, filed 33 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 152 |
| Mutations killed | 199 |
| Tests made deterministic | 65 |
| Seconds saved per run of the changed files | 73.6 |
| Test declarations in changed files | 4462 before, 4462 after (1 removed, each declared with its obligation map) |
| Executed cases in changed files | 5197 before, 5187 after |
| Executed assertions in changed files | 52257 before, 52448 after |
| Re-audits that found what an earlier audit missed | 1 of 17 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 5 |
| Batches open | 30 (340 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 19 |
| Mean changed files per landed batch | 14.2 |
| Mean hours from first commit to landing | 2.2 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 105 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1292 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

# Test health

Generated 2026-11-11T13:21:10.216Z at `0129244ad078`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1713 (93.4%) |
| Changed since their audit | 0 |
| Never audited | 122 |
| Median audit age in days | 0.8 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 43 (completed 37, nothing-to-do 6) |
| Runs by agent | claude-opus-5-5 43 |
| Files audited | 1732 |
| Files changed | 493 |
| Findings | 2999 (1.73 per audited file) |
| By lens | cannot-fail 1091, nondeterminism 868, hygiene 445, cost 217, overlap 175, failure-issues 135, not-running 53, tier-and-doubles 15 |
| By action | none 2216, cleanup 310, strengthen 214, deflake 110, file-issue 53, remove 43, rewrite 24, speed-up 20, move-tier 4, unskip 2, split 2, merge 1 |
| By status | accepted 2216, fixed 635, deferred 108, filed 40 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 203 |
| Mutations killed | 268 |
| Tests made deterministic | 77 |
| Seconds saved per run of the changed files | 106.5 |
| Test declarations in changed files | 5362 before, 5365 after (4 removed, each declared with its obligation map) |
| Executed cases in changed files | 6243 before, 6236 after |
| Executed assertions in changed files | 60226 before, 60327 after |
| Re-audits that found what an earlier audit missed | 1 of 19 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 36 |
| Batches open | 1 (1 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 23 |
| Mean changed files per landed batch | 13.5 |
| Mean hours from first commit to landing | 11.2 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 119 |
| Sleep-shaped call sites | 888 to 882 |
| Weak matchers | 1295 to 1270 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

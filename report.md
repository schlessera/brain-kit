# Test health

Generated 2026-11-11T00:00:09.292Z at `2586f4af3c1c`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1714 (93.4%) |
| Changed since their audit | 5 |
| Never audited | 116 |
| Median audit age in days | 0.2 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 43 (completed 37, nothing-to-do 6) |
| Runs by agent | claude-opus-5-5 43 |
| Files audited | 1738 |
| Files changed | 498 |
| Findings | 3021 (1.74 per audited file) |
| By lens | cannot-fail 1096, nondeterminism 875, hygiene 447, cost 219, overlap 180, failure-issues 136, not-running 53, tier-and-doubles 15 |
| By action | none 2228, cleanup 314, strengthen 216, deflake 110, file-issue 53, remove 45, rewrite 24, speed-up 22, move-tier 4, unskip 2, split 2, merge 1 |
| By status | accepted 2228, fixed 641, deferred 112, filed 40 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 205 |
| Mutations killed | 270 |
| Tests made deterministic | 77 |
| Seconds saved per run of the changed files | 106.5 |
| Test declarations in changed files | 5402 before, 5405 after (4 removed, each declared with its obligation map) |
| Executed cases in changed files | 6243 before, 6236 after |
| Executed assertions in changed files | 60226 before, 60327 after |
| Re-audits that found what an earlier audit missed | 1 of 19 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 7 |
| Batches open | 30 (358 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 23 |
| Mean changed files per landed batch | 19 |
| Mean hours from first commit to landing | 3 |

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

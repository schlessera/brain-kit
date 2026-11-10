# Test health

Generated 2026-11-10T20:12:22.116Z at `cb7c2300f7ba`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1368 (74.6%) |
| Changed since their audit | 0 |
| Never audited | 467 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 16 (completed 14, nothing-to-do 2) |
| Runs by agent | claude-opus-5-5 16 |
| Files audited | 1375 |
| Files changed | 325 |
| Findings | 2158 (1.57 per audited file) |
| By lens | cannot-fail 801, nondeterminism 647, hygiene 306, cost 141, failure-issues 106, overlap 102, not-running 44, tier-and-doubles 11 |
| By action | none 1672, cleanup 184, strengthen 124, deflake 79, file-issue 40, remove 23, rewrite 18, speed-up 11, move-tier 3, unskip 2, split 2 |
| By status | accepted 1672, fixed 383, deferred 74, filed 29 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 117 |
| Mutations killed | 146 |
| Tests made deterministic | 56 |
| Seconds saved per run of the changed files | 73.6 |
| Test declarations in changed files | 3629 before, 3630 after (0 removed, each declared with its obligation map) |
| Executed cases in changed files | 4227 before, 4230 after |
| Executed assertions in changed files | 30269 before, 30433 after |
| Re-audits that found what an earlier audit missed | 1 of 7 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 4 |
| Batches open | 20 (265 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 15 |
| Mean changed files per landed batch | 14.8 |
| Mean hours from first commit to landing | 1.7 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 91 |
| Sleep-shaped call sites | 888 to 886 |
| Weak matchers | 1295 to 1295 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

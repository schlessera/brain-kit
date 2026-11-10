# Test health

Generated 2026-11-10T21:54:39.067Z at `1f243febf6a2`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1651 (90.0%) |
| Changed since their audit | 1 |
| Never audited | 183 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 41 (completed 35, nothing-to-do 6) |
| Runs by agent | claude-opus-5-5 41 |
| Files audited | 1671 |
| Files changed | 463 |
| Findings | 2821 (1.69 per audited file) |
| By lens | cannot-fail 1019, nondeterminism 824, hygiene 415, cost 197, overlap 170, failure-issues 133, not-running 51, tier-and-doubles 12 |
| By action | none 2101, cleanup 288, strengthen 186, deflake 101, file-issue 51, remove 42, rewrite 23, speed-up 21, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 2101, fixed 576, deferred 106, filed 38 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 176 |
| Mutations killed | 232 |
| Tests made deterministic | 71 |
| Seconds saved per run of the changed files | 105.1 |
| Test declarations in changed files | 5017 before, 5020 after (2 removed, each declared with its obligation map) |
| Executed cases in changed files | 5749 before, 5742 after |
| Executed assertions in changed files | 57013 before, 57095 after |
| Re-audits that found what an earlier audit missed | 1 of 19 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 6 |
| Batches open | 31 (357 changed files waiting) |
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
| Open failure issues | 69 to 116 |
| Sleep-shaped call sites | 888 to 884 |
| Weak matchers | 1295 to 1292 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

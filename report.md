# Test health

Generated 2026-11-10T20:57:28.843Z at `a9458c92f6e0`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1505 (82.0%) |
| Changed since their audit | 0 |
| Never audited | 330 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 22 (completed 18, nothing-to-do 4) |
| Runs by agent | claude-opus-5-5 22 |
| Files audited | 1522 |
| Files changed | 385 |
| Findings | 2448 (1.61 per audited file) |
| By lens | cannot-fail 894, nondeterminism 723, hygiene 356, cost 161, overlap 135, failure-issues 122, not-running 46, tier-and-doubles 11 |
| By action | none 1864, cleanup 229, strengthen 150, deflake 90, file-issue 42, remove 31, rewrite 20, speed-up 14, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 1864, fixed 467, deferred 88, filed 29 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 141 |
| Mutations killed | 182 |
| Tests made deterministic | 63 |
| Seconds saved per run of the changed files | 73.6 |
| Test declarations in changed files | 4130 before, 4130 after (1 removed, each declared with its obligation map) |
| Executed cases in changed files | 4713 before, 4703 after |
| Executed assertions in changed files | 49212 before, 49398 after |
| Re-audits that found what an earlier audit missed | 1 of 17 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 5 |
| Batches open | 24 (309 changed files waiting) |
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
| Open failure issues | 69 to 94 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1291 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

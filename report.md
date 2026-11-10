# Test health

Generated 2026-11-10T21:23:43.994Z at `d425b3927938`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1578 (86.0%) |
| Changed since their audit | 0 |
| Never audited | 257 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 31 (completed 26, nothing-to-do 5) |
| Runs by agent | claude-opus-5-5 31 |
| Files audited | 1595 |
| Files changed | 418 |
| Findings | 2610 (1.64 per audited file) |
| By lens | cannot-fail 953, nondeterminism 765, hygiene 384, cost 175, overlap 150, failure-issues 124, not-running 47, tier-and-doubles 12 |
| By action | none 1975, cleanup 256, strengthen 162, deflake 92, file-issue 46, remove 35, rewrite 22, speed-up 14, move-tier 3, unskip 2, split 2, merge 1 |
| By status | accepted 1975, fixed 510, deferred 92, filed 33 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 153 |
| Mutations killed | 200 |
| Tests made deterministic | 65 |
| Seconds saved per run of the changed files | 73.6 |
| Test declarations in changed files | 4494 before, 4494 after (1 removed, each declared with its obligation map) |
| Executed cases in changed files | 5229 before, 5219 after |
| Executed assertions in changed files | 52532 before, 52722 after |
| Re-audits that found what an earlier audit missed | 1 of 17 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 5 |
| Batches open | 31 (342 changed files waiting) |
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
| Open failure issues | 69 to 106 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1292 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

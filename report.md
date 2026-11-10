# Test health

Generated 2026-11-10T18:51:41.644Z at `4939151e4a53`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 842 (45.9%) |
| Changed since their audit | 0 |
| Never audited | 993 |
| Median audit age in days | 0 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 10 (completed 9, nothing-to-do 1) |
| Runs by agent | claude-opus-5-5 10 |
| Files audited | 847 |
| Files changed | 200 |
| Findings | 1354 (1.6 per audited file) |
| By lens | cannot-fail 547, nondeterminism 368, hygiene 187, cost 95, failure-issues 67, overlap 57, not-running 28, tier-and-doubles 5 |
| By action | none 1060, cleanup 108, strengthen 89, deflake 45, file-issue 17, rewrite 13, remove 11, speed-up 9, move-tier 2 |
| By status | accepted 1060, fixed 241, deferred 41, filed 12 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 88 |
| Mutations killed | 100 |
| Tests made deterministic | 31 |
| Seconds saved per run of the changed files | 68.3 |
| Test declarations in changed files | 2331 before, 2331 after (0 removed, each declared with its obligation map) |
| Executed cases in changed files | 2758 before, 2758 after |
| Executed assertions in changed files | 15603 before, 15728 after |
| Re-audits that found what an earlier audit missed | 0 of 5 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 4 |
| Batches open | 16 (140 changed files waiting) |
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
| Open failure issues | 69 to 80 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1296 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

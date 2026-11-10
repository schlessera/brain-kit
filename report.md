# Test health

Generated 2026-11-10T18:45:30.883Z at `2bf149441771`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 814 (44.4%) |
| Changed since their audit | 0 |
| Never audited | 1021 |
| Median audit age in days | 0 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 9 (completed 8, nothing-to-do 1) |
| Runs by agent | claude-opus-5-5 9 |
| Files audited | 814 |
| Files changed | 181 |
| Findings | 1248 (1.53 per audited file) |
| By lens | cannot-fail 508, nondeterminism 317, hygiene 179, cost 95, failure-issues 64, overlap 52, not-running 28, tier-and-doubles 5 |
| By action | none 977, cleanup 102, strengthen 77, deflake 41, file-issue 17, rewrite 13, remove 10, speed-up 9, move-tier 2 |
| By status | accepted 977, fixed 220, deferred 39, filed 12 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 77 |
| Mutations killed | 88 |
| Tests made deterministic | 29 |
| Seconds saved per run of the changed files | 68.3 |
| Test declarations in changed files | 2126 before, 2126 after (0 removed, each declared with its obligation map) |
| Executed cases in changed files | 2499 before, 2499 after |
| Executed assertions in changed files | 14548 before, 14672 after |
| Re-audits that found what an earlier audit missed | n/a |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 4 |
| Batches open | 15 (122 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 10 |
| Mean changed files per landed batch | 14.8 |
| Mean hours from first commit to landing | 1.7 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 78 |
| Sleep-shaped call sites | 888 to 888 |
| Weak matchers | 1295 to 1295 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

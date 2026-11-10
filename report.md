# Test health

Generated 2026-11-10T18:19:03.172Z at `f0e68550a036`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 595 (32.4%) |
| Changed since their audit | 0 |
| Never audited | 1240 |
| Median audit age in days | 0 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 7 (completed 6, nothing-to-do 1) |
| Runs by agent | claude-opus-5-5 7 |
| Files audited | 595 |
| Files changed | 141 |
| Findings | 980 (1.65 per audited file) |
| By lens | cannot-fail 431, nondeterminism 234, hygiene 128, cost 78, failure-issues 47, overlap 36, not-running 23, tier-and-doubles 3 |
| By action | none 762, cleanup 77, strengthen 73, deflake 28, file-issue 14, rewrite 12, speed-up 7, remove 5, move-tier 2 |
| By status | accepted 762, fixed 176, deferred 31, filed 11 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 73 |
| Mutations killed | 80 |
| Tests made deterministic | 19 |
| Seconds saved per run of the changed files | 42.8 |
| Test declarations in changed files | 1657 before, 1657 after (0 removed, each declared with its obligation map) |
| Executed cases in changed files | 2030 before, 2030 after |
| Executed assertions in changed files | 11758 before, 11892 after |
| Re-audits that found what an earlier audit missed | n/a |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 3 |
| Batches open | 14 (88 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 8 |
| Mean changed files per landed batch | 17.7 |
| Mean hours from first commit to landing | 1.6 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 75 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1295 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

# Test health

Generated 2026-11-10T18:23:53.090Z at `206750d48b65`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 645 (35.1%) |
| Changed since their audit | 0 |
| Never audited | 1190 |
| Median audit age in days | 0 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 8 (completed 7, nothing-to-do 1) |
| Runs by agent | claude-opus-5-5 8 |
| Files audited | 645 |
| Files changed | 146 |
| Findings | 1049 (1.63 per audited file) |
| By lens | cannot-fail 454, nondeterminism 260, hygiene 137, cost 85, failure-issues 50, overlap 37, not-running 23, tier-and-doubles 3 |
| By action | none 826, cleanup 78, strengthen 75, deflake 30, file-issue 14, rewrite 12, speed-up 7, remove 5, move-tier 2 |
| By status | accepted 826, fixed 181, deferred 31, filed 11 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 75 |
| Mutations killed | 82 |
| Tests made deterministic | 21 |
| Seconds saved per run of the changed files | 42.8 |
| Test declarations in changed files | 1734 before, 1734 after (0 removed, each declared with its obligation map) |
| Executed cases in changed files | 2121 before, 2121 after |
| Executed assertions in changed files | 12355 before, 12490 after |
| Re-audits that found what an earlier audit missed | n/a |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 3 |
| Batches open | 15 (93 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 9 |
| Mean changed files per landed batch | 17.7 |
| Mean hours from first commit to landing | 1.6 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 76 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1296 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

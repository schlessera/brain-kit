# Test health

Generated 2026-11-10T19:51:58.354Z at `32d8a9f13b7d`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 1280 (69.8%) |
| Changed since their audit | 0 |
| Never audited | 555 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 12 (completed 11, nothing-to-do 1) |
| Runs by agent | claude-opus-5-5 12 |
| Files audited | 1287 |
| Files changed | 298 |
| Findings | 2038 (1.58 per audited file) |
| By lens | cannot-fail 760, nondeterminism 609, hygiene 290, cost 131, failure-issues 104, overlap 97, not-running 37, tier-and-doubles 10 |
| By action | none 1585, cleanup 170, strengthen 117, deflake 72, file-issue 38, remove 22, rewrite 18, speed-up 11, move-tier 2, split 2, unskip 1 |
| By status | accepted 1585, fixed 354, deferred 72, filed 27 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 110 |
| Mutations killed | 137 |
| Tests made deterministic | 50 |
| Seconds saved per run of the changed files | 73.6 |
| Test declarations in changed files | 3355 before, 3356 after (0 removed, each declared with its obligation map) |
| Executed cases in changed files | 3929 before, 3932 after |
| Executed assertions in changed files | 27733 before, 27895 after |
| Re-audits that found what an earlier audit missed | 1 of 7 |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 4 |
| Batches open | 18 (238 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 13 |
| Mean changed files per landed batch | 14.8 |
| Mean hours from first commit to landing | 1.7 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 86 |
| Sleep-shaped call sites | 888 to 887 |
| Weak matchers | 1295 to 1295 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

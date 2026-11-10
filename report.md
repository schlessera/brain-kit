# Test health

Generated 2026-11-10T14:43:23.306Z at `30359911aa33`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 13 (0.7%) |
| Changed since their audit | 0 |
| Never audited | 1822 |
| Median audit age in days | 0.1 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 2 (completed 2) |
| Runs by agent | claude-opus-5-5 2 |
| Files audited | 13 |
| Files changed | 2 |
| Findings | 21 (1.62 per audited file) |
| By lens | cannot-fail 9, nondeterminism 7, failure-issues 3, overlap 1, not-running 1 |
| By action | none 15, deflake 4, remove 1, strengthen 1 |
| By status | accepted 15, deferred 4, fixed 2 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 1 |
| Mutations killed | 2 |
| Tests made deterministic | 1 |
| Seconds saved per run of the changed files | 0 |
| Test declarations in changed files | 17 before, 17 after (0 removed, each declared with its obligation map) |
| Executed cases in changed files | 12 before, 12 after |
| Executed assertions in changed files | 167 before, 167 after |
| Re-audits that found what an earlier audit missed | n/a |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 1 |
| Batches open | 1 (1 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 3 |
| Mean changed files per landed batch | 1 |
| Mean hours from first commit to landing | 1.7 |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 to 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 to 0.639 |
| Open failure issues | 69 to 69 |
| Sleep-shaped call sites | 888 to 888 |
| Weak matchers | 1295 to 1295 |
| Conditionally skipped tests | 139 to 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

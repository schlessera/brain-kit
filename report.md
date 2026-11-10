# Test health

Generated 2026-11-10T12:39:43.017Z at `fff3cfbe6853`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 3 (0.2%) |
| Changed since their audit | 0 |
| Never audited | 1832 |
| Median audit age in days | 0 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 1 (completed 1) |
| Runs by agent | claude-opus-5-5 1 |
| Files audited | 3 |
| Files changed | 1 |
| Findings | 11 (3.67 per audited file) |
| By lens | cannot-fail 4, failure-issues 3, nondeterminism 3, overlap 1 |
| By action | none 6, deflake 3, remove 1, strengthen 1 |
| By status | accepted 6, deferred 4, fixed 1 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 1 |
| Mutations killed | 1 |
| Tests made deterministic | 0 |
| Seconds saved per run of the changed files | 0 |
| Test declarations in changed files | 5 before, 5 after (0 removed, each declared with its obligation map) |
| Executed cases in changed files | 0 before, 0 after |
| Executed assertions in changed files | 0 before, 0 after |
| Re-audits that found what an earlier audit missed | n/a |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 0 |
| Batches open | 1 (1 changed files waiting) |
| Batches abandoned | 0 |
| Commits dropped from a batch | 0 |
| Landing attempts | 0 |
| Mean changed files per landed batch | n/a |
| Mean hours from first commit to landing | n/a |

## Suite trend

| Measure | Value |
| --- | --- |
| Measured cost of one full pass, in seconds | 10388.2 |
| Share of that cost in the 50 slowest files | 0.639 |
| Open failure issues | 69 |
| Sleep-shaped call sites | 888 |
| Weak matchers | 1295 |
| Conditionally skipped tests | 139 |

Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.

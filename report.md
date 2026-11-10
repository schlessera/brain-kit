# Test health

Generated 2026-11-10T18:25:01.199Z at `206750d48b65`.

## Coverage of the rotation

| Measure | Value |
| --- | --- |
| Test files | 1835 |
| Audited at their current content | 653 (35.6%) |
| Changed since their audit | 0 |
| Never audited | 1182 |
| Median audit age in days | 0 |

## What the audits found

| Measure | Value |
| --- | --- |
| Runs | 8 (completed 7, nothing-to-do 1) |
| Runs by agent | claude-opus-5-5 8 |
| Files audited | 653 |
| Files changed | 148 |
| Findings | 1059 (1.62 per audited file) |
| By lens | cannot-fail 456, nondeterminism 265, hygiene 139, cost 86, failure-issues 50, overlap 37, not-running 23, tier-and-doubles 3 |
| By action | none 834, cleanup 80, strengthen 75, deflake 30, file-issue 14, rewrite 12, speed-up 7, remove 5, move-tier 2 |
| By status | accepted 834, fixed 183, deferred 31, filed 11 |

## Proof and efficacy

| Measure | Value |
| --- | --- |
| Tests fixed that could not fail | 75 |
| Mutations killed | 82 |
| Tests made deterministic | 21 |
| Seconds saved per run of the changed files | 42.8 |
| Test declarations in changed files | 1766 before, 1766 after (0 removed, each declared with its obligation map) |
| Executed cases in changed files | 2173 before, 2173 after |
| Executed assertions in changed files | 12649 before, 12784 after |
| Re-audits that found what an earlier audit missed | n/a |

## Landing

| Measure | Value |
| --- | --- |
| Batches landed | 3 |
| Batches open | 15 (95 changed files waiting) |
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

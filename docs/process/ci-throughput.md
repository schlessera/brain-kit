# Reliable parallel integration throughput

The objective is more first-pass green integrations per day while preserving
proof obligations and monitoring recovery and reported incidents. This is a
pipeline proxy for reliable delivery, not a guarantee of defect-free behavior.
PR counts can reward smaller slices; compare size, workload, runner and policy
cohorts before attributing an improvement to parallelism.

## Collect the operational evidence

The [timing collector](ci-timings.md) joins job/step durations to PR lifecycle,
readiness events, change size and immutable squash objects. Enrich an existing
archive without rediscovering every workflow run:

```sh
bun scripts/ci-timings.ts enrich --resources --reservations \
  --since 2026-07-05T00:00:00Z --until 2026-07-12T00:00:00Z \
  --out tmp/ci-timings
bun scripts/ci-timings.ts report --out tmp/ci-timings
```

`--resources` also reads the latest green final-head aggregate's candidate
receipt. Live collection reads planner cadence context; old archives cannot
always distinguish feedback from confirmation. Missing context/receipts remain
unknown. `--reservations --since ...` reads the public coordination Git ref and
its append-only history without changing it. Actor IDs and revocation prose
are omitted. Protocol expiry establishes authorized lease time, not actual
worker activity or caller waiting.

Daily collection includes PR lifecycle and reservation history. Explicit
`--since`/`--until` choose the half-open throughput analysis interval. Without
them, collection manifests supply a bounding interval whose gaps need review.
An interval is not a claim of complete acquisition. `enrichment.json` records
requested PR IDs and errors; missing lifecycle records can undercount deliveries.
New invocations preserve manifests under `collections/<id>/`, so later single-run
acquisition cannot erase earlier windows. Report recursively merges archived
PR/event files, preferring newer PR observations and refusing conflicting event
IDs. Raw GitHub titles, authors, comments and runner host names are not retained.

## What the report measures

The delivery cohort is enriched PRs merged into main within the analysis
interval. CI cost includes available attempts for those PRs, including earlier
execution. It is not complete lifetime cost without complete lifetime coverage.

| Measure | Definition and boundary |
| --- | --- |
| First-pass green integrations/day | PRs whose first observed automatic main-push attempt succeeded with its integrated aggregate / interval days. |
| First-pass green percentage | First-main green PRs / PRs with a known first-main outcome. Unknown outcomes are separate; numerator and denominator accompany every percentage. |
| Runner-minutes/observed-green integration | All observed cohort pre/post CI job time, including failed deliveries / cohort PRs with observed same-commit green main proof. Not billed minutes or complete agent cost. |
| Create → merge | PR lifecycle latency, combining work, waiting and rework. |
| Recorded ready → merge | Last ready transition → merge if no subsequent draft transition intervened. Incomplete timelines remain unknown. |
| Final-head green aggregate → merge | Last observed green aggregate at the merged PR head → merge. This does not independently validate checkout or live base. |
| Merge → same-commit green | Time to observed green main proof on that exact squash. Recovery via a later repair commit needs an explicit related record. |
| Pre-green/main-nongreen | A green aggregate at the final head followed by non-green first main proof. Discordance, not a diagnosed escaped defect. |
| Same-source recovery | Failed/cancelled first main attempt followed by green at the same SHA. Not, by itself, a diagnosed flaky test. |
| Dependency → job start | Metadata completion → selected job start, including dispatch/queue delay. Does not isolate capacity pressure. |
| CI concurrency | Time-weighted executed-job overlap, peak and means while active/across the interval. Adjacent end-exclusive intervals do not invent overlap. |
| PR verification concurrency | Distinct PRs with verification intervals, merging overlapping attempts of one PR. Includes queueing; not active agent count. |
| Reservation occupancy | Authorized lease intervals, including inferred expiry. Time without observed candidate jobs includes queue/admission/verification and missing observations; not proven waste. |

Means, medians, p90 and sample counts accompany durations. First-main failing
job categories and supplied failure classifications help distinguish pipeline
failures. Workflow failures include intentional feedback refusals and stale
candidates as well as actual defects. Mixed policy epochs, sizes, dependency
graphs and runners confound comparisons; the report includes changed-line
cohorts but does not establish causality.

## Record coordination and incidents

GitHub cannot establish active agent count, task work, reservation caller wait,
conflict effort or product incidents. Orchestrators/operators can record their
actual boundaries with opaque worker/task IDs:

```json
{"kind":"work-started","worker":"worker-1","task":"ithaca-42","pr":42}
```

```sh
bun scripts/ci-timings.ts record --event tmp/work-event.json --out tmp/ci-timings
```

The command supplies version, UUID, current timestamp and repository. Explicit
ID/time permit attributed historical observations. IDs cannot be overwritten
with different content. Pairs are `work-started`/`work-finished` and
`wait-started`/`wait-finished`; waits require `reason` set to `reservation`,
`ci`, `review`, `conflict` or `other`. Each pair shares worker/task/reason.
Unmatched records remain unknown; overlapping tasks on one worker do not create
two workers. Complete task intervals measure task lifetime, not CPU busy time
or token cost. No records means unknown worker concurrency. This endpoint does
not automatically instrument local agents: orchestrators must call it and
preserve every worker's archive, including unsuccessful/unmerged work.

`failure-classified` requires run, attempt, classification (`product`, `test`,
`infrastructure`, `stale-candidate`, `intentional-feedback`) and public repository
evidence. `incident`/`revert` require affected `pr` and evidence; `relatedPR` can
name a repair/revert. These are supplied annotations, not independently verified
diagnoses. No incident surveillance means unknown overall incident rate.
Arbitrary fields such as prompts, names, hosts and prose are refused. Keep event
files with normalized snapshots under ignored `tmp/`, not in the public tree.

## Scenario estimates and formal proof

Use `report --scenario <JSON-file>`. The default assumptions are:

```json
{"failedPRFraction":0.3,"additionalPushes":2,"failedRunCostFraction":1}
```

Expected full-run equivalents are `2 + fraction × additionalPushes × cost`.
Two successful runs cover final-candidate and main proof; failures add assumed
failed attempts. A fraction below one models early termination.
`failedRunElapsedFraction` independently scales elapsed cost, defaulting to the
compute fraction. Serial test-time estimates do not predict alternate queues or
agent delivery latency. Outputs preserve assumptions, paired cohort and full-run
sample count; one reference cannot establish wall-time or reliability savings.

Formal guarantees stay separate from empirical green rates. Receipt presence,
head/base/parent consistency and actual squash parent/tree comparisons are
reported observations. Unknown is not equivalent. Differences need contextual
review, including stack/queue strategy and historical policy. The collector does
not independently audit every selected checkout, retained input, required review
or branch rule. Existing proof gates remain authoritative; statistics authorize
neither deleting a test nor weakening a gate.

To evaluate an optimization, retain matched source/runtime/runner inputs, actual
agent-concurrency settings, work/queue/lease events, complete proof, main results
and follow-up incident records. Compare green deliveries/day, tail latency,
runner cost and recovery work together. A faster merge with unfinished main
verification does not meet this objective.

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
bun scripts/ci-timings.ts report --out tmp/ci-timings [--history origin/main]
```

`--resources` also reads the latest green final-head aggregate's candidate
receipt. Live collection reads planner cadence context; old archives cannot
always distinguish feedback from confirmation. Missing context/receipts remain
unknown. `--reservations --since ...` reads the public coordination Git ref and
its append-only history without changing it. Actor IDs and revocation prose
are omitted. Protocol expiry establishes authorized lease time, not actual
worker activity or caller waiting.

Hourly incremental collection includes PR lifecycle and reservation history,
within the [shared API budget](ci-timings.md#api-cost-and-expected-coverage-gaps). Explicit
`--since`/`--until` choose the half-open throughput analysis interval. Without
them, collection manifests supply a bounding interval whose gaps need review.
An interval is not a claim of complete acquisition. `enrichment.json` records
requested PR IDs and errors; missing lifecycle records can undercount deliveries.
New invocations preserve manifests under `collections/<id>/`, so later single-run
acquisition cannot erase earlier windows. Report recursively merges archived
PR/event files, preferring newer PR observations and refusing conflicting event
IDs. Downloaded acquisition manifests and reservation histories are read
recursively too. `lifecycleAcquisition` retains the original scopes and lists
unresolved errors and missing requested PRs. Failed PR discovery remains visible:
a later archive's window cannot establish the original missing cohort.
`reservationAcquisition` retains
source ref/head identities and each deduplicated lease's source commits.
Conflicting immutable lease identities or endings are refused. Raw GitHub
titles, authors, comments and runner host names are not retained.

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
| Create → same-commit green main | End-to-end pipeline delivery latency for the cohort with observed green proof, including any same-source recovery. This is not complete incident follow-up or a defect-free guarantee. |
| Recorded ready → merge | Last ready transition → merge if no subsequent draft transition intervened. Incomplete timelines remain unknown. |
| Final-head green aggregate → merge | Last observed green aggregate at the merged PR head → merge. This does not independently validate checkout or live base. |
| Merge → same-commit green | Time to observed green main proof on that exact squash. Recovery via a later repair commit needs an explicit related record. |
| Pre-green/main-nongreen | A green aggregate at the final head followed by non-green first main proof. Discordance, not a diagnosed escaped defect. |
| Same-source recovery | Failed/cancelled first main attempt followed by green at the same SHA. Not, by itself, a diagnosed flaky test. |
| Dependency → job start | Metadata completion → selected job start, including dispatch/queue delay. Does not isolate capacity pressure. |
| CI concurrency | Time-weighted executed-job overlap, peak and means while active/across the interval. Adjacent end-exclusive intervals do not invent overlap. |
| PR verification concurrency | Distinct PRs with verification intervals, merging overlapping attempts of one PR. Includes queueing; not active agent count. |
| Reservation occupancy | Authorized lease intervals, including inferred expiry. Time without observed candidate jobs includes queue/admission/verification and missing observations; not proven waste. |
| Merge path | Per merged PR: `recorded` when the reservation history holds an `integrate.ts` lease for the merged head, `expedited` when an `expedited-fix` event names the PR, `unrecorded` when neither (a merge that bypassed `integrate.ts`), `unknown` when no reservation history was collected (`--reservations`). |

Means, medians, p90 and sample counts accompany durations. First-main failing
job categories and supplied failure classifications help distinguish pipeline
failures. Workflow failures include intentional feedback refusals and stale
candidates as well as actual defects. Mixed policy epochs, sizes, dependency
graphs and runners confound comparisons; the report includes changed-line
cohorts and proof-policy epochs but does not establish causality.

## Proof-policy epochs

Each merged proof-system change opens a new proof-policy epoch
([ruling, answer 4](../decisions/ci-utility.md#proof-system-lane)). The report
reads the first-parent history of `--history <ref>` (default `origin/main`)
from the local checkout and classifies each squash against its first parent
with `scripts/proof-system.ts`, using the path set recorded at that parent.
History from before `scripts/proof-system-paths.json` existed uses the current
file. Every squash classified as a proof-system change starts an epoch,
identified by its SHA and commit time; the squash belongs to the epoch it
opens. A squash whose classification cannot be computed (a missing parent in a
shallow clone, a root commit, an unreadable diff) starts an epoch with an
`unknown` boundary, so a comparison never silently spans a policy change. The
hourly collector checks out full history for this reason.

| Field | Definition and boundary |
| --- | --- |
| `prs[].epoch` | The SHA of the nearest boundary at or before the delivery's squash in first-parent order. `unbounded` when no boundary lies within the lookback (2000 commits beyond the window's oldest commit); `null` when the squash is not in the history read, or no history was available. |
| `epochs.status` | `derived`, or `unavailable` with `error` when the ref cannot be read. Then every epoch is unknown and every delivery is listed in `unassigned`. `epochs` is `null` when no history source was supplied. |
| `epochs.boundaries[]` | `sha`, commit time `at`, and `kind`: `proof-system`, or `unknown` with the classification `error`. |
| `epochs.epochs[]` | Per epoch: its start boundary (`null` for `unbounded`), `end` (the next boundary's time, or the window end), `durationSeconds`, `merges` and `deliveries` in the cohort, and `firstMainGreen` among known first-main outcomes. |
| `epochs.current` | The epoch holding the newest squash before the window end: `days` since its boundary and `firstMainGreen`, the two numeric inputs of the #2934 Phase B gate, plus `incidentAttribution`. |
| `epochs.current.incidentAttribution` | Failed first-main attempts in the epoch and how many carry a `failure-classified` record. `unknown` when none do, `partial` when some do, `recorded` when all do. No record is unknown, not unattributed; incidents outside first-main runs are not observed. |

The report states these inputs; it does not decide whether the gate is met.
An `unknown` boundary on the current epoch means its days are counted from a
squash that may not have changed policy, so they are not evidence of a stable
epoch.

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
Host admission records each wait for a heavy local slot as a pair with reason
`other` and task `admission-<slot>` ([host admission](testing.md#host-admission-for-heavy-local-commands)).
Unmatched records remain unknown; overlapping tasks on one worker do not create
two workers. Complete task intervals measure task lifetime, not CPU busy time
or token cost. No records means unknown worker concurrency. This endpoint does
not automatically instrument local agents: orchestrators must call it and
preserve every worker's archive, including unsuccessful/unmerged work.

`failure-classified` requires run, attempt, classification (`product`, `test`,
`infrastructure`, `stale-candidate`, `intentional-feedback`) and public repository
evidence. `incident`/`revert` require affected `pr` and evidence; `relatedPR` can
name a repair/revert. `expedited-fix` requires the fix `pr`, the failing main
`run` and evidence (the head fix probe run); `integrate.ts --fixes-main-run`
records it after an expedited squash
([#2940](../decisions/ci-utility.md#expedited-red-main-fixes)). These are supplied annotations, not independently verified
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

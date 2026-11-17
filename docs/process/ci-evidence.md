# Integration evidence inventory

This is the measurement inventory for [#2948](https://github.com/schlessera/brain-kit/issues/2948),
including [#2934's October 25 table and Phase B gate](https://github.com/schlessera/brain-kit/issues/2934).
The [archive decision](../decisions/ci-evidence.md) binds storage, versioning,
privacy and delivery. This inventory implements no collector or gate.

`collected` means a normalized producer exists, not that every hour or cohort
is complete. `planned` names an implementation issue. `gap` names a missing
source and its closing issue. These are evidence-availability classifications,
not a task progress log. Missing, expired, partial and failed acquisitions are
unknown, never zero. A successful hourly workflow can contain partial data.

## Record kinds, schemas and retention

The following names identify normalized kinds, independent of individual file
IDs. Every versioned kind below has integer `version: 1`, except `run`, which
is v1 or v2 ([runner-slot wait](ci-throughput.md#runner-slot-wait)). The durable
layout is `YYYY-MM/<record-kind>.json` on `refs/heads/brain-ci-metrics`, with
per-record versions preserved. The daily writer and backfill
([#2955](https://github.com/schlessera/brain-kit/issues/2955)) are described in
the [durable archive guide](ci-timings.md#durable-archive). Unknown versions
are refused; future schemas append rather than rewrite history.

| Kind (file) | Schema source and identity | Acquisition cadence | Raw-source retention |
| --- | --- | --- | --- |
| `run` (`run-<id>-attempt-<n>.json`) v1 | `TimingSnapshot`, repository/run/attempt; job/step outcomes, timestamps, resource receipts when requested. | Hourly two-day creation window; explicit backfill/enrichment. | Actions runs/jobs/logs subject to repository retention, public cap 90 days; hourly artifacts request 90 days. |
| `pull` (`pull-<pr>.json`) v1 | `PullObservation`, repository/PR; lifecycle, size, final head and immutable squash tree/parents. | Hourly, changed lifecycle observations refreshed. | Live PR/timeline and Git objects have no collector expiry; cached artifacts request 90 days. |
| `reservations` (`reservations.json`) v1 | `ReservationArchive`, ref/head plus leases keyed by lease ID and immutable source commits. | Hourly `--reservations`, Git history. | Coordination ref history has no configured TTL; artifacts request 90 days. |
| `red-main` (`red-main.json`) v1 | `RedMainArchive`, ref/head, incident opening run and flake observations with source commits. This is the normalized archive, distinct from the live coordination record with the same filename. | Hourly `--red-main`, history back to green before the window. | Coordination ref history has no configured TTL; artifacts request 90 days. |
| `coordinator` (`coordinator-<run>-attempt-<n>.json`) v1 | `CoordinatorObservation`, repository/run/attempt, cancellation IDs or explicit unknown/problem. | Hourly only across red intervals; each archived attempt seeded forward. | Coordinator job logs share Actions retention (public cap 90 days); artifacts request 90 days. |
| `event` (`event-<id>.json`) v1 | `WorkEvent`, immutable opaque event ID, repository, timestamp and kind; work/wait pairs or evidence-linked classifications/incidents/reverts/expedited fixes. | Explicit local `record`; automatic host-admission wait pairs. Hosted publication planned in #2954. | Local ignored files have owner-controlled lifetime, no automatic hosted retention; published/compacted copies belong to #2954/#2955. |
| `collection` (`collection.json`, `collections/<id>/collection.json`) v1 | Collection ID, requested window, discovered attempts, errors, budget and seed observations. | Every collect invocation, including partial acquisition. | API responses transient; manifests in hourly artifacts request 90 days. |
| `enrichment` (`enrichment.json`) v1 | `LifecycleAcquisition`, repository, timestamp, expected PRs and acquisition errors. | Every lifecycle enrichment. | API responses transient; artifacts request 90 days. |
| `source` (archive only) v1 | `ArchiveSource`, repository/artifact; collector run, artifact creation time, SHA-256 digest, archived and refused record counts. | Daily archive compaction, one per retained artifact. | Written to the data ref; the artifact it names expires after 90 days. |
| `summary` (`summary.json`) v1 | `summarize` and report joins: derived timings, throughput, epochs, red-main and coverage sections. Markdown is a rendering, not another schema. | Local `report` and hourly collect; scheduled archive-based daily/weekly report planned in #2956. | Derived from retained inputs; artifacts request 90 days. |

Schema anchors: (`TimingSnapshot`, `scripts/ci-timings.ts:40-52`),
(`PullObservation`, `scripts/ci-throughput.ts:7-13`),
(`WorkEvent`, `scripts/ci-throughput.ts:14-20`),
(`ReservationArchive`, `scripts/ci-coordination.ts:7-10`),
(`RedMainArchive`, `scripts/ci-red-main.ts:45-51`),
(`CoordinatorObservation`, `scripts/ci-red-main.ts:52-56`),
(`ArchiveSource`, `scripts/ci-archive.ts:33-35`).
`summary` is derived on reporting and is not archived.
`analysis-window.json` and `scenario.json` are unversioned report inputs,
not observed metrics or independently versioned archive kinds.

In the tables below, R = `run` v1, P = `pull` v1, L = `reservations` v1,
E = `event` v1, M = `red-main` v1, C = `coordinator` v1, S = `summary` v1.
Each metric inherits its inputs' cadence and raw retention above; S is derived
on reporting. “No kind/version” explicitly means no normalized schema exists;
it does not reserve a fictional version for a future implementation.

## October 25 delivery cohort and operational report

The cohort is PRs merged into main in a half-open UTC interval. Runner cost
uses available pre/post attempts for those PRs, not complete lifetime or billed
cost. Durations report sample counts and median/p90; unknowns stay separate.

| Metric | Definition and source / producing file or task | Kind/version → report field | Status |
| --- | --- | --- | --- |
| Merged PRs | Count of enriched PRs merged within the interval; PR API/timeline, `ci-throughput.ts`. | P → S `coverage.mergedInWindow` | collected |
| Merges/day | Cohort count / interval days. | P → S `velocity.mergedPerDay` | collected |
| First-pass green integrations/day | First observed automatic main attempt green with integrated aggregate / days; exact squash join, `ci-throughput.ts`. | R + P → S `velocity.firstPassGreenPerDay` | collected |
| First-main green / known outcomes | Green / known first-main outcomes; failure, cancellation and unknown counts retained separately. | R + P → S `velocity.firstPassGreen`, `reliability.firstMainOutcomes` | collected |
| Same-squash observed-green integrations | Cohort squashes with observed green main proof, including later same-SHA recovery. | R + P → S `velocity.sameCommitObservedGreen` | collected |
| Observed runner-minutes / observed-green integration | Sum observed cohort job intervals, including failed/cancelled work / same-squash green deliveries. | R + P → S `velocity.runnerMinutesPerObservedGreenIntegration` | collected |
| PR creation → same-squash green main | Lifecycle creation to completion of observed green exact-squash proof. | R + P → S `velocity.createToGreenSeconds` | collected |
| Recorded ready → merge | Last ready transition without intervening draft → merge; incomplete timeline unknown. | P → S `velocity.readyToMergeSeconds` | collected |
| Distinct PR verification overlap | Time-weighted mean while active and peak distinct PR verification intervals; includes queue, not agents. | R → S `parallelism.distinctPRVerification` | collected |
| Authorized-reservation occupancy | Union of authorized lease intervals / window, capped by release/revoke/expiry. Not demand or caller wait. | L → S `reservation.occupiedWindow` | collected |
| Create → merge | PR creation to merge, including work/wait/rework. | P → S `velocity.createToMergeSeconds` | collected |
| Final-head green → merge | Final-head observed green aggregate completion to merge, without independent base validation. | R + P → S `velocity.gateToMergeSeconds` | collected |
| Merge → same-squash green | Merge to observed green main completion on the same SHA. | R + P → S `velocity.mergeToGreenSeconds` | collected |
| Pre-green/main-nongreen | Final-head aggregate green but first main non-green; discordance, not a defect diagnosis. | R + P → S `reliability.preGreenMainNonGreen` | collected |
| Same-source recovery | First main failed/cancelled, later green at same SHA; not itself flakiness. | R + P → S `reliability.sameSourceRecoveries` | collected |
| Job/step duration and runner consumption | Executed job intervals and named steps, event/category percentiles, attempt elapsed and first-attempt initial queue; `ci-timings.ts`. No executed steps means unobserved. | R → S timing sections | collected |
| Resource command cost | Optional structured log receipts: command phases, VM-wide CPU/memory and checkout identity; `--resources`. | R → S resource sections | collected on explicit enrichment; off hourly schedule |
| Dependency → job start | Metadata completion to selected job start; dispatch plus queue, not isolated runner pressure. | R → S `parallelism.dependencyToJobStartSeconds` | collected |
| CI concurrency | Time-weighted executed-job overlap across end-exclusive intervals. | R → S `parallelism.ciJobs` | collected |
| Reservation without observed candidate jobs | Lease occupied seconds minus overlapping candidate execution; not proven waste. | L + R → S `reservation.withoutObservedCandidateJobSeconds` | collected |
| Merge path | Lease-backed `recorded`, annotated `expedited`, `unrecorded`, or unknown without history. | L + E + P → S `reliability.mergePaths` | collected, annotations conditional |
| Size/policy/runner cohorts | Changed lines/files, workflow/event/runner labels and proof-policy boundaries; descriptive confounders. | P + R → S cohorts and epochs | collected |
| Receipt/squash equivalence | Recorded head/base/parent/tree against immutable squash; missing receipts unknown; not an independent complete proof audit. | R + P → S `evidence.squashComparedToRecordedReceipt` | collected on resource enrichment |
| Full-proof and scenario estimates | Successful exhaustive attempts as proxy; explicit failure/push/cost assumptions, never measured savings or causal capacity. | R + unversioned scenario input → S estimates | collected when qualifying samples exist |

## Reliability, contention and missing signals

| Metric | Definition and source / producing file or task | Kind/version → report field | Status |
| --- | --- | --- | --- |
| First-main failing categories | Failed primary job categories per first-main attempt; `ci-throughput.ts`. | R + P → S `reliability.firstMainFailedJobCategories` | collected |
| Failure families and attribution | Evidence-linked product/test/infrastructure/stale-candidate/intentional-feedback annotations, optionally job-specific; annotation presence is not complete causal attribution. | E + R → S `reliability.classificationRecords`; #2956 ranks families | collected locally; hosted publication planned #2954 |
| Red-main incidents | Opening run, first bad SHA/refinements, test/category/reasons, incident issue, declared/expedited fixes and clearance; #2942 producer, #2953 collector (`ci-red-main.ts`). | M → S `redMain.incidents` | collected hourly |
| Time to green | Record opened → cleared using server time; open incidents have unknown duration. | M → S `redMain.timeToGreenSeconds`, `openIncidents` | collected hourly |
| Suspected flakes, verdicts and reruns | Per-test suspicions, probe outcomes, linked issues and repeated-suspicion/probe-reproduced escalations; rerun attempts retained separately. | M + R → S `redMain.flakes`; ranked report #2956 | collected hourly |
| Cancelled/refused proof while red | Coordinator cancellation IDs and hosted gate refusal steps, observed consumed seconds and estimated saved seconds versus median successful PR attempt; missing snapshots/reference remain unknown. | C + M + R → S `redMain.cancellations`, `refusals`, `savingReference` | collected hourly |
| Merges during red | Reported non-fix squashes matched to exact PR identity; unresolved PR counted separately. | M + P → S `redMain.mergesDuringRed` | collected hourly |
| Explicit incidents/reverts/expedited fixes | Supplied public evidence with affected/repair PR; overall product incident rate remains unknown without surveillance. | E → S reliability records | collected locally; publication #2954, archive/report #2955/#2956 |
| Worker activity and work lifetime | Paired opaque worker/task work boundaries; overlapping tasks do not double count a worker. No instrumentation means unknown, not zero active agents. | E → S `parallelism.recordedWorkers`, `completedWorkIntervals` | collected only when orchestrator records; hosted publication planned #2954 |
| Caller wait and conflict effort | Paired waits by reservation/CI/review/conflict/other reason; elapsed wait is not CPU effort. | E → S `parallelism.waits` | collected locally when emitted; publication planned #2954 |
| Local host-slot admission wait | #2943 `host-admission.mjs` automatically emits wait pairs, reason `other`, task `admission-<slot>`. | E → S `parallelism.waits.other` | collected locally; publication planned #2954 |
| Preemption | #2943 host ledger `history.jsonl` records requested/completed preemption; not a pass/failure. Local owner-controlled retention; no hosted acquisition. | Unversioned ledger; no normalized kind/version | planned #2954 (including event-schema support; current E rejects `preempted`) |
| Runner-slot wait | Job created → started, per workflow/category/event with median/p90/max/count and >5-minute share; Actions jobs API. Current R lacks creation timestamp. | No implemented kind/version for wait; R schema extension belongs to #2952 | planned #2952; legacy jobs unknown |
| Collision snapshots | On-demand `collisions.ts` output: graph commit, candidate heads, textual/path/closure/unknown reports (#2941). Output has no retention unless caller saves it; no hourly acquisition. | `CollisionReport` unversioned; no archive kind/version | gap #4043 |
| Escape classes | #2937 historical public issue-comment audit: bypassed-confirmation, selection-miss, harness-change, confirmed-then-flaked, inherited-red, unknown. Issue comments have no configured collector expiry; failure classifications alone do not supply escape classes. | No normalized kind/version | gap #4043 |
| Reservation requests | Request → admission/refusal demand, including unsuccessful callers, beyond acquired leases. Live command outcomes are not an archived event stream; no raw retention guarantee. | No kind/version | gap #4044 |
| Reconfirmation reasons | Distinguish base advance, head change and other reproof causes; current leases/ready times cannot establish them. No retained structured source. | No kind/version | gap #4044 |
| Coverage gaps | Missing attempts, incomplete snapshots, lifecycle errors, budget/seed stops, failed reservation/red-main scopes and unknown coordinator logs; `ci-timings.ts` acquisition/report joins. | collection + enrichment v1, R/L/M/C → S coverage/acquisition | collected; missing hours/expired sources and archive-wide self-check planned #2956; collection recovery #3853 |

## Phase B gate and scheduled report

| Metric | Definition and source / producing file or task | Kind/version | Status |
| --- | --- | --- | --- |
| Seven consecutive days | One proof-policy epoch, opening at a classified proof-system squash; unknown/unbounded history cannot prove stability. `ci-epochs.ts` classifies first-parent Git history using the parent's path set (#3270). Git history has no configured TTL; derived on every report, hourly checkout fetches full history. | R + P + Git → S `throughput.epochs.current.days` | collected input; gate evaluation planned #2956 |
| At least 80% first-main green | Green / known first-main outcomes in that same epoch, carrying denominator, unknown outcomes and coverage limits. | R + P → S `throughput.epochs.current.firstMainGreen` | collected input; gate evaluation planned #2956 |
| Every red incident attributed | Requires evidence for every red incident in the epoch. Current `incidentAttribution` counts failed first-main attempts with any annotation; it cannot establish complete attribution of all failures or incidents. | E + R + P → S `throughput.epochs.current.incidentAttribution`; M supplies incident coverage | planned #2956 for complete gate assessment; current input collected with this limitation |
| Phase B gate state/change | All three requirements qualified together; no mixed epoch or incomplete attribution promoted to met. Measurement only, no rollout authorization. | No implemented gate kind/version; future report schema owned by #2956 | planned #2956 |
| Daily digest / weekly report | Archive-derived cohorts, first-main per epoch, red incidents/recovery, failing/flaky families, escape classes, runner wait, local contention and coverage. | Current S v1 is local/hourly; scheduled schema owned by #2956 | planned #2955/#2956 |
| Delivery/change triggers | Weekly always; daily newly observed incident (no duration threshold), gate change or collection gap; unchanged incident is not new. Artifacts daily, comments on one pinned issue. | No implemented delivery record/version; #2957 owns delivery state | planned #2956/#2957 |

## Trace a reported value

Three source routes to check without trusting a summary:

- First-pass greens/day: `pull-<pr>.json` bounds the delivery cohort; exact
  squash identities join `run-<id>-attempt-<n>.json`; `summarizeThroughput`
  divides first-main greens by interval days. Read numerator, unknowns and
  acquisition scopes alongside the value.
- Lease occupancy: `reservations.json` names source ref/head and per-lease
  commits; `mergeLeaseObservations` joins renewals, then the throughput report
  clips authorized intervals to the window. A gap in history leaves occupancy
  unknown, even when some leases were read.
- Red recovery: `red-main.json` names opening/clearing runs and source commits;
  `ci-red-main.ts` derives server-time duration. Coordinator cancellations
  additionally require `coordinator-<run>-attempt-<n>.json` and timing snapshots;
  absence cannot establish saved seconds.

The [throughput guide](ci-throughput.md) defines interpretation boundaries;
the [collection guide](ci-timings.md) explains API budgets, creation-window
limits and backfill. Preserve actual source identities and raw acquisition
scopes when recomputing the October 25 baseline. Durable retention and
scheduled delivery remain separate implementation obligations, not properties
of an hourly artifact or a hand-generated report.

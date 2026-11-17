# Collecting CI timing observations

`scripts/ci-timings.ts` collects read-only GitHub Actions timing evidence for
the CI and contract workflows. It does not run tests, change proof selection,
approve a candidate or supply passing-proof receipts.

The [throughput measurement guide](ci-throughput.md) extends these observations
with delivery latency, main-push outcomes, concurrency, reservation history,
explicit worker/incident records and configurable scenario assumptions.

The [integration evidence inventory](ci-evidence.md) maps each metric to its
producer, normalized schema, cadence, retention and collection gaps.

## Collect and report

Use authenticated `gh` with Actions, contents and pull-request read access:

```sh
bun scripts/ci-timings.ts collect \
  --since 2026-07-05T00:00:00Z --until 2026-07-12T00:00:00Z \
  --out tmp/ci-timings
bun scripts/ci-timings.ts collect --run <run-id> --resources --out tmp/ci-timings
bun scripts/ci-timings.ts report --out tmp/ci-timings
```

The time interval selects runs by their original creation time. Every available
attempt of a selected run is collected separately. `--resources` additionally
reads executed proof-job logs for their structured resource markers and the
aggregate's selection/retention marker. It does not persist full logs. Without
that option, job and step timestamps are still available. In runs archived
before browser proof retention was retired (#4107), a retained browser job
cannot always be distinguished from other skipped jobs. An unavailable
marker remains unknown, rather than a zero-duration command.

Filtered searches recursively split time ranges at GitHub's 1,000-result cap.
Run and job listings paginate. Four acquisition workers share one serialized
API client, including discovery, log, seed and lifecycle requests.
Completed snapshots can be resumed without repeating successful acquisition;
resource enrichment retries snapshots lacking requested receipts. There is no
automatic retry that disguises an API error. Acquisition errors and expected
attempts are recorded in `collection.json`; missing discovered attempts are
listed in `summary.json`. Discovery uses a fixed upper bound 15 minutes in the
past unless `--until` is explicit, to avoid paging a changing creation window.
A workflow's discovery failure is recorded in the manifest; other workflows
and the report still run. Non-budget acquisition failures exit nonzero.
Preserve the command exit status with its outputs.

The output directory contains normalized `run-<id>-attempt-<n>.json` snapshots,
a collection manifest, and `summary.json` / `summary.md`. Snapshots retain
repository, workflow, event, head, run, attempt, job, runner labels and original
resource checkout identities. They omit actor names and runner host names.
Resource CPU and memory samples are VM-wide, including containers, and are not
exact process peaks. A log receipt is timing data, not independently validated
proof of a successful candidate.

## Automatic archival

The [evidence archive and delivery decision](../decisions/ci-evidence.md)
records the permanent measurement ref, monthly schema rules, retention split,
publication permissions and daily/weekly delivery cadence. Hourly collection,
described here, uploads 90-day artifacts; the [durable archive](#durable-archive)
compacts them into the permanent data ref daily. Scheduled report delivery is
not part of either.

`.github/workflows/ci-timings.yml` collects an overlapping two-day creation
window hourly, with job/step timings, PR lifecycle, reservation history and
[red-main evidence](ci-throughput.md#red-main-incidents-flakes-and-proof-stopped-while-red),
and supports manual dispatch. Each invocation seeds from the preceding
default-branch `ci-timings` artifact, then fetches only new or incomplete
attempts. Completed attempts and unchanged/merged lifecycle observations are
reused. Resource logs are off on the schedule; request `--resources` for a
bounded manual enrichment. This avoids adding a measurement runner to every PR
push and contract metadata edit. It
runs default-branch code with a read-only token and no dependency install;
candidate logs and downloaded observations are parsed as data. Manual dispatch
uses the dispatched ref's workflow YAML even though checkout pins the tooling
to the default branch; dispatch only a trusted ref. Timing archives are uploaded for 90 days,
subject to repository retention settings. Collection is separate from merge
gates. Its own overhead is not included in product CI totals.

The overlap recovers ordinary missed/in-progress runs and prevents a midnight
boundary from losing a run. A workflow outage longer than that window, or a
rerun of a run created more than two days earlier, needs explicit backfill
with `--since` or `--run`. Automation does not claim exhaustive retention of
such older reruns. The schedule starts only once this workflow is on the
default branch; a local backfill is not evidence that the schedule executed.

### API cost and expected coverage gaps

GitHub's built-in Actions token shares a
[1,000-request/hour repository quota](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-github_token-in-github-actions)
with proof lookup and aggregation. Every collector API invocation first reads
`rate_limit`, admits at most **200 requests including that quota read**, and
stops before issuing another request when remaining quota is **500 or less**.
Response headers refresh the remaining count after each request; absent quota
headers on redirected log/archive downloads use a conservative one-request
debit. All requests use the same serial admission check. A `403`/`429` rate
limit response stops further requests without retrying. Manual commands use
the same defaults; explicit `--request-budget N --reserve N` may narrow them
or allocate a separately approved backfill budget.

A normal seed costs three API calls (measurement run list, artifact list,
download); checking up to five preceding runs costs at most seven. Discovery
costs one call per 100 runs per workflow, plus parent queries when a capped
window splits. Each new/incomplete attempt costs one jobs call per 100 jobs;
older rerun attempts also need an attempt-identity call. One shared PR index
costs one call per 100 recently updated PRs. A changed PR normally costs two
calls (detail and one timeline page), or three when its immutable squash is
read. Unattributed main heads add an exact-SHA lookup. No resource-job log
calls occur on the schedule. Red-main history is read through Git, not the API.
Only while main was red does each new coordinator attempt cost two calls (jobs
and its log), plus one discovery call per 100 coordinator runs in each red
interval.

For example, a warm run with two discovery pages, one PR-index page, 20 new
attempts, and five changed merged PRs costs **42 calls**: `1 + 3 + 2 + 1 + 20 +
15`. This is an explicit workload estimate, not a traffic guarantee. The
offline CLI saturation control measures **200 calls** as the worst case per
invocation; the quota probe is free of primary-quota consumption, so at most
199 charged API requests are admitted. A separate control starts at 503
remaining and measures four total calls, stopping with 500 remaining. Concurrent
CI can reduce the observed allowance further; the reserve is not a lock on
other users of the token.

Budget exhaustion produces a `partial` collection with `requestBudget`,
acquisition errors and missing attempts in both the manifest and report. It
exits **0**, so expected collection limits do not add a red `collect` check to
main. No seed (including the first scheduled run) is an explicit `seed.error`
gap and collection continues within the same ceiling. Snapshots and lifecycle
cache entries outside the overlap are not imported, keeping each seed bounded.
Each artifact retains its own acquisition manifests; download them into
separate directories to review historical gaps. A cold/busy run can fill the
budget before it observes the whole window; later seeded hourly runs resume
the remaining attempts. The window and explicit-backfill limits still apply.

Reservation-history failures are isolated: `reservations.json` records an
`error`, a null source head and no observations, while timing acquisition
continues. The report keeps that error in its reservation scopes and sets
`reservationAcquisition.complete` to false. Any failed reservation scope leaves
total occupancy unknown; successful lease observations remain available in
`reservationAcquisition.leases` for inspection. Red-main history failures are
isolated the same way in `red-main.json`. A failed coordinator discovery, or a
budget stop before it, marks that scope `partial` in its `coordinatorScope`.
The report then lists it under `redMain.acquisition`, rather than reporting no
cancellations.

Download archives before they expire, using their measurement workflow run IDs:

```sh
gh run download <measurement-run-id> --repo schlessera/brain-kit \
  --name ci-timings --dir tmp/ci-timing-archives/<measurement-run-id>
bun scripts/ci-timings.ts report --out tmp/ci-timing-archives
```

Reporting recursively reads normalized snapshots and deduplicates overlapping
repository/run/attempt identities, retaining richer command receipts. Keep
archives in separate subdirectories so manifests survive. Lifecycle acquisition
manifests and reservation histories are also joined across those subdirectories.
Later successful acquisition resolves an earlier error for the same PR; the
original manifest stays in the report's acquisition scopes. Renewals and releases
enrich one lease, preserving its immutable Git sources without duplicating
occupancy. Mixed repositories and conflicting identities are refused.
Measurement files are ignored local artifacts under `tmp/`; do not commit raw
GitHub payloads or full logs.

## Durable archive

`.github/workflows/ci-evidence-archive.yml` runs daily at 02:17 UTC and on
manual dispatch. It lists every retained `ci-timings` artifact uploaded by a
scheduled or dispatched collector run on the default branch, skips those the
archive already holds, and walks the rest oldest first:

```sh
bun scripts/ci-timings.ts archive --repo odysseus/chronicle --branch main \
  --request-budget 120 --reserve 500
```

Normally that is the previous day's artifacts. After an outage, or until the
initial backfill finishes, it also takes every earlier retained artifact not
yet archived. The dispatch's `backfill` input raises the request budget to 450;
dispatch it again until the job summary reports `pending: 0`. The command
shares the collector's [API budget and reserve](#api-cost-and-expected-coverage-gaps):
one listing call per 100 collector runs and per 100 artifacts, plus one
download per artifact. A budget stop keeps
what it committed and leaves the rest pending, with exit status 0.

The data ref is `refs/heads/brain-ci-metrics`. Each record kind lives in
`YYYY-MM/<kind>.json`, partitioned by UTC month, one record per line in
timestamp and identity order. Monthly files hold `run`, `pull`, `coordinator`,
`event`, `collection`, `enrichment`, `reservations`, `red-main` and `source`
records, keyed by the [inventory's](ci-evidence.md#record-kinds-schemas-and-retention)
identities and partitioned by the run, PR, coordinator or artifact creation
time, the event time, or the collection time. `summary.json`, Markdown and
analysis inputs are derived and are not archived. Coordination events the
[publisher](#publish-local-coordination-events) appended under `events/` stay
there and are also compacted into the month's `event.json`.

Compaction applies the report's own joins. Overlapping run snapshots keep the
richer receipts and exact squash attribution; at equal collection times the
PR-attributed copy wins. The newest PR observation wins. Events, sources and
other immutable identities must agree; a contradiction refuses the newcomer.
Hourly collection manifests and reservation histories repeat a two-day window,
so each identical expected attempt or lease observation is stored only in the
month's earliest record carrying it. The report's joins are idempotent over
identical entries, so nothing they read is lost. Every record keeps its own
schema version; nothing is migrated.

Every record passes the schema check and the tree's leakage screen before it
is merged. A refused record is excluded, named with its kind, artifact path and
reason in the JSON output and job summary, and makes the command exit 1 after
publishing the rest. Each artifact gets a `source` record with its ID,
collector run, creation time, SHA-256 digest and record/refusal counts.
An unreadable artifact is refused as a source and retried next time.

Each commit is parented by the inspected remote head and pushed with exact
`--force-with-lease`, using an isolated index; the caller's checkout and index
never move. A competing writer causes a fresh read and merge, skipping the
artifacts it already archived, for up to five attempts. Sources commit in
batches of 50, so a timeout keeps earlier batches. A run that finds nothing new
downloads nothing and commits nothing. A monthly file over 95 MiB stops the
publication before the push, since GitHub refuses larger blobs.

Explicit normalized directories, such as a budgeted `collect --since ... --until
...` backfill, compact the same way, from a trusted checkout with push access:

```sh
bun scripts/ci-timings.ts archive --repo odysseus/chronicle --dir tmp/ci-timing-backfill
```

Report from the data ref instead of artifacts. `--from-archive` names the git
remote holding it. With `--since` and `--until`, only the months from one
before the interval to one after it are read:

```sh
bun scripts/ci-timings.ts report --repo odysseus/chronicle --from-archive origin \
  --since 2026-07-05T00:00:00Z --until 2026-07-12T00:00:00Z --out tmp/ci-report
```

Readers refuse an unknown kind, an unknown schema version, another repository's
record and a record outside its month partition. The archive is measurement
only and never an input to proof, selection or merging.

## Scheduled evidence reports

`.github/workflows/ci-evidence-report.yml` runs daily at 03:37 UTC, an hour
after the archive compaction, and on manual dispatch. It reads the data ref and
main's full first-parent history, with a read-only token, and writes the daily
digest. On Mondays, or when dispatched with `weekly`, it also writes the weekly
report. Both go to the job summary and the `ci-evidence-report` artifact, kept
for 90 days, whether or not anything is delivered:

```sh
bun scripts/ci-evidence-report.ts --cadence daily --repo odysseus/chronicle \
  --from-archive origin --out tmp/ci-evidence [--until 2026-07-13T00:00:00Z] [--history origin/main]
```

The digest covers the UTC day before `--until`, and the weekly report the seven
days before it. `--until` defaults to the start of the current UTC day and must
fall on a whole hour. The command writes `digest.json` and `digest.md`, or
`weekly.json` and `weekly.md`. Each Markdown report opens with a `## Summary`
section that ends at the next heading, so it can be posted on its own and link
the full artifact. The JSON is `version: 1`.

Each report has these sections, all computed from the archive for its window:

| Section | Content |
| --- | --- |
| `gate` | The #2934 Phase B gate over the seven days before `--until`, and `previousGate` a day earlier. See below. |
| `throughput` | The [throughput](ci-throughput.md#what-the-report-measures) cohort headline: merges, first-main green, first-pass greens/day, latencies, size cohorts, merge paths and reservation occupancy. The weekly report also carries the full summary under `detail`. |
| `epochs` | First-main green per [proof-policy epoch](ci-throughput.md#proof-policy-epochs) the window touches. |
| `redMain` | Red-main incidents open at any time in the window, with time to green, those still open at its end, and the ones first observed in it. |
| `families` | The ten failing test families most often named by those incidents, the ten most-suspected flaky families with probe outcomes, first-main failed job categories and failure classifications. |
| `escapeClasses` | Always `null` until an archived source exists ([#4043](https://github.com/schlessera/brain-kit/issues/4043)). |
| `runnerSlotWait` | [Runner-slot wait](ci-throughput.md#runner-slot-wait) over the attempts created in the window. |
| `localContention` | Published work and wait events in the window; `null` when none were published. |
| `activity` | Run attempts and merges per UTC day. A day with a missing collection hour reports `null` counts and the observed numbers as `observedRunAttempts` and `observedMerges`. |
| `coverage` | Missing collection hours, expired sources, failed acquisitions, missing run attempts and named unknowns. |

**Coverage.** An hour of the window is missing when no collection manifest's
creation window covered it. No activity is known for a missing hour, so it is
never read as zero. An hour covered only by partial collections is listed in
`partialOnly`, because its runs may be incomplete, but it is not a gap. A missing
hour or failed acquisition more than 90 days old is also counted under
`expiredSources`: GitHub no longer holds its raw source, so the gap is permanent.
Failed acquisitions list partial collections, lifecycle errors, failed
reservation and red-main histories, partial coordinator scopes and coordinator
logs that could not say what they cancelled.

**Phase B gate.** The gate is `met` only when all three conditions are met for
the seven days before `--until`; otherwise it is `not met` and `failing` names
each condition that is not met or is unknown:

- `epoch`: the current proof-policy epoch opened at a classified proof-system
  squash at least seven days before `--until`. An unreadable history, an
  unbounded epoch or an unknown boundary leaves it unknown.
- `firstMainGreen`: at least 80% of the epoch's known first-main outcomes in
  those days are green. No known outcome, or any missing collection hour in
  those days, leaves it unknown.
- `incidentsAttributed`: every red-main incident open in those days has a
  `failure-classified` event naming its opening run. No red-main history
  collected in those days, or a failed red-main acquisition, leaves it unknown.

**Delivery trigger.** `changed` is true when a red-main incident is first
observed in the window (its earliest archived red-main record falls in it), the
gate's status differs from `previousGate`, or the window has a missing
collection hour. `triggers` names which. An incident observed again unchanged
does not trigger, and no duration threshold applies
([decision](../decisions/ci-evidence.md#reports-cadence-and-delivery)). The
weekly report is delivered whatever its flag. Posting the reports is
[#2957](https://github.com/schlessera/brain-kit/issues/2957)'s; this workflow
holds no write permission.

## Refresh reviewed unit weights

Use the separate explicit refresh command after choosing a successful exhaustive
CI run and attempt:

```sh
bun scripts/refresh-unit-costs.ts <run-id> <attempt>
```

It writes `scripts/test-shard-costs.json` in seconds and
`scripts/unit-shard-measurement.json` with the run, attempt, actual checkout,
immutable tree/parents, job/step durations, artifact IDs and archive digests.
The command requires every planned partition as a successful unit job (four,
or eight for a ready confirmation), one attributed archive per
shard, complete matching JUnit/timing partitions, and exact source-discovery
coverage. Failed, cancelled, partial or ambiguously attributed evidence is
refused. A successful workflow summary alone does not qualify a run; duplicate
artifacts from reruns and nonexhaustive selections can still prevent refresh.

Review newly weighted files, omissions and large changes against those hosted
completed-file observations. Local measurements can expose stale estimates and
measure queue balance, but their wall times never become hosted weights. The
[CI measurement decision](../decisions/ci-utility.md#isolated-local-import-graph-feedback)
records the source-bound wide comparison and the 900-second default-feedback
gate. Contribution CI consumes the reviewed table without downloading timings.

## Interpret the results

The report distinguishes three quantities:

- **Observed runner consumption:** summed executed job intervals, including
  failed and cancelled attempts. This is not billed minutes, CPU time or wall
  time. Overlapping parallel jobs each consume their own runner time.
- **Attempt elapsed time:** attempt start to the last observed executed job completion.
  Initial queue is separately request-to-first-observed-job for first attempts.
  A rerun's original `created_at` is not its request time. Dependent-job queue
  eligibility, reservations, human review and ready-to-merge time are unknown.
- **Runner-slot wait:** job creation to observed execution start, with explicit
  unknown counts and a known-job denominator for waits over five minutes. See
  [cohorts and schema versions](ci-throughput.md#runner-slot-wait).
- **Check duration:** mean, median, nearest-rank p90 and sample count per
  event/category, named step and successful resource-command phase. Job/step
  samples include observed failed and cancelled execution. Means across
  different sources or runner populations are descriptive, not causal.

A cancelled job with no executed steps is unobserved even when GitHub supplies
start/end timestamps. Its fabricated-looking interval is not charged as
execution. Missing/incomplete timestamps and lost attempts make consumption a
lower bound; they do not prove zero cost. Skips with validated timing metadata
are marked retained separately from excluded/unresolved skips. Selected job
outcomes and retention validation remain the responsibility of product proof.
Cancelled attempts with an explicitly empty job inventory are counted as
unobserved cancellations, separately from failed inventory acquisition.

PR attribution uses the run's PR payload, an exact current PR head, or an
unambiguous repository/branch match from PR metadata. The last form explicitly
does not independently verify the historical head. Main-push attribution uses an exact
merged squash SHA, never time proximity. Ambiguous/missing PR associations
remain outside per-PR totals. A PR with both PR and main-push attempts in the
collection is a paired observation; its totals cover this window, not its
complete lifetime. Totals include multiple observed confirmation/feedback
attempts, so repeated work is visible without pretending to know its cause.

## Full-proof estimates

Successful scheduled/manual CI attempts with all product categories present
and freshly successful provide an exhaustive-run proxy. Keep sample run IDs,
heads and runner labels with the report. Its median summed runner duration is
used for two explicitly estimated baselines on paired PRs:

- One full run before merge and one after merge.
- One full run for every observed PR/main CI attempt, including reruns.

The observed comparator excludes contract jobs because those remain necessary
under either policy. No complete exhaustive samples means no baseline estimate.
Partial/failed/retained runs cannot be full-run samples. These estimates do not
model alternate queueing, test counts on another commit, failures, cache warmth,
collector overhead or different shard layouts. They are not measured savings.
A causal comparison requires paired full/selected execution on the same source,
runner and runtime inputs, retaining the existing proof assertions and gates.

See [testing](testing.md#required-proof-for-a-pr),
[proof-domain reconciliation](proof-domains.md#resource-and-scheduling-reconciliation)
and [the CI measurement policy](../decisions/ci-utility.md#measuring-the-critical-path).

## Publish local coordination events

From a trusted repository checkout with Git push access to `origin`, publish
locally recorded work, wait and preemption events explicitly:

```sh
bun scripts/ci-timings.ts publish --repo odysseus/chronicle --out tmp/ci-events
```

Use the repository's own `owner/name` in place of the example. This internal
measurement script prints JSON with `added`, `existing` and `head`; it is not
the supported `brain --json` contract. Collection and report modes remain
read-only. Publication grants no proof, selection or merge authority.

The input directory holds `event-<id>.json` files from `record`. Each event
uses schema version 1, an immutable ID, repository and UTC ISO timestamp.
Allowed kinds are `work-started`, `work-finished`, `wait-started`,
`wait-finished` and `preempted`. Worker/task IDs are required; `orchestrator`
is optional. IDs contain only ASCII letters, digits, underscores and hyphens,
up to 100 characters. Use opaque generated identifiers, never people's names
or machine identifiers. Optional `pr` is a positive integer; optional `reason`
is `reservation`, `ci`, `review`, `conflict` or `other` and is required for wait
boundaries. Preemption remains neither pass nor failure. Event emission is the
orchestrator's responsibility; this command does not read the host ledger.

Each invocation accepts at most 100 events, 8 KiB per file and 256 KiB total.
For a larger backlog, select smaller input directories while retaining each
original event's ID and bytes. Non-event files are ignored; selected symlinks,
unknown versions, arbitrary fields, hostname/path-like IDs and personal-string
leakage are refused before contacting the remote. Incident/classification
annotations are outside this publisher's local-event schema: select a directory
containing only work, wait and preemption events.

The publisher appends immutable `events/<id>.json` files to
`refs/heads/brain-ci-metrics`, preserving the inspected tree's other files.
These are the dedicated published-event inputs for daily compaction (#2955),
which owns the monthly normalized archive. This command enables neither
compaction nor scheduled report delivery. Repeating a batch is a no-op;
an existing ID with different content is refused. Unknown event versions are
refused rather than rewritten.

Every commit is parented by the inspected remote head and pushed with exact
`--force-with-lease`. A competing update causes a fresh read and merge, up to
five attempts. Persistent contention or access failure exits nonzero, retaining
all local inputs for a retry. Errors appear on stderr; preserve that diagnostic
with the command exit status. No input is deleted, including after success.

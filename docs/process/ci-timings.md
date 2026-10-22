# Collecting CI timing observations

`scripts/ci-timings.ts` collects read-only GitHub Actions timing evidence for
the CI and contract workflows. It does not run tests, change proof selection,
approve a candidate or supply passing-proof receipts.

The [throughput measurement guide](ci-throughput.md) extends these observations
with delivery latency, main-push outcomes, concurrency, reservation history,
explicit worker/incident records and configurable scenario assumptions.

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
that option, job and step timestamps are still available, but retained browser
proof cannot always be distinguished from other skipped jobs. An unavailable
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

`.github/workflows/ci-timings.yml` collects an overlapping two-day creation
window hourly, with job/step timings, PR lifecycle and reservation history,
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
calls occur on the schedule.

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
`reservationAcquisition.complete` to false. With no successful reservation
observations, occupancy remains unknown rather than measured zero.

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

## Interpret the results

The report distinguishes three quantities:

- **Observed runner consumption:** summed executed job intervals, including
  failed and cancelled attempts. This is not billed minutes, CPU time or wall
  time. Overlapping parallel jobs each consume their own runner time.
- **Attempt elapsed time:** attempt start to the last observed executed job completion.
  Initial queue is separately request-to-first-observed-job for first attempts.
  A rerun's original `created_at` is not its request time. Dependent-job queue
  eligibility, reservations, human review and ready-to-merge time are unknown.
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

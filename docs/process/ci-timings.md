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
Run and job listings paginate; up to four runs are acquired concurrently.
Completed snapshots can be resumed without repeating successful acquisition;
resource enrichment retries snapshots lacking requested receipts. There is no
automatic retry that disguises an API error. Acquisition errors and expected
attempts are recorded in `collection.json`; missing discovered attempts are
listed in `summary.json`. Run discovery failure exits nonzero before claiming
a complete collection. Preserve the command exit status with its outputs.

The output directory contains normalized `run-<id>-attempt-<n>.json` snapshots,
a collection manifest, and `summary.json` / `summary.md`. Snapshots retain
repository, workflow, event, head, run, attempt, job, runner labels and original
resource checkout identities. They omit actor names and runner host names.
Resource CPU and memory samples are VM-wide, including containers, and are not
exact process peaks. A log receipt is timing data, not independently validated
proof of a successful candidate.

## Automatic archival

`.github/workflows/ci-timings.yml` collects an overlapping two-day creation
window daily, with command receipts, PR lifecycle and reservation history, and supports manual dispatch. This avoids
adding a measurement runner to every PR push and contract metadata edit. It
runs default-branch code with a read-only token and no dependency install;
candidate logs are parsed as data. Timing archives are uploaded for 90 days,
subject to repository retention settings. Collection is separate from merge
gates. Its own overhead is not included in product CI totals.

The overlap recovers ordinary missed/in-progress runs and prevents a midnight
boundary from losing a run. A workflow outage longer than that window, or a
rerun of a run created more than two days earlier, needs explicit backfill
with `--since` or `--run`. Automation does not claim exhaustive retention of
such older reruns. The schedule starts only once this workflow is on the
default branch; a local backfill is not evidence that the schedule executed.

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

# Storage growth and low-space guidance

This is the scoped proposal from #2014, within #1779. It does not activate
sampling, persist history, select a retention policy or approve thresholds.
The [approved Storage design](../decisions/design-kit/storage.md) remains the
initial product: explicit Refresh and measurements after completed owner
operations, with the complete inspect/select/review/remove/result journey.
The implementation decisions below require a maintainer ruling before a
follow-on can ship them. Keeping the initial product without this extension is
a valid outcome.

## Boundaries and ownership

The UI server owns aggregate observation history in its existing operational
state, under the same human-owner boundary as Storage inventory. Agents and
ordinary content readers receive neither history nor capacity targets. No
new core database, `.stats-history.jsonl` fields or filesystem-provider seam.
Operational backup/restore includes the new server table through its existing
versioned migration/export machinery; restoring history never restores files.

Core corpus history is intentionally different (`snapshotOf`,
`packages/core/src/lib/stats-history.ts:132-172`) records filtered corpus and
health fields; thinning (`thin`, `packages/core/src/lib/stats-history.ts:232-244`) retains
recent days and older weekly observations. Neither contract supplies server
capacity identity or a lifetime byte bound. Caller availability alone
(`freeSpaceBytes`, `packages/core/src/lib/stats.ts:213-224`) is not quota headroom.
[Accounting discovery](storage-accounting.md) and
[native brain storage](../decisions/native-brain-storage.md) bind all quantities.

## Proposed bounded record

Schema `storage_history_v1` stores three bounded tiers totaling at most **128 aggregate samples**,
with at most **1,792 UTF-8 JSON bytes per sample**. A singleton metadata record
is capped at 2,048 bytes. Thus retained serialized payload is at most 231,424
bytes, below the proposed 256 KiB ceiling. Limits apply globally per app, not
once per owner, root or capacity. Oversize samples are rejected visibly; values
and scope are never silently truncated to fit.

One sample is the following exact proposed shape. Numbers are safe nonnegative
byte/count integers or null as specified; no floating point byte totals. Hashes
are 32 hexadecimal characters derived from host identities, not paths.

```ts
{
  v: 1,
  tier: "recent" | "daily" | "weekly",
  gap: boolean,          // incomplete or incompatible evidence within this bucket
  at: number,             // UTC epoch milliseconds, end of observation
  start: number,          // UTC epoch milliseconds, start of observation
  source: "scheduled" | "refresh" | "operation",
  collector: string,      // released package version, at most 32 ASCII bytes
  scope: string,          // hash of root set, ownership and measurement policy
  basis: 1,              // logical length and qualified 512*st_blocks model
  coverage: "complete" | "partial" | "unknown",
  reason: "none" | "partial" | "capacity" | "scope-limit" | "budget" | "changed",
  caps: Array<{           // at most four separately comparable capacity scopes
    id: string,          // capacity identity hash, at most 32 ASCII bytes
    scope: string,       // identity of the permitted root set
    total: number | null,
    used: number | null,
    free: number | null,
    available: number | null,
    coverage: "complete" | "partial" | "unknown",
    owners: [
      [number | null, number | null], // Brain logical/object allocation
      [number | null, number | null], // App logical/object allocation
      [number | null, number | null]  // Operator logical/object allocation
    ],
    union: [number | null, number | null] // deduplicated known-store union
  }>
}
```

`owners` are attribution views, not additive physical partitions. `union` is
computed once from object identities; never sum overlapping owners. Shared
extents remain qualified charges. Capacity fields retain native provenance and
unknown semantics in the schema/basis version; unsupported overlay/quota
identities cannot become comparable capacities. There is no per-file/path
history, reservation estimate, transcript content, filename, provider key or
host pathname. The server maps opaque IDs to current authorized display names.

At most four capacities have retained history. Select their stable order once
per scope epoch, rather than rotating capacities. Additional capacities remain
visible in inventory with “History not recorded for this capacity.” Global
coverage becomes partial with `scope-limit`; individually complete retained
scopes can still be compared. Reconfiguration starts a new epoch.

SQLite page/index/WAL overhead is **outside the serialized-payload bound**;
it is not claimed to fit in 256 KiB. The operational DB already appears once in
App storage, including history. Do not add payload bytes to measured DB bytes.
Report the payload charge separately as explanation. Insufficient operational
headroom preserves the previous valid tiers and reports “History paused.” Never
force vacuum, truncate WAL, expire journal objects or delete backups to fit
history. Sampling failure must not destroy recovery.

## Proposed cadence, replacement and cost

Sample **once per six-hour UTC bucket**, at the first eligible opportunity while
the server runs. No catch-up scans after restart/sleep. No startup admission or
worker hot-path scans. A cross-process owner lease coalesces scheduled, explicit
refresh and operation requests into one collection; callers share its result.
It does not exclude file writers; operations keep their existing mutation locks.

A successful Refresh or completed operation may replace the current bucket.
Persist at most one history transaction per minute; requests during that minute
retain only the newest pending aggregate. A crash loses that pending observation,
not content. A partial observation may be retained only if no complete sample
exists in the bucket; otherwise expose the failure without erasing good evidence.

Retain three overlapping UTC tiers, with **128 total slots**, including current
buckets:

| Tier | Bucket width | Slots | Nominal retained horizon |
| --- | --- | --- | --- |
| Recent | Six hours | 64 | 16 days |
| Daily | One UTC day | 32 | 32 days |
| Weekly | Seven days, Monday 00:00 UTC | 32 | 224 days (about seven months) |

Each collected observation updates the current bucket in all three tiers in
**one transaction**. Each tier retains the latest actual observation in its
bucket, with its original timestamp and values; these are endpoints, not sums,
averages or peaks. The same observation may occupy three slots. Overlap is
intentional and included in the 128-slot bound, not added to the horizon.
No scans run for compaction, and no raw history is retained behind these tiers.
Updating three bounded records replaces the old single-record write while the
scan cadence and transaction rate remain unchanged.

Expire buckets by UTC age as well as slot count: retain bucket indexes from
current index minus (slots minus one) through current index. On restart, prune
old records during the next eligible transaction without backfilling empty
buckets. Thus a long outage cannot turn 32 weekly slots into an unbounded age
claim. Current buckets are labelled provisional; actual endpoint timestamps
remain visible. Clock reversal pauses persistence until the last accepted time
is reached, rather than overwriting a newer bucket with an older measurement.

`gap` is sticky within each bucket. Set it when an observation is partial,
unknown, has a changed scope/basis, or a scheduled six-hour bucket is missing.
For a bucket first observed after its first six-hour interval, set it immediately.
When closing a bucket, a missing final interval also sets it. Retaining a prior
complete endpoint after a failed refresh does not clear this flag. A whole
missing day/week has no invented record. Reconfiguration never combines values
across identities; retain the newest endpoint but mark the affected bucket.
This conservative flag applies to all capacity series in that sample.

The table labels Recent/Daily/Weekly and the actual observation time. Older
history uses discrete points, without interpolating daily or weekly endpoints
or implying that peaks between them were retained. Missing buckets and flagged
buckets are visibly incomplete. The recent rate described below uses only Recent
samples with `gap: false`; a coarse point cannot fill a recent gap or count as
additional evidence. Long-term daily/weekly history is available for inspection;
long-term rates or forecasts are not part of this proposal.

The bounded singleton records schema, last attempted bucket, last persisted
time and current episode states for four scopes. Tier indexes derive from
sample timestamps, and gap flags live in the capped samples. No unbounded event
log or separate rollup staging buffer.

A full sample reuses inventory budgets: one scan/app, at most two metadata
workers, finite entries/depth/time/output/errors. No Git maintenance, attachment
hashes, unapproved stores or writable content DB. Capacity-only refresh can update
current guidance but is not an aggregate-history sample: it cannot repeat an old
store total under a new timestamp.

Maximum scheduled cost is four bounded scans and four small transactions per
running day. A tick coalesces with an active scan and never queues a backlog.
Explicit refresh retains owner-coordinator rate limits. This is a proposed cost
ceiling, not proof that large-corpus scanning is cheap. Implementation needs
real runtime/cancellation evidence and no-stall proof for concurrent turns.

## Comparability and growth

Compare only equal capacity identity, root-set scope, basis version, complete
coverage, no gap flag and available fields. A collector patch is comparable only when its
measurement semantics are unchanged; a basis change starts a new epoch. Unknown
allocation, unsupported identity, overflow, root changes and partial samples
create labelled gaps. Never interpolate across them. Reflink allocation is a
qualified charge, not exclusive physical usage or reclaimable space.

The proposed initial rate is **observed endpoint change divided by elapsed
time** across the latest contiguous comparable Recent window, at most seven days.
Require five complete samples spanning at least 48 hours and no gap over
12 hours. Display signed decimal bytes/day, basis and interval:
“App allocation +120 MB/day observed over 3 days.” Negative values say decreased;
a flat observed window can show zero. Insufficient evidence cannot.

Capacity availability is a separate series. Other writers, retained objects,
filesystem overhead and delayed reclamation can change it independently of the
known-store union. Never label all capacity loss as App growth or all observed
post-operation gain as reclaimed by that operation.

**No time-to-full estimate is proposed initially.** A constant-growth forecast
would read as a deadline despite bursts, concurrent writers and temporary
headroom. Copy says “No exhaustion estimate.” A later estimator needs an explicit
reliability decision and traces establishing useful error bounds.

## Proposed low-space states and hysteresis

These are recommendations, not approved policy. Evaluate each capacity using
fresh caller availability and total. Unknown capacity has no inferred percent,
zero meter or healthy verdict. Six-hour-old observations are stale: retain the
historical warning and its age without claiming current safety.

| State | Proposed transition | Copy/action |
| --- | --- | --- |
| Unknown | Missing trustworthy total/available/identity | “Capacity unavailable. Refresh or inspect host capacity.” |
| Observed | Available above 10%, no active episode | “Capacity observed … ago.” No promise an operation fits. |
| Low | Fresh available at or below 10% | “Low space on Brain volume. Files and retained history share this capacity.” |
| Critical | Fresh available at or below 5%, or owner-confirmed no-space refusal | “Very low space. Some writes may be refused. Add capacity or review eligible cleanup.” |
| Stale | Last usable observation older than six hours | “Refresh before planning maintenance.” Preserve the old age/value. |

A no-space refusal identifies its affected target, not a fabricated percentage
or proof all capacities are full. Show it even when statfs is unknown. Maintain
one episode per scope. Worsen on one fresh observation. Clear Critical only after
two fresh observations at least 60 seconds apart above 7%, returning to Low;
clear Low after two additional
such observations above 12%. A scope change starts Unknown, not resolved.
Unknown/partial/stale samples never clear warnings. Clock reversal or a future
timestamp breaks comparability; retain the last trustworthy state rather than
using a negative age or growth interval.

Proposed notification scope is **in-pane only**: no push, email, OS notification,
sound, chat message or global toast. Repeated scans update the same state and age.
Explicit Refresh announces completion once with polite status text. Critical
copy is associated with the capacity heading, not a repeated assertive live
region. No new navigation destination or shortcut.

A status never authorizes writes. Packing, index rebuild/compaction, pin refresh,
retained binary removal/Undo and backups may need headroom. Label those actions
“Needs headroom.” Owner preflight remains final; refusal and manual capacity
provision are legitimate. Never discard history, pins, sessions or backups as an
automatic cure. Scratch/staging cleanup uses existing policies. Retained-only
pressure must be able to say “No eligible cleanup found.”

## Layouts and accessible copy

At 320px (296px content), cards stack with wrapping text/actions and 44px targets.
Units are decimal with exact-byte details. Labels/icons/text convey states in
dark, paper and grey; colour is supplementary.

```text
Storage
Capacity · Brain volume
! Low space
1.80 GB available of 20.0 GB
Observed 4 minutes ago
Writes: Brain files, Git,
retained file history
[Refresh]

Growth · On disk
App: +120 MB/day observed
Over 3 days · 13 samples
Shared extents may overlap
No exhaustion estimate
[View observations]

Review cleanup
[Prune eligible scratch]
Pinned answers stay
[Pack Git objects]
Needs headroom
No eligible cleanup found?
Add capacity through your host.
```

Desktop keeps capacity-specific cards above the existing treemap/list. Do not
combine capacities. Expand details inline without losing filters, selection or
focus; alerts never displace a selected-file review.

```text
Storage                              [Refresh]  Observed 4 minutes ago
+----------------------------------+----------------------------------+
| ! Low space · Brain volume       | App volume · Capacity observed   |
| 1.80 GB available / 20.0 GB       | 8.00 GB available / 40.0 GB       |
| Writes: files, Git, retained     | Writes: sessions, inbox, UI DB   |
| history                         |                                  |
+----------------------------------+----------------------------------+
Growth · On disk  App +120 MB/day over 3 days · 13 samples
[View observations] Shared extents may overlap · No exhaustion estimate
Treemap / equivalent table                  Existing inspect/remove flow
Maintenance: [Prune eligible scratch] [Pack Git objects · Needs headroom]
```

Unknown and retained-only pressure have complete phone states:

```text
Capacity · Brain volume
? Capacity unavailable
Last observation: 8 hours ago
Writes: Brain files, Git,
retained file history
[Refresh]
Growth unavailable
Need comparable observations

! Very low space · App volume
Owner refused a write
Available bytes unknown
Retained data uses this store
No eligible cleanup found
Add capacity through your host.
[Refresh] [View retained usage]
```

An observation table supplies time/age, scope, basis, coverage and nullable values
as an equivalent to any sparkline. Missing points are gaps, not zeros. Keyboard
users reach all actions and return from details; refresh never moves focus.
At 200% zoom the layout stacks without clipping. Reduced motion disables chart
animation. Runtime/browser/accessibility proof belongs to implementation.

## Synthetic decision examples

The companion [trace experiment](storage-growth-experiment.ts) evaluates these
proposed rules offline using Odysseus observations anchored to 2026-07-12. It is
not production history, shipped policy or a benchmark.

| Trace | Required interpretation |
| --- | --- |
| Steady growth, 13 samples over three days | Signed endpoint rate and interval; no exhaustion estimate. |
| Burst then steady size | Interval average, not a forecast; no pressure warning without capacity evidence. |
| Reclamation | Negative observed change; no causal savings claim. |
| Capacity/root change | New epoch; old observations cannot supply a rate. |
| Partial/unknown midpoint | Break the window; too little new evidence means no rate. |
| Retained-only pressure | Low/Critical plus no eligible cleanup; capacity provision is legitimate. |
| Concurrent unowned writer | Capacity falls while store usage is flat; do not attribute loss to App. |
| Year of six-hour observations | At most 64/32/32 slots; weekly history reaches approximately seven months without extra scans. |
| Missing interval inside a daily/weekly bucket | Sticky gap survives replacement by a later complete endpoint. |
| Long outage | Empty periods remain empty; age-expired buckets disappear without catch-up scans. |
| Threshold oscillation | Worsen immediately; clear only with two qualifying observations 60 seconds apart. |

The experiment serializes worst-case field lengths and four capacities, checks
1,792 bytes/sample and the global payload ceiling, and checks all three tier caps, UTC boundaries, missing buckets, sticky gaps,
long outages and clock reversal across a year of synthetic observations.
Physical SQLite/WAL overhead remains an implementation measurement, not an
invented exact charge in this spike.

## Decisions and later implementation

The maintainer must choose before implementation:

1. Six-hour collection with 64 recent, 32 daily and 32 weekly slots (128 total),
   1,792-byte samples, four historical
   capacity scopes and these coalescing rules, or explicit refresh only.
2. Observed endpoint rates with this evidence window and no exhaustion estimate,
   or defer growth display.
3. In-pane 10%/5% guidance and 12%/7% two-observation clearing, without outward
   notifications, or retain capacity figures and owner refusals alone.

The recommended bundle adopts all three additions. It bounds cost and provides
capacity-specific guidance without predictive certainty or a new deletion policy.
Keeping explicit-only behavior is a valid outcome. Different rules require an
updated proposal and synthetic examples before ready implementation issues.

Once settled, scope two native #1779 children: server history/capacity state
(migration, payload bounds, owner auth, coalescing, recovery, cancellation,
versioned HTTP/config contracts and minor changeset), then growth/low-space UI
(layouts, table, copy, accessibility and browser proof). Each carries the actual
ruling and failing-first/runtime criteria. The proposal alone is not approval.

Remote/provider usage needs an authenticated provider-specific scope/quota
contract. Host/container stores need explicit owner-approved roots and safe
measurement evidence. Per-file Git attribution needs a bounded meaningful model.
Derivative grouping needs provenance. Workspace cleanup needs its own lifecycle
and use-case ruling. New journal/history/backup expiry needs an explicit loss
and recovery ruling. Pressure does not authorize any of them.

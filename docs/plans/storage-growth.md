# Storage growth and low-space guidance

This design implements the maintainer's [reconciled ruling](https://github.com/schlessera/brain-kit/issues/2014#issuecomment-6212070681),
recorded durably in [Storage guidance](../decisions/storage-guidance.md).
It specifies a later extension; it does not activate runtime collection or
notifications. The [initial Storage design](../decisions/design-kit/storage.md)
keeps its complete inspect/select/review/remove/result journey and does not wait
for history. No cleanup or retention policy is changed by a pressure warning.

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
(`freeSpaceBytes`, `packages/core/src/lib/stats.ts:216-227`) is not quota headroom.
[Accounting discovery](storage-accounting.md) and
[native brain storage](../decisions/native-brain-storage.md) bind all quantities.

## Bounded record and encoding

Schema `storage_history_v1` retains **186 aggregate samples** globally, with at
most four capacities per sample. Its canonical UTF-8 JSON payload uses compact
tuples, capped at **1,152 bytes per sample**, plus at most **40,960 bytes** for a
shared descriptor dictionary and singleton warning/scheduler state. Including
array framing (187 bytes), the maximum is **255,419 bytes**, below **256 KiB**.
Notification delivery receipts have their own bounded operational table; they
are not smuggled into this history-payload claim. Their physical charge is part
of the operational DB inventory, as are SQLite pages and WAL.

The conceptual fields are preserved by this exact tuple schema (no rounding,
lossy packing or silently dropped values):

```ts
type Quantity = number | null; // safe, nonnegative byte integer; null is unknown
type Capacity = [
  descriptor: number, // integer 0..743; dictionary holds identity and root scope
  total: Quantity, used: Quantity, free: Quantity, available: Quantity,
  coverage: 0 | 1 | 2, // complete, partial, unknown
  brainLogical: Quantity, brainAllocated: Quantity,
  appLogical: Quantity, appAllocated: Quantity,
  operatorLogical: Quantity, operatorAllocated: Quantity,
  unionLogical: Quantity, unionAllocated: Quantity,
];
type Sample = [
  version: 1, tier: 0 | 1 | 2, gap: 0 | 1,
  at: number, start: number, // actual UTC epoch milliseconds; safe nonnegative
  source: 0 | 1 | 2, // scheduled, refresh, operation
  descriptor: number, // integer 0..185: collector, global scope and basis
  coverage: 0 | 1 | 2,
  reason: 0 | 1 | 2 | 3 | 4 | 5, // none, partial, capacity, scope-limit, budget, changed
  capacities: Capacity[], // at most four
];
```

Dictionary entries are fixed tuples. A sample descriptor holds package version
(at most 32 ASCII characters), 32-character scope hash and basis version 1.
A capacity descriptor holds a 32-character identity hash and 32-character root
scope hash. The combined serialized dictionary and singleton must fit 40,960
bytes; do not reserve an independent budget per dictionary kind. Descriptor IDs
are local immutable references while used by retained samples, never reused
under an existing sample. Garbage-collect unreferenced descriptors in the same
transaction as tier replacement. If churn exhausts this budget, pause history
and expose the reason while preserving the previous valid set. The maximum
field-length experiment separately qualifies four capacities and 186 samples;
it does not pretend worst-case unique scope churn fits the dictionary forever.
No per-file names, paths or content are retained. Public JSON uses named fields
and documented versioning; compact tuples are private persistence encoding.

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

## Cadence, replacement and cost

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

Retain three overlapping UTC tiers, with **186 total slots**, including current
buckets:

| Tier | Bucket width | Slots | Nominal retained horizon |
| --- | --- | --- | --- |
| Recent | Six hours | 64 | 16 days |
| Daily | One UTC day | 90 | 90 days |
| Weekly | Seven days, Monday 00:00 UTC | 32 | 224 days (about seven months) |

Each collected observation updates the current bucket in all three tiers in
**one transaction**. Each tier retains the latest actual observation in its
bucket, with its original timestamp and values; these are endpoints, not sums,
averages or peaks. The same observation may occupy three slots. Overlap is
intentional and included in the 186-slot bound, not added to the horizon.
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
buckets are visibly incomplete. Observed recent rates use only Recent samples with `gap: false`. Forecasts use
the separately qualified windows below. A coarse point cannot fill a recent gap
or count as an extra recent observation; weekly history is inspection-only.

The bounded dictionary/singleton records schema, last attempted bucket, last persisted
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
Explicit refresh retains owner-coordinator rate limits. This is a cost
ceiling, not proof that large-corpus scanning is cheap. Implementation needs
real runtime/cancellation evidence and no-stall proof for concurrent turns.

## Comparability and growth

Compare only equal capacity identity, root-set scope, basis version, complete
coverage, no gap flag and available fields. A collector patch is comparable only when its
measurement semantics are unchanged; a basis change starts a new epoch. Unknown
allocation, unsupported identity, overflow, root changes and partial samples
create labelled gaps. Never interpolate across them. Reflink allocation is a
qualified charge, not exclusive physical usage or reclaimable space.

The observed rate is **observed endpoint change divided by elapsed
time** across the latest contiguous comparable Recent window, at most seven days.
Require five complete samples spanning at least 48 hours and no gap over
12 hours. Display signed decimal bytes/day, basis and interval:
“App allocation +120 MB/day observed over 3 days.” Negative values say decreased;
a flat observed window can show zero. Insufficient evidence cannot.

Capacity availability is a separate series. Other writers, retained objects,
filesystem overhead and delayed reclamation can change it independently of the
known-store union. Never label all capacity loss as App growth or all observed
post-operation gain as reclaimed by that operation.

### Qualified exhaustion scenarios

Compute depletion from **available capacity**, independently of the known-store
union. A capacity's total, identity, permitted-root scope and basis must match
throughout a window. Never use logical/allocated App growth to forecast capacity.

| Window | Evidence |
| --- | --- |
| Short | Recent points within seven days; at least five distinct endpoints spanning 48 hours; no interval over 12 hours. |
| Long | Completed Daily endpoints within 28 days plus the latest Recent endpoint; at least 15 distinct endpoints spanning 14 days; no interval over 48 hours. |

Deduplicate identical timestamps. The latest point must be the current complete
capacity observation and at most six hours old, with no future timestamp. Walk
back only through a contiguous compatible suffix: partial, unknown, gap, changed
identity/total/basis, invalid ordering or excess interval breaks the window.
Coarse gap flags reject incomplete daily buckets; weekly points never qualify.
The current day's provisional daily point supplies no extra evidence.

For each qualified window, observed depletion/day is `(first.available -
last.available) / elapsedDays`. Require at least two-thirds of intervals to
move in the net direction (flat intervals qualify), and no single interval's
absolute change to exceed half the absolute net change. This rejects a lone
burst/cleanup and inconsistent reversals; it does not establish statistical
accuracy. A perfectly flat window qualifies as non-depleting. A mixed window
with zero net change is unavailable. A smoothly replenishing qualified window
also reports **No depletion observed**, without a numeric exhaustion horizon.

For positive depletion, horizon is `latest.available / depletionPerDay` in days,
with finite arithmetic. Keep exact values for severity comparisons; round only
copy. Zero available bytes can yield zero days. Qualified non-depleting evidence
is distinct from missing/incompatible evidence and may satisfy forecast recovery;
it never says unlimited space or guarantees a write will fit.

Show both labelled window scenarios and their actual intervals. If both finite
estimates differ, show their min–max range with “If these observed rates continue.”
If one is unavailable, show the other with the missing window's reason; a sole
projection can trigger Low, never forecast-driven Critical. If one is
non-depleting and the other positive, show the finite scenario and “No depletion
observed in the other window,” not a numeric range to infinity. Rapid acceleration
may remain underpredicted: capacity thresholds and owner refusals remain independent.
No probabilistic confidence, countdown promise or causal cleanup-savings claim.

## Low-space states and hysteresis

Evaluate each resolved capacity independently. Fresh means a complete trustworthy
observation no older than six hours. Unknown capacity has no inferred percentage,
zero meter or healthy verdict. Preserve warning age when evidence goes stale.

| State | Entry | Copy/action |
| --- | --- | --- |
| Unknown | Missing trustworthy total/available/identity | “Capacity unavailable. Refresh or inspect host capacity.” |
| Observed | No active cause | “Capacity observed … ago.” No promise an operation fits. |
| Low | Available at or below 10%, or either qualified finite scenario at or below 30 days | “Low space. Review capacity and observed trends.” |
| Critical | Available at or below 5%, both finite scenarios at or below seven days, or an owner-confirmed no-space refusal | “Very low space. Some writes may be refused.” |
| Stale | Current evidence older than six hours | “Refresh before planning maintenance.” Preserve active warnings. |

Track causes separately within a capacity episode; never clear one cause using
another cause's unrelated evidence. Worsening takes one qualifying observation.
Recovery takes two successive qualifying fresh observations at least 60 seconds
apart; intervening failure, incompatible evidence or reversal resets that pair.
Critical drops to Low first; two additional observations are needed to clear Low.

- Capacity recovery: above 7% to leave Critical; above 12% to leave Low.
- Forecast recovery: to leave Critical, at least one qualified scenario beyond
  ten days (or qualified non-depletion) breaks the two-scenario Critical condition.
  To leave Low, both must be qualified beyond 45 days or non-depleting. Missing
  evidence cannot be the recovering scenario.
- Refusal recovery: require a subsequent owner-reported successful write in the
  same affected target and resource class, after the last refusal, plus the two
  fresh above-7% observations. No synthetic write probe, empty-file test or
  disappearance of the failing operation establishes recovery. Unresolved quota,
  inode or unknown-target refusals stay explicit until the owning operation can
  provide matching recovery evidence. After downgrade, the capacity Low rule
  still applies. A new refusal resets recovery.

Every active cause must satisfy its own exit rule before severity falls.
Clock reversal, unknown/partial/stale data and scope changes cannot clear an
old episode. A changed scope is Unknown; retain the unresolved prior episode
as requiring inspection, without transferring its measurements into the new scope.
Explicit Refresh can provide the recovery pair without extra background scans.

## Indicator and Critical Web Push

Storage shows capacity-specific evidence; a persistent app indicator shows the
highest active severity and opens Storage. Neither adds a main destination or
shortcut. Unknown/stale state is labelled, never silently green. Storage and the
indicator remain usable without push permission. Repeated scans update the same
state without repeated assertive announcements; explicit Refresh announces its
completion once politely. Critical text is associated with the capacity heading.

Use only existing authenticated, opt-in **owner** Web Push subscriptions, with
revocation rechecked at dispatch. Ordinary content readers and agents must not
receive operational information. Send at most one successful transport submission
per Critical episode/subscription; no daily reminders initially. An episode starts
on entry to Critical and ends only after confirmed downgrade. A later re-entry is
a new episode. Persist episode and destination receipt identities across restarts.
Bound episode state to the four tracked capacities; purge retired episodes after
all pending delivery is terminal, retaining active and latest resolved identity
per capacity. Destination rows cannot outlive their existing subscription.

Use a unique durable `(episode, subscription)` intent before transport. Cap all
attempts at three per pair, with retry delays of one and five minutes only for
known non-delivery/rejection. An ambiguous timeout or crash after dispatch is
**unknown**, not a reason to resend; expose that delivery state in Storage.
No exactly-once device-display claim: push transport acceptance is not delivery.
A browser notification tag derived from the opaque episode coalesces replacement
at the destination, but is not used to justify duplicate server submissions.

All attempts respect device-local **[22:00, 08:00)** quiet hours, without refusal
exceptions. Use authenticated timezone reporting; an absent/invalid zone keeps
delivery pending without guessing. Recompute eligibility after timezone/clock
changes. When eligible, revalidate current owner access, subscription, active
Critical state and fresh supporting evidence. A stale/unknown warning stays
visible but sends no push until refreshed; confirmed recovery suppresses pending
notices. Coalesce multiple eligible capacities into one generic notification,
recording every included episode's receipt. No backlog replay or new scans solely
for delivery. Contents say only “Storage needs attention. Open Storage for details.”
Do not expose capacity IDs, amounts, paths or filenames on a lock screen.

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
Capacity scenarios: 18–42 days
If observed rates continue
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
[View observations] Shared extents may overlap · Capacity scenarios 18–42 days
If observed rates continue · Short 3 days / long 21 days
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
rules offline using Odysseus observations anchored to 2026-07-12. It is
not production history, implemented runtime or a benchmark.

| Trace | Required interpretation |
| --- | --- |
| Steady growth, 13 samples over three days | Signed rate; no long-window scenario until its evidence minimum is met. |
| Burst then steady size | Signed rate; burst-dominated depletion window yields no projection. |
| Reclamation | Negative observed change; no causal savings claim. |
| Capacity/root change | New epoch; old observations cannot supply a rate. |
| Partial/unknown midpoint | Break the window; too little new evidence means no rate. |
| Retained-only pressure | Low/Critical plus no eligible cleanup; capacity provision is legitimate. |
| Concurrent unowned writer | Capacity falls while store usage is flat; do not attribute loss to App. |
| Year of six-hour observations | At most 64/90/32 slots; weekly history reaches approximately seven months without extra scans. |
| Missing interval inside a daily/weekly bucket | Sticky gap survives replacement by a later complete endpoint. |
| Long outage | Empty periods remain empty; age-expired buckets disappear without catch-up scans. |
| Threshold oscillation | Worsen immediately; clear only with two qualifying observations 60 seconds apart. |

The experiment checks maximum-width numeric tuple encoding for four capacities,
the 186-record payload ceiling, all tier caps and seven-month weekly reach. It
also checks forecast windows, burst/reclamation rejection, divergent scenarios,
missing evidence, direct warnings, cause-specific recovery, refusal evidence and
restart/deduplication/quiet-hours suppression with a deterministic local model.
These traces qualify rules, not real-world forecast error bounds or transport
reliability. Implementation issues require genuine runtime/browser/migration proof
and physical SQLite/WAL measurements. No fixture sends a notification.

## Implementation boundaries

Server history/state/delivery and UI guidance are separate native children of
#1779, after this design spike. The server issue owns migration, bounded payload
and receipts, authoritative owner checks, shared scan coalescing, timers,
cancellation, recovery and versioned HTTP/config contracts. The UI issue owns
history tables/charts, labelled scenarios, persistent indicator, accessible
capacity guidance and notification navigation. Initial pane delivery is #2013;
these additions must not introduce an incomplete public pane before it.

Remote/provider usage needs an authenticated provider-specific scope/quota
contract. Host/container stores need explicit owner-approved roots and safe
measurement evidence. Per-file Git attribution needs a bounded meaningful model.
Derivative grouping needs provenance. Workspace cleanup needs its own lifecycle
and use-case ruling. New journal/history/backup expiry needs an explicit loss
and recovery ruling. Pressure does not authorize any of them.

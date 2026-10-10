# Durable Queue and Action storage

The UI operational database holds durable work separately from Activity's
notification inbox. Migration `021_inbox.sql` adds the storage described in
[the asynchronous collaboration decision](decisions/async-collaboration.md).
Markdown remains content authority; the disposable `brain.db` index holds
none of these records.

The concrete internal `src/inbox/store.ts` receives server-validated commands.
It has no package-root export, HTTP route, scheduler or model caller. The drain
loop, effect application and budget admission consume this substrate in their
own implementations.

## Writes and state machines

`ingest()` derives trust from the authenticated intake source: CLI is trusted,
share is untrusted. The database forbids changes to thread identity, source,
trust and creation time. A duplicate dedup key returns the existing item and
updates the thread's last-seen time, including after a tombstone. It cannot
promote an untrusted arrival or recreate removed work.

`commit()` composes guarded mutations in one immediate SQLite transaction.
Callers compose the claim, reservation, checkpoint, blocking Action or
resolution follow-up needed for their operation; a late failure rolls back
all of them. Queue and Action transitions have separate closed tables.
Actions never acquire leases. Queue claims increment attempts and require a
future lease within the item's attempt limit. Selecting due work, validating
lease expiry and deciding retry backoff belong to the drain loop.

Item scheduling, expiry, leases, attempts and block references have queryable
columns alongside their serialized projections. Every item/projection write
emits a frozen change payload with explicit thread scope. Each change advances
both the global cursor and that thread's sequence. Removal requires a terminal
item, emits a tombstone and retains audit rows and sequences. A thread can be
removed only after its items have been removed.

`snapshot()` reads threads, items, per-thread high waters and the global cursor
in one read transaction. Replaying `changesSince(cursor)` onto that snapshot
reconstructs a later snapshot. Old changes never join today's mutable rows.
`orderedItems()` computes priority at read time with the injected clock:
`4*stakes + 3*deadline_urgency + min(age_days,5) - min(attempts,3)`.
Stakes are clamped to 1–3; urgency uses strict 24-hour, 72-hour and seven-day
boundaries. Display order is descending score, then oldest creation time,
then bytewise item ID. Admission owns any eviction ordering.

## WebSocket replication

`createApp()` connects the internal store to its authenticated WebSocket.
Subscribers explicitly select Queue or Actions, optionally filtering an existing
thread. Each subscription starts with the store's transactional snapshot;
the shared change scan never moves past pending work for an older subscriber.
Polling while subscribed reads frozen deltas from every database connection.
Reconnect starts a new snapshot, including retained tombstone high waters.

Snapshot rows and sequence entries are chunked within the transport byte cap.
Whole records survive replication; an oversized individual record fails
explicitly. Delivery rechecks the server-owned principal, including revocation
or expiry written through another connection. Socket/app close, revocation and
unsubscribe release listeners; an idle stream keeps no poller alive. The
[wire contract](integration-contract/wire.md#durable-queue-and-actions-additive)
defines view filtering, continuation merging, errors and limits.

The stream reads operational state only. It does not apply a selected effect,
start work or grant authority to an item's Activity run identifier.

## Checkpoints and lazy compaction

Run checkpoints are append-only. Their full text and structured decisions,
operation descriptions, server-recorded capability identifiers, touched paths
and open questions survive independently of the bounded narrative projection.
These retained facts are audit data; replaying them never grants authority.

Appending a checkpoint clips the projection to 4096 UTF-8 bytes at a code-point
boundary and persists a compaction-pending flag on overflow. `projectionForRun()`
only reads the projection, pending flag, sequence and retained facts. The next
already-admitted model-bearing use incorporates compaction into its existing
call. It commits the resulting bounded summary with the expected projection
sequence; intervening checkpoints reject a stale summary. Compaction appends
another checkpoint and clears the flag without replacing history, facts,
source or trust. The store starts no inference call.

## Recovery records and ownership

| Record | Invariant and owner |
| --- | --- |
| Resolutions | One write-once row per Action, with principal, selected option and validated frozen v1 effect. The effect engine composes the transition and deterministic follow-up dedup key in the same transaction; storage executes no effect. |
| Action contexts | Immutable server-selected class/evidence/suppression/source context and the canonical stored option set, retained for strict resolution and compensation. |
| Suppressions | One record per class, with evidence boundary, expiry and re-raise condition; admission owns matching and expiry. |
| Scheduler heartbeat | One record per scheduler name, with last tick and processed change cursor; the drain loop owns updates. |
| Budget reservations | Unique operation key, item/attempt/purpose/run identity, principal/model/billing mode, admission day, normal/emergency bucket, reserved dollars/turns, observed cost and final charged dollars/turns. Budget admission owns limits, unknown-cost policy and recovery decisions. |

Reservations start active and settle or release once. A settlement cannot
discard observed spend. Confirmed subscription records carry zero dollars;
actual API billing evidence overrides an expected subscription classification.
The [budget ledger](inbox-budget.md) adds admission-time pricing snapshots,
single backend acquisition and frozen settlement in migration `024_inbox_budget.sql`. The admission day remains fixed even when settlement
happens on another day. Missing pricing, ceilings, fallback models and Action
creation are budget policy rather than implicit storage behavior.

`exportState()` takes one consistent read of the inbox audit tables, including
deleted projections, checkpoints, resolutions, sequences and reservations.
Migration `027_inbox_actions.sql` adds retained Action contexts to that export.
The [Action engine](inbox-actions.md) composes these records with guarded
transitions and performs filesystem compensation after database commit.
Reopening the same UI database recovers these records. The supported
[operational recovery command](inbox-recovery.md) packages the whole UI database
with staging bytes, including principal identities and Activity spend receipts;
this audit method alone is not a complete backup.


Intake adds `inbox_intake_receipts`: server-owned source/principal/content
identity, the canonical staging result, and preparation/cleanup recovery records.
A receipt is journaled before file writes; creating work and committing its
receipt are one database transaction. Committed provenance is immutable and
survives principal pruning. Intake never creates a lease/claim or dispatches
work. Boot and subsequent intake compensate abandoned preparations after an
hour, while committed staging IDs are protected from legacy share TTL pruning.
The audit-only export includes these receipts; it still excludes staging bytes
and is not a backup. See the [HTTP intake/recovery contract](http-api.md#authenticated-cli-intake-additive-679).

## Hygiene review revisions and dispatch journal

Migration `036_hygiene_review.sql` adds one durable review projection,
append-only confirmed option revisions and a journal of hygiene CLI attempts.
These records belong to the UI operational store and its backup/export, never
`brain.db`. Hygiene Actions still use `inbox_items`, versioned upserts and the
shared resolution records. Original Action contexts remain immutable; each
server-produced preview/outcome revision freezes the current strict options.
The resolver compares against the latest immutable revision for hygiene only.
One unfinished attempt per Action serializes asynchronous CLI dispatch across
connections. Recovery rechecks the original finding/fingerprint without
replaying the repair. The documented HTTP read exposes review counters across
reloads/devices; the existing inbox stream exposes Action outcomes.


Explicit hygiene Refresh atomically replaces a changed-fingerprint pending card.
The old card retains its finding/effects and a `superseded` outcome naming the
replacement, with terminal `dropped` status. No resolution row, cap suppression
or Markdown disposition is added. The current pointer and both replicated cards
commit together; review position and counters are preserved. Operational backup
validates that each superseded receipt names its actual same-finding, changed-
fingerprint replacement; missing, self or foreign references refuse. See the
[human-review contract](integration-contract/package-api.md#human-started-hygiene-review-additive-1027).

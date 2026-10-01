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
[wire contract](integration-contract.md#durable-queue-and-actions-additive)
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
| Suppressions | One record per class, with evidence boundary, expiry and re-raise condition; admission owns matching and expiry. |
| Scheduler heartbeat | One record per scheduler name, with last tick and processed change cursor; the drain loop owns updates. |
| Budget reservations | Unique operation key, item/attempt/purpose/run identity, principal/model/billing mode, admission day, normal/emergency bucket, reserved dollars/turns, observed cost and final charged dollars/turns. Budget admission owns limits, unknown-cost policy and recovery decisions. |

Reservations start active and settle or release once through the store. A
settlement cannot discard observed spend, and subscription records carry zero
dollar reserve/charge. The admission day remains fixed even when settlement
happens on another day. Missing pricing, ceilings, fallback models and Action
creation are budget policy rather than implicit storage behavior.

`exportState()` takes one consistent read of every operational table, including
deleted projections, checkpoints, resolutions, sequences and reservations.
Reopening the same UI database recovers these records. Backup and restore
orchestration owns packaging that export with the brain files and staging;
this method alone is not a complete backup.

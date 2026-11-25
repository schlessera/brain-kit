# Storage history and pressure evidence

The UI server retains aggregate observations in its operational database,
separate from disposable `brain.db`. The [approved policy](decisions/storage-guidance.md)
and [named HTTP contract](http-api.md#storage-history-and-pressure-guidance)
bind collection, qualification, recovery and delivery.

## Collection and cost

There is no inventory scan at boot, on a history/status read, or on a worker's
hot path. A running server attempts the next six-hour UTC boundary using a
currently usable human owner. A sleeping/restarted server does not replay missed
buckets. Explicit Refresh and existing operation measurements share the same
collector. A SQLite lease coalesces concurrent app processes; it does not lock
out file writers. The observation remains a live, non-atomic view.

All three history tiers use that one collection: 64 recent six-hour endpoints,
90 daily endpoints and 32 Monday-based weekly endpoints. Current daily/weekly
slots are provisional endpoints, not averages. Actual times, gaps, partial
coverage and changed scope remain visible. Weekly points never supply forecast
evidence. Unknown private owners, incomplete coverage or changed capacity can
prevent qualification even when direct available-byte warnings remain usable.

One newest aggregate can wait in memory between history transactions, at most
one per minute. Intervening failures still break comparison/recovery. Pending
owner refusals are bounded separately in memory and are applied without being
erased by a newer aggregate. Repeated successes without a matching refusal do
not occupy that buffer. If distinct owner evidence exceeds its bound, the next
successful transaction durably marks it unknown; later scans and restores cannot
reconstruct the missing refusals or automatically clear that warning. Ordinary
inventory remains available. A crash can lose pending observations. A failed
SQLite write preserves the last valid durable payload and reports paused
history; it never deletes recovery data to gain headroom.

The canonical history payload is at most 256 KiB, including at most 40,960 bytes
of shared descriptors and warning state. This is not a physical SQLite bound.
Database pages, indexes, WAL and SHM are measured once with the existing
operational database inventory; do not add payload bytes to that total. A native
SQLite test records actual logical/allocated DB/WAL bytes separately from the
payload. Delivery receipts and the shared scan lease are additional operational
rows, also included in database inventory.

Ordinary collection retains its inventory in the existing bounded memory cache.
Only an overlapping caller in another coordinator requires a disposable private
file transfer. Its cache retains at most two serialized results, 48 MiB each,
with a two-minute transfer lifetime and bounded cleanup. This separate directory
appears once in App storage. Results are unavailable after expiration; a joined
request cannot trigger a duplicate collection just because transfer failed.
Reader subprocesses have deadlines and monitor the exact parent identity, so a
parent SIGKILL cannot leave an unowned reader. A replacement lease reaps exact
recorded process identities before collecting. An unkillable process leaves
collection unavailable rather than authorizing overlapping ownership. These
bounds do not promise recovery from arbitrary kernel/filesystem I/O stalls.

## Pressure and recovery

Available bytes trigger Low at 10% and Critical at 5%. Qualified conditional
scenarios use recent endpoints within seven days and daily endpoints within 30
days. Either scenario at or below 30 days until exhaustion triggers Low; both
at or below seven days trigger Critical. Each carries its actual evidence window.
Neither a projected range nor an observed rate is an accuracy guarantee.

Each cause must recover independently. Capacity recovery is strictly above
12%/7%; forecast recovery is beyond 45/ten days using the approved both/either
rule. Recovery needs two fresh observations at least 60 seconds apart. Critical
first becomes Low; clearing Low takes another pair. Failure, reversal, changed
scope or missing evidence cannot clear an unresolved cause. Measurements cannot
promise reclaimed bytes or authorize retention changes.

Existing owning operations can report actual no-space refusal and matching
successful writes, without a probe write. Retained attachment capture and Undo
report structured filesystem/owner errors; Git packing uses its structured core
result. An undifferentiated ENOSPC remains an unknown resource, since byte and
inode exhaustion cannot be inferred from that code alone. Worker packing cannot
identify a host mount, so its unresolved target stays explicit. Quota, inode and
unknown-resource refusals remain unresolved when no matching capacity evidence
exists. This does not claim every app write already emits refusal telemetry.

## Critical notices

Storage uses existing opt-in, owner-bound Web Push subscriptions and authenticated
timezone reports. Every dispatch rechecks authority, current subscription keys,
fresh supporting evidence, episode and local quiet hours. Unknown timezone defers;
strict 22:00–08:00 applies even to an owner refusal. There are no daily reminders
and no collection solely to send a notice. One generic notice can cover several
eligible capacities without exposing IDs, paths, amounts or filenames.

A durable unique episode/subscription intent precedes transport. Known rejection
permits at most three attempts, after one and five minutes. Timeout, interruption
or a process crash after dispatch leaves unknown delivery and is not retried.
Transport acceptance does not establish device display. Existing subscriptions
own destination retention; receipts retain active/latest resolved episodes and
are purged with obsolete episodes or subscription deletion.

Operational export includes history, episodes and receipts. Restore suppresses
all old episode delivery authority, clears collection leases and requires fresh
evidence. It does not restore content files, replay a notice or perform cleanup.

## Events timeline

The UI server also records a bounded events timeline in the operational
database, in the `storage_events` table ([HTTP contract](http-api.md#storage-events-timeline)).
Each event is written in the same transaction that changes the state it
describes: warning starts, severity steps, recovery attempts and ends, and
owner refusals and scope changes in the history flush; maintenance requests and
finishes in the receipt write. Its time is that of the observation, owner report
or receipt, so a slow flush never moves a start. Owner reports buffered for one
write keep the time of their first refusal through coalescing. Pressure
state applies them in buffer order, exactly as before the timeline, so support
times and notice eligibility are unchanged; only the events use the first
refusal times. Scope events
chain from the last scope each capacity was observed with, tracked in
`storage_event_scopes` for at most 16 capacities per brain, because a warning's
pressure keeps its original scope until fresh evidence arrives.

The limits are fixed per kind: 256 pressure, 128 refusal, 64 scope and 512
maintenance events per brain. Their worst-case encodings (187, 195, 228 and 323
bytes) total 252,800 bytes, so a full response fits the 262,144-byte cap;
`STORAGE_EVENT_LIMITS` in `packages/ui-server/src/storage/events.ts` carries
the arithmetic. A full kind stops recording and reports `paused`. No event is
updated or deleted, and pausing never blocks the history, pressure policy or
maintenance. Episodes already open before this table existed are not emitted.
Operational export and restore carry the table like the history.

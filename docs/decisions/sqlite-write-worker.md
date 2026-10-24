# SQLite commits off the event loop

Ruling 1 on [#2789](https://github.com/schlessera/brain-kit/issues/2789), built
in [#2814](https://github.com/schlessera/brain-kit/issues/2814).

## What was wrong

The hosted server committed every turn-journal, Activity and native-lease write
on its event loop at `synchronous=FULL`. A FULL commit waits for the WAL's
fsync. On an idle disk that is a few milliseconds; with three `dd … conv=fsync`
writers on the same filesystem it measured 230–730 ms. While the loop waits,
`/api/health` and WebSocket pings wait too, which is the
`HOSTED_ADMISSION_HEALTH_WITHIN_1_SECOND` failure of
[#2416](https://github.com/schlessera/brain-kit/issues/2416). The lag windows
held only a few milliseconds of CPU samples: the time was spent in fsync, not in
accounting.

The commit is the durability guarantee, so it stays. What changes is which
thread waits for it.

## What we do

- **One write worker per database file.** `openSqliteWriter`
  (`packages/ui-server/src/db/write-worker.ts`) starts a Bun worker thread that
  opens its own connection at `synchronous=FULL`. `bun:sqlite` connections are
  per thread, so the worker never shares the app's handle. The app connection
  keeps every read; WAL lets those proceed while the worker commits.
- **Writers move as code, not as SQL replay.** Each writer registers a
  procedure module on the worker: the journal store
  (`packages/ui-server/src/brain/journal-store.ts`), the Activity store's writes
  (`packages/ui-server/src/activity/store-writes.ts`) and the native lease store
  (`packages/ui-server/src/brain/native-lease-store.ts`). A procedure is the
  transaction body that used to run inline, with its reads inside the same
  transaction. The journal's procedures run through the unchanged
  `createJournalAccounting`, so capacity accounting is exactly what it was.
- **Submission order is commit order.** The worker runs one call at a time, in
  arrival order, and every call is posted synchronously when it is made. The
  journal additionally routes every call through its startup-recovery promise,
  so nothing overtakes recovery.
- **FULL is enforced, not assumed.** The worker refuses a transaction whose
  connection is below FULL just before it commits, which rolls it back, and
  reports an autocommit statement that ran below FULL. Journal writes still set
  FULL themselves.
- **App transactions and worker procedures take turns.** Two connections in
  one process writing one WAL file misbehaved under fsync load. The first
  native runs refused governed turns with `database is locked`: an app
  `BEGIN IMMEDIATE` returned SQLITE_BUSY after about 37 ms despite a 5 s busy
  timeout, while the worker was committing. Separately, a deferred transaction
  that reads and then writes can lose its snapshot upgrade to a worker commit.
  So every outermost transaction on the app connection waits until the worker
  is between procedures, through a lock shared with the worker thread
  (`takeTurns`). The worker likewise waits, and lets a waiting app
  transaction go first. Each transaction keeps its own mode, so a read-only
  deferred snapshot never takes the write lock. Making every app transaction
  immediate was tried and rejected: it held the write lock through read-only
  snapshots, and the inbox's foreign-writer convergence test failed.
- **Further database files join the same connection.** `openSqliteWriter(db,
  { attach })` attaches each file to the worker connection and checks FULL on
  all of them before every commit. That is how the worker owns the journal's own
  `journal.db` (ruling A on
  [#2789](https://github.com/schlessera/brain-kit/issues/2789)), while journal
  procedures still reach `governance_events` in the UI database.
- **A turn waits for its Activity writes.** The recorder keeps a turn's writes
  in call order and exposes `settled()`. The session slot awaits it before it
  ends, and an autonomous turn awaits it before the transaction that releases
  its lifetime and commits its terminal, so that terminal still commits inside
  the transaction.
- **Refusals keep their class.** `JournalCapacityError`,
  `JournalStorageUnavailable`, `JournalStatementRefused` and
  `NativeBrainManagerError` are rebuilt on the event loop with their message and
  fields, so `retain()` collection retries, `journal_capacity` and
  `journal_unavailable` work as before.
- **Callers await what they need.** Journal methods that wrote synchronously
  now return promises: `bindSession`, `bindModel`, `writeOperation` (which now
  takes statements), `persistClaudeMemory`, `recordClaudeMemory`,
  `reserveRevert`, `finishReserved`, `withRetainedRemoval`,
  `withRetainedVersion` and `version().stream()`. Turn revert `start` and
  storage removal `start`/`cancel` follow. `createTurnJournal` exposes `ready`,
  which the app awaits before serving.

## The exceptions

- **A write inside the caller's transaction runs there.** The session catalog
  writes title and unstreamed-usage spans inside its own transaction on the app
  connection. The off-loop Activity store sees `db.inTransaction` and runs that
  write synchronously on the caller's connection, so it stays atomic with the
  caller's rows. That commit is the caller's, on the event loop, as before.
- **The in-memory database has no file** for a second connection. Its writer
  runs the same procedures inline, in the same order, behind the same promises.
- **Rollup pricing in the worker** reads the same on-disk table and bundled
  snapshot as the app's pricing instance and reloads the table whenever the
  app's refresh replaces it. A refresh whose cache write failed leaves the
  worker on the previous table until the next successful write.
- **Other app-connection writers stay on the loop**: governance events written
  outside a journal transaction, the writer gate, turn budgets and scope, the
  session catalog, inbox and settings. Each commits at FULL on the loop, and
  while a worker procedure holds its turn, such a write also waits there for
  the worker's commit to finish. Those writers are tracked separately
  ([#2850](https://github.com/schlessera/brain-kit/issues/2850)).

## Rejected

- **Committing at `synchronous=NORMAL` and syncing the WAL afterwards off the
  loop.** It would reach the same durability by the time the caller proceeds,
  but it is a different durability level per commit, which the ruling excludes.
- **Replaying recorded SQL in the worker.** Journal transactions read what they
  are about to write (capacity measurement, conflict detection, guards), so a
  replay could commit a decision taken against a different database state.
- **Synchronous RPC from the loop into the worker (Atomics.wait) with only the
  commit asynchronous.** Every statement would still block the loop, including
  `BEGIN IMMEDIATE` and the journal's measurement under the same I/O pressure.

## Testing note

Bun 1.4.2's `expect(promise).rejects` and `.resolves` wait in a nested event
loop that does not deliver every worker or port message. An assertion on a
promise that needs a write-worker round trip posted during that wait never
settles. The same holds for a
`MessageChannel` port in the cases measured. Tests use `expectRejection`
(`packages/ui-server/tests/helpers/expect-rejection.ts`) or a plain `await`
instead; production code never waits that way.

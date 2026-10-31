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
  ends or sends its final recovery notification, after releasing turn authority.
  Otherwise a client can read before the terminal rollup commits, retain a
  completion without its host times, and never learn that the commit finished
  (#2900). An autonomous turn awaits it before the transaction that releases
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
- **Memory records take their turn beside observations.** Once commits await,
  an observation reads a turn's last sequence before its commit and stores the
  result after it, and `finish` can end a turn while a memory save is still
  committing. `persistClaudeMemory` and `recordClaudeMemory` therefore run in
  the journal's observation order: a save requested before `finish` is recorded
  before the turn ends, one requested after is refused before it saves, and a
  record never reuses a sequence an observation is committing.

## The exceptions

**Journal object-pin index (#2913).** The journal worker builds the hash index
through an admitted runtime upgrade rather than an unconditional startup SQL
migration. The write lock covers its storage allowance, in-memory build,
measured page/WAL checks and FULL commit. A refused build leaves the existing
foreign-key-checked collection path available; collection retries after freeing
bytes. An index's schema entry commits atomically as its completion receipt, so
restart and competing openers are idempotent. The cap, retention and ordinary
foreign-key enforcement remain unchanged. The full rationale and near-cap rule
are in [the governed-workers decision](governed-writable-workers.md#admitted-object-pin-index-and-near-cap-recovery--2026-10-26-2913).

- **A write inside the caller's transaction runs there.** The off-loop
  Activity store sees `db.inTransaction` and runs such a write synchronously on
  the caller's connection, so it stays atomic with the caller's rows. Claude
  usage accounting, which writes title and unstreamed-usage spans inside its
  own transaction, now runs that whole transaction on the worker, with a store
  on the worker's connection (`workerActivity`,
  `packages/ui-server/src/activity/store-writes.ts`).
- **The in-memory database has no file** for a second connection. Its writer
  runs the same procedures inline, in the same order, behind the same promises.
- **Rollup pricing in the worker** reads the same on-disk table and bundled
  snapshot as the app's pricing instance and reloads the table whenever the
  app's refresh replaces it. A refresh whose cache write failed leaves the
  worker on the previous table until the next successful write.
- **Governance events and turn scope moved next**
  ([#2850](https://github.com/schlessera/brain-kit/issues/2850)). Every
  governance event raised outside a journal transaction, the session's first
  taint, roadblock classification and turn scope rows commit on the same
  worker (`packages/ui-server/src/governance/event-writes.ts`,
  `packages/ui-server/src/brain/turn-scope-writes.ts`). An event is validated
  and its clock taken where it is raised. Three reads that followed those
  writes now wait for them: a connection's first byte waits for its taint's
  commit, while admission counts a taint from submission; a scope decision
  runs only after the turn's earlier scope writes commit, and settles after
  its own; and a turn's outcome waits for its egress records. The scope
  summary the client hears of is sent once its row commits. A process without
  a write worker, such as the cron runner, runs the same procedures on its own
  connection.
- **Turn budgets followed** (#2850). Every ledger write (admission,
  session binding, completed-response and relayed-provider observations,
  warnings, the SDK backstop) commits on the worker, with the receipt it
  computes read inside the same transaction
  (`budgetLedger`, `packages/ui-server/src/brain/turn-budgets.ts`). A report
  is priced where it arrives, so the backend still gets the turn's list price
  at once; its warnings and any block follow the commit. A relayed provider
  request is admitted only after every budget write submitted before it has
  committed, and a turn's outcome waits for its budget writes.
- **The session catalog followed** (#2850). The session row, accepted work,
  turn boundaries, message sources, turn failures, the state room, Claude
  usage accounting, handoff links, labels and session costs commit on the
  worker (`packages/ui-server/src/ws/session-catalog-writes.ts`), and so do
  the two writes `session_info` makes that reference the new row: binding a
  draft's worker profile and recording the admitted one
  (`packages/ui-server/src/ws/session-profile-writes.ts`), and binding the
  turn's policy proposals (`packages/ui-server/src/brain/policy-proposal-writes.ts`).
  The worker's order puts each after the row it references. Readers see the
  catalog's writes in two ways. A synchronous read on the turn path (whether
  a session exists, its backend, provider and label, its latest accepted
  work, a session's worker profile and whether a draft is still unconsumed)
  answers from the committed row with every pending write's own effect
  applied, so a write counts from its submission, as it did when it
  committed inline. Each effect stops counting when its write settles, so a
  failed one stops at once. A reader that joins committed rows onto history
  (`publishHistory`, the session list and history routes, handoff sources,
  the policy proposal route) or reads retained retries first awaits
  `settled()` (`historySettled`, `packages/ui-server/src/ws/host.ts`). An
  acceptance's revision is assigned where it is accepted, one above the
  highest the catalog has issued or seen committed, so it is known at once
  and a failed write's revision is never issued again; only the newest
  acceptance's outcome orders or unorders the session. Retained retries
  followed on the worker as described below; a failure retained before its
  session's row has committed is stored once it has, unless an input
  invalidated it meanwhile.
- **The writer gate followed** (#2850). Acquisition, the turn-waiter queue,
  release, folder retention, peer-plan checks, the unpinned-host downgrade,
  the ungated host check and recorded type folders run their transactions on
  the worker (`gateProcedures`, `packages/ui-server/src/brain/writer-gate.ts`),
  each still `BEGIN IMMEDIATE`, so they stay serialized against the cron
  runner's gate, which commits on its own connection. One policy reader on
  the worker serves every observation the gate makes. A release is submitted
  at once, so every later gate write of the process sees it, and settles once
  it has committed; whatever promises the hold is gone (`withGate`, a turn's
  release, a launch's `settled`, shutdown) waits for it. A host process
  spawns only after its downgrade has committed, and only if the boundary is
  still the host fallback afterwards. A type folder translation that cannot
  be recorded refuses the turn. `holders()`, a diagnostic, still reads on
  the gate's own connection.
- **Authentication's per-request writes followed** (#2850). A principal's
  `last_seen_at` touch, terminal-principal pruning, ambient principal
  resolution and a login's new principal commit on the worker
  (`packages/ui-server/src/db/principal-writes.ts`). A touch is never waited
  for and one pending is not submitted again; an ambient principal that is
  current is read at once; a login answers once its row has committed, and
  its refusals keep their classes. Account administration uses the same worker,
  as described below.
- **Account and security administration followed** (#3002, within #2850).
  Delegated-principal creation and revocation, passkey registration, counters,
  labels and deletion, reference grants and the account partition seed commit
  on the worker (`packages/ui-server/src/db/account-writes.ts`). The existing
  transaction bodies and modes stay together; passkey deletion still commits
  before its credential's principal revocation. Revocation routes await both
  durable revocation and push unbinding before answering; client authority is
  invalidated as soon as revocation commits. Every authentication after the
  response sees the committed revocation. Delegated minting
  and reference grants recheck authority inside their original transactions;
  refusals keep their classes and HTTP statuses. Boot awaits the partition seed
  before constructing its synchronous key reader. Push subscription, removal
  and unbinding, and first-use VAPID creation run on the same queue
  (`packages/ui-server/src/activity/push-writes.ts`). Each VAPID caller checks
  for the stored pair on that connection, so racing delivery passes and the
  key route share one insert and its read-back. Delivery still joins devices
  to live principals while runtime unbinding is pending. Standalone callers
  retain the synchronous procedures on their own connection.
- **The Activity notifier followed** (#2850). Its tick (intent detection
  under its cursor and the stuck-run watchdog), delivery status,
  acknowledgement and retention, and push delivery's subscription
  bookkeeping commit on the worker (`packages/ui-server/src/activity/notify-writes.ts`).
  The tick runs the same notifier on the write connection, with who is
  watching taken where the tick was submitted, and its log records come back
  to the app's log; a tick still committing is not submitted again. A push
  delivery pass settles only once its bookkeeping and delivery status have
  committed, so the next pass never sends an intent again or retries a gone
  device. The inbox and the pending queue are still read on the app
  connection.
- **A governed turn's admission records followed** (#2850). The policy a
  turn was admitted under, what its provider was shown, its masked lineage
  and its protected-path manifest commit on the worker
  (`packages/ui-server/src/brain/governed-turn-writes.ts`). Admission awaits
  each before the turn goes on, so every record is still durable before
  anything it describes can happen; a manifest's quarantine moves files on
  the app thread and its close commits on the worker before `end()` settles.
  A read of a session's exposures (admission's continuation checks, a
  handoff's history check) first waits for every exposure write submitted
  before it. Boot reconciliation still closes abandoned manifests inline.
- **Local exchanges, classified blocks and saved worker preferences
  followed** (#2850). A local exchange commits on the worker with the
  catalog's other writes. Until it has, the next prompt handed over still
  takes it, exactly once, and the hand-over is recorded on the worker after
  the exchange's own record; the client is answered once it is stored. A
  turn's classified blocks, the blocks that follow a promoted link and the
  classifier's confidence commit on the worker
  (`packages/ui-server/src/classification/classification-writes.ts`), and a
  replayed history waits for every one submitted before it. A saved worker
  preference (`PUT …/profile`) is checked and stored in one immediate
  transaction on the worker, and its refusals keep their class and status.
- **Action notices followed** (#3000, part of #2850). Enrollment, digest
  generation and coverage, delivery attempts, zone reports and dismissals run
  the unchanged notifier on the write connection
  (`packages/ui-server/src/inbox/notify-writes.ts`). Each original transaction
  keeps its boundary and contents. A tick submits enrollment and generation
  together, in that order, and a tick still committing is not submitted
  again. The routes answer after their writes commit; push transport starts
  after its attempt and components commit, and the delivery pass settles
  after every attempt outcome commits. Clocks are taken at submission.
  `recordActionEpisode` remains inside the inbox store transaction that
  changes the Action; that transaction moves with the inbox lifecycle (#3001).
- **The inbox lifecycle followed** (#3001). Recovery and budget reconciliation,
  the lifecycle sweep, cleanup claims and acknowledgements, heartbeat, intake
  receipts and replay, interactive-share start/bind/end and application/completion
  receipts, and human hygiene review commit on the same worker. Their procedure
  modules live under `packages/ui-server/src/inbox/*-writes.ts`; each keeps its
  transaction's reads and mutations together. Concurrent store submissions assign
  change IDs and thread sequences on the write connection, so a rollback consumes
  no committed sequence. Intake answers after its receipt commits, a WebSocket
  decision pumps changes after its commit, and share tools queue behind their
  session bind. Share start settles before the backend starts; end settles before
  the turn releases its slot. The worker holds the share's disposable lifetime
  lock until end, so cleanup cannot remove its originals during unwind. File
  staging and application stay with the caller; share completion still verifies
  receipt-backed bytes under the application lock. Principal authority is checked
  again on the write connection. Standalone callers without a registered writer
  run the same procedures inline. Dispatcher-fixture-only claims, boot/restore
  helpers and the cron runner retain their synchronous connections.
- **Schedule route writes followed** (#3003, within #2850). Proposals,
  approvals, pending publication, activation or quarantine, cancellation and
  reconciliation commit on the worker
  (`packages/ui-server/src/schedules/service-writes.ts`). Each transaction
  keeps its reads and `BEGIN IMMEDIATE`; cancellation still invalidates
  unstarted occurrences and drops their Queue items and change records in the
  same transaction. Publication awaits its pending receipt, then checks Git
  and publishes the approved file, then awaits activation or quarantine.
  Cancellation awaits its ledger change before retiring the file, and marks
  retirement complete only after that file operation. A late publisher of a
  cancelled task journals and completes retirement again. Reopening awaits
  restored-root adoption and journal reconciliation before its own transaction.
  Every route reads its result after the relevant commits; schedule refusals
  keep their class, code and HTTP status across the worker. `rootInfo` still
  creates the root identity on the app connection during boot, before serving;
  the unwired admission service and cron execution retain their own writes.
- **Storage history and notices followed** (#2850). The storage history's
  first row and its bounded flush, and the notice sweep, a delivery's begin
  and its finish, commit on the worker
  (`packages/ui-server/src/storage/history-writes.ts`,
  `packages/ui-server/src/storage/notify-writes.ts`), each the transaction
  that ran inline. Observations and owner reports stay buffered in the app
  until a flush commits them; a flush requested while one commits runs once
  after it. The 20-second sampling tick submits its flush and sweep without
  waiting, and never overlaps one still committing. A delivery's begin takes
  the process's buffered history state from where it was submitted and reads
  the durable history under its own transaction, so a newer observation
  another process committed meanwhile counts. The storage history and
  guidance views read once every flush submitted before them has committed.
  Push transport awaits begin and finish; shutdown awaits the final flush. Operational restore still
  writes inside its caller's transaction.
- **Storage scans and maintenance followed** (#3028, part of #2850).
  Shared scan acquisition, reaping, collector registration and unregistration,
  cancellation and completion commit on the worker
  (`setup`, `packages/ui-server/src/storage/shared-scan-writes.ts:30-107`). The lease commits
  before collection starts; collector bookkeeping settles before the process
  wrapper returns, and completion commits before the coordinator serves its
  result. Maintenance insertion, receipt updates and cancellation use the same
  worker (`setup`, `packages/ui-server/src/storage/maintenance-writes.ts:8-39`). Routes await
  their durable receipts; staging cleanup awaits each item's intent before
  removal, and cancellation commits before aborting its owner. Receipt readers
  wait for submitted writes, and refusals retain their class and status. Without
  a writer, the same procedures still run synchronously on the caller's
  connection. Storage removal already commits through the journal worker;
  operational restore still writes inside its caller's transaction.
- **Retained retries and policy proposals followed** (#2850). Retry saves,
  invalidations, refusal receipts and reservations commit on the worker
  (`packages/ui-server/src/ws/session-catalog-writes.ts`). An invalidation
  hides the retry from synchronous reads as soon as it is submitted and
  stays in force even if its delete fails; the worker refuses any later
  reservation of that obsolete request. The failure is reported, and only a
  successfully retained new request resets the invalidation. That memory does
  not survive a restart, so a reservation also refuses once the session's
  accepted work (`session_work`) names a later request than the retained
  turn (`reserveRetry`, `packages/ui-server/src/ws/retry-requests.ts`). A reservation
  keeps its receipt and eligibility consumption in one immediate transaction,
  awaited before its receipt is sent or its prompt dispatched; a duplicate
  receives the receipt without dispatching again. A pending session row still
  precedes the retry that references it, while Retry is advertised at once.
  Proposal inserts and review saves commit on the same worker
  (`packages/ui-server/src/brain/policy-proposal-writes.ts`). Approval waits
  for insertion, and policy publication waits for the writing review's
  commit, so a crash leaves an unknown receipt and never repeats the write.
  Reviews are emitted after their saves commit; history and receipt readers
  await `settled()`, which includes inserts, saves and binds. Without a
  writer, the same procedures run inline on the caller's connection.
- **Drafts, voice transcription claims and settings followed** (#2850).
  Composer save, upload, remove, bind and accept run their unchanged
  transactions on one worker channel (`packages/ui-server/src/drafts/writes.ts`).
  The routes answer committed revisions. Accepted messages submit their
  draft tombstone without waiting or blocking the turn; failures log identity
  only. Later draft mutations follow that acceptance in FIFO order, and the
  list/get routes await every previously submitted draft write before reading
  on the app connection. Draft refusals keep their class, status and body.
  Transcription claims, completions and removals commit on the worker
  (`packages/ui-server/src/voice/transcription-writes.ts`); a provider is
  dispatched only after its claim commits, so duplicate claims cannot dispatch
  twice. Authorization runs there too, including any lazy account-partition
  seed insert, and refusals keep their class and receipt. Startup recovery
  remains inline. One settings writer (`packages/ui-server/src/db/settings-writes.ts`)
  owns hosted model preferences, remembered tool grants, digest visits,
  dismissals and generation, and subscription proof retention (the hourly
  check, status reads and successful-turn recording). A turn's `settled()`
  also waits for its submitted subscription proof. Digest generation
  keeps its whole immediate transaction, and settings consumers await the
  commit before their dependent reads or replies. Without a writer, the same
  operations still run inline, including the cron digest job; the notifier's
  cursor and the unhosted detail-retention setter keep their existing paths.
- **Reference sources and managed worktrees followed** (#2999, part of #2850).
  Checkpoint ownership, worktree allocation, grants, renewal, release, generation
  boundaries and cleanup receipts, reference-source publication and leases, and
  hygiene findings commit on the same worker (`packages/ui-server/src/brain/reference-writes.ts`
  and its three procedure modules). Each transaction keeps its SQL, statement
  order and mode; no Git or filesystem read was split out of a transaction.
  Pool, Git and filesystem operations stay on the app thread. The checkpoint
  ledger also runs there: it awaits ownership before creating each observation
  checkpoint, including the 15-second scope observation, and awaits forgetting
  it after release. A lease or grant answers only after its commit; a generation
  commits before workers bind it; release and close settle after their receipts.
  Source leases protect against eviction before awaiting, and revocation waits
  for earlier publication receipts before selecting the sources to withdraw.
  `live()` and removal's `authorize()` stay inside the per-worktree serial queue,
  immediately before submission; the queue stays held until the commit. Every
  end effect on that worktree (release, generation close and removal) takes the
  same serial queue and then the worker FIFO, so a renewal or release whose
  check passed is ordered before the end's effects as it was inline. A failed
  check still changes nothing. Generation close holds its worktrees' queues
  through parking and its unchanged transaction; removal's authorization has
  the same ordering relative to later work on that worktree. Callers without a
  registered writer run the same procedures inline. Boot-only source recovery
  retains its inline catalog writes.

## App shutdown ownership

The app registers failed-boot cleanup as soon as it acquires its shared writer.
Ordinary shutdown drains borrowers before closing the writer, then closes the
reader. Borrowed journals close their own channel without closing that writer.
The writer awaits its database-close acknowledgement and invokes Bun worker
termination; this is not a production thread-join guarantee.

### Bounded caller waits retain real cleanup ownership (#3185)

A storage operation may never return from native I/O. During application
cleanup, the app observes real outstanding native requests on both its shared
UI/journal writer and its separate native-lease writer
(`guardSqliteCleanup`, `packages/ui-server/src/db/write-worker.ts:206-234`).
Request identities and settlement remain local to each concrete writer; one
writer becoming idle cannot clear another writer's deadline. Native manager
RPCs are not SQLite requests and do not acquire this deadline.
Each native request already pending when close begins gets ten seconds;
requests submitted during cleanup get that budget from submission. It includes
FIFO queue wait. Expiry rejects the caller with
`StorageSettlementIndeterminate` but leaves the original cleanup FIFO running.
There is no whole-application wall-clock deadline. Protected CLI writers may
outlast the ten-second CLI grace and still finish; a healthy shared read canceled
at the end of its full grace still lets close resolve. Activity's own transport
deadline and genuine failure identity remain unchanged.

Expiry does not resolve the queued operation, terminate its worker, close its
reader, release capacity or authorize a replacement writer. The same ordered
cleanup continuation remains owned and proceeds when actual operations return.
The error's optional `cleanup` promise observes that continuation, retaining
its eventual success or genuine errors. Repeated app close returns the same
public outcome; a rejection never means cleanup succeeded. The deployment
shell owns ultimate process exit. Neither this library deadline nor Bun worker
termination proves that native SQLite/fsync stopped or a thread joined.

Live dialogue uses that technical budget for individual pending operations
and per-owner failure drains, independently of other owners. A per-write budget
starts when the journal submits the operation, including catalog/native FIFO
queue wait and acknowledgement latency. A long healthy shared writer queue can
therefore stop voice as indeterminate; it is a receipt-latency bound, not proof
that SQLite/fsync failed or was cancelled. Every pending
owner object sharing the canonical archive ID participates; adoption does not
split a drain or release accounting. Normal healthy writes keep their own
submission/commit order. A deadline withholds unresolved text, marks coverage
incomplete, stops capture/admission and closes only the captured failed epoch.
Already confirmed unsaved callbacks remain distinct from indeterminate writes.
Actual pending sets and count/byte charges remain until genuine settlement.
Late commits never publish into a retired live scope; authorized historical
reads retain the actual principal, generation and native provenance.

Opening behind an old close transition and required history/catalog settlement
also refuse within the technical budget. A late opening is retired and its
exact durable close remains ordered before a later opening. Existing explicit
Start/profile disclosure and principal/epoch/lifetime authority still gate all
history/provider access. No timed-out operation is replayed.


Activity, Actions and Storage delivery retain admitted transport and outcome
writes through shutdown. Every admitted call retains its own inputs, result and
error, including concurrent calls of the same kind. Pending promises are tracked
until settlement, independently of the bounded historical diagnostics; runtime
and sampler admission flags still prevent overlapping ordinary ticks. Close stops
new admission synchronously and joins every pending call. A flight that already rejected remains a shutdown
failure even when a runtime logger or sampler has observed it and removed it
from pending work. Each owner keeps at most four distinct original error
representatives and a saturating failed-operation count. A sole failed operation
rejects with its original identity; multiple failures report the first cause,
count and bounded representatives without claiming a complete error log. Recovery
does not erase a known failure before late close. Parallel outcome/bookkeeping
writes all settle before their owner finishes. Transport refusal and ambiguity keep their existing notification
outcomes; persistence failures reject shutdown while remaining cleanup runs.
The sampler retains rejected flush, receipt sweep and cache cleanup operations,
attempts its final history flush, and joins concurrent close calls. The app
closes history even if that final flush throws. History's existing bounded
buffer/status handling for unavailable writes remains unchanged.

## The inventory and its guard (#3004)

Every hosted-path `ui.db` write commits on the write worker. That was verified by
watching the app connection itself, not by reading code.
`takeTurns`, which wraps every outermost app-connection transaction and
autocommit write, compares SQLite's `total_changes()` before and after each one.
An observer registered for a database (or for every database) receives each
turn that changed rows, with its stack and the app's phase:
- `boot`, while `createApp` builds the app;
- `serving`, once it returns;
- `standalone`, for a component built outside `createApp`.

The code is `observeAppWrites` and `markAppPhase`
(`packages/ui-server/src/db/write-worker.ts`). Nothing is observed unless an
observer is registered.

**The inventory.** `scripts/app-write-audit-preload.ts` records every observed
write while a suite runs, and `scripts/app-write-inventory.ts` groups the
records by the nearest server frame. A write whose stack holds a test frame
counts as a fixture: a test's own write, or a product call a test made
directly on the app's database to seed it. Over the ui-server suite and `./tests` on 2026-10-26 (2,452
observed writes), the serving phase held only three kinds of site:
- the inbox dispatch fixture's triage and autonomous-turn path;
- turn budgets that `ws-turn-budgets.test.ts` builds on the app's database without its writer;
- the guard test's own probe.

The boot phase held only the schedule root's first insert. Standalone
components (the writer gate, turn scope and reverts that tests build without
`createApp`) take the writer the app passes them when hosted.

**Named exceptions.** These are the only writes left on an app connection:
- **Boot.** Migrations (`createUiDb`), boot reconciliations and sweeps, and the
  schedule root identity's first insert (`rootInfo`,
  `packages/ui-server/src/schedules/service.ts`), all before the app serves.
- **Operational restore.** It writes inside its caller's transaction.
- **The cron runner** writes on its own connection, through the same
  procedures inline.
- **The inbox dispatch fixture** (`INBOX_DISPATCH_FIXTURE`), which only the
  repository's fixture host can pass, so no consumer reaches it.
- **Components a test builds** without the app's writer.

**The guard.** `httpContractApp`
(`packages/ui-server/tests/helpers/http-contract-app.ts`) registers
`guardAppWrites` (`packages/ui-server/tests/helpers/app-write-guard.ts`) on
every hosted test app once it serves. The guard records each app-connection
write reached from server code alone, and `close()` fails the test with
`APP_CONNECTION_WRITE_WHILE_SERVING`, naming the site. So a new route or tick
that writes on the app connection fails the hosted route and mount suites
that already exercise it.

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

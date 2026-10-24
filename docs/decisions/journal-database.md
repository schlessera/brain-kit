# The journal's own database file

The maintainer ruling on [#2789](https://github.com/schlessera/brain-kit/issues/2789)
(option A, 2026-10-24).

## What was wrong

The turn journal's 10 GiB cap charges the SQLite pages the journal owns, the
pages it released that are still free, its WAL headroom, its objects and its
reservations. While its tables shared the UI database with Activity, sessions
and governance events, telling the journal's pages from everyone else's meant
walking b-trees on every accounted write: first the whole database, then, after
[#2812](https://github.com/schlessera/brain-kit/pull/2812), the journal's own
b-trees. Under fsync load that walk waited on I/O on the event loop.

A design without a walk was built and broken. Frames read back from the WAL give
the pages a commit wrote but not their owners, a commit's new pages cannot be
known before it commits, and another component's frees inside the same
transaction (a `REPLACE`, or plain insert balancing) feed pages to the journal
that no pre-charge covers. The evidence is on the issue.

## What we do

- **The journal has its own file**, `${DB_PATH}.journal.db`, attached to every
  UI connection as `journal`
  (`export function attachJournalDatabase`, `packages/ui-server/src/db/journal-database.ts:29-44`). The
  file sits beside the UI database's physical file, so every alias of
  `DB_PATH` names one journal.
  Every page in it is the journal's, so the measurement is the file's page
  count and the journal's own WAL, read without walking
  (`function measure()`, `packages/ui-server/src/brain/journal-accounting.ts:61-74`).
  Other components' pages and WAL frames are no longer the journal's charge.
- **The tables move on start.** Migrations up to `063` create journal tables
  in the UI database. Before any later migration, and again after the last,
  a start copies every `turn_journal_*` table, with its rows, indexes and
  triggers, into the journal file and drops the originals
  (`export function moveJournalTables`, `packages/ui-server/src/db/journal-database.ts:65-108`).
  Copying writes only the journal file and dropping only the UI file, so a crash
  between them leaves both copies; the next start rebuilds the copy, with no
  copied trigger running, before dropping. Every writer must be stopped for the
  upgrade, as for any installation change: a write an older release makes to
  the UI copy between the two steps would be dropped with it. A release before
  this one cannot open the database afterwards; rolling back needs the backup
  taken before the upgrade.
- **Later migrations stay in one file each.** A migration after `063` that
  changes journal tables is named `*.journal.sql`, touches nothing else, and
  records its receipt in the journal file's `turn_journal_migrations`, so the
  change and its receipt commit together. It creates every object as
  `journal.<name>`; the runner refuses one that changes the UI database's
  schema. Any other migration touches no journal table. A test holds every
  migration after `063` to this.
- **Released pages return to the file system on restart.** The file uses
  incremental auto-vacuum, and a ledger runs it once as it starts. Within a run,
  released pages stay charged, as before.
- **Governance events are replayed.** A journal write that records a steering
  change also records its `steering_change` event in the UI database, and a
  commit spanning two files is atomic per file only. SQLite commits the UI
  file first, so a crash between the two keeps the event without the change:
  the worker did make that change, and the journal reports the turn as
  partial, so the event stays. The opposite loss, the change without its
  event when the UI file's commit does not survive, is repaired on each start:
  any missing event is rebuilt from its journal row, under the same dedupe
  key, timestamped with the turn's end
  (`export function replaySteeringEvents`, `packages/ui-server/src/brain/journal-governance.ts:19-43`).
- **The operational backup stays whole.** `brain-ui-inbox export` folds the
  journal file's tables back into the UI database image, where releases
  before the split kept them, and refuses the journal file as a destination.
  A restore needs no journal file at the target and moves the tables out on
  the first start. The backup's format is unchanged.
- **The journal file is operational state.** It is masked from workers, refused
  inside the brain like the UI database, and inventoried as retained file
  history. A ledger on any connection attaches it and enforces its references.

## Not done here

The write worker that commits off the event loop
([#2814](https://github.com/schlessera/brain-kit/issues/2814)) owns this file
once it lands: it attaches it under the same schema name on its own connection,
and the ledger's attach is then a no-op.

A `roadblock` event a journal-reader failure records is not replayed: its
payload carries timings that the journal does not keep. The journal's `missing`
record of that path stays authoritative.

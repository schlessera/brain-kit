# Operational backup and restore

`brain-ui-inbox` is the Bun-only recovery executable shipped by
`@schlessera/brain-ui-server`. It starts no app, backend or inference.
Use it with an existing, migrated UI operational database and the brain
directory whose share staging that database references:

```sh
brain-ui-inbox export --db ./ui.sqlite --brain-root ./brain --file ./operational-backup.json --json
brain-ui-inbox restore --db ./recovered/ui.sqlite --brain-root ./recovered/brain --file ./operational-backup.json --json
```

Create the destination database's parent directory and the destination brain
directory first. Restore brain content from its separate Git backup. The
recovery command never reads or writes content Markdown or `brain.db`.
Stop the target app and other writers for the entire restore.

## What survives

The artifact contains a consistent SQLite image of the **whole UI database**.
It retains threads and their immutable trust/provenance, item projections and
tombstones, checkpoints, strict stored option effects and Action contexts,
resolutions and deterministic follow-ups, suppressions, change cursors and
sequences, claims/leases/attempts/blocked links, intake receipts, completed-tool
receipts, frozen budget reservations and settlement, and scheduler heartbeats.
Activity spans/rollups preserve observed spend; principal records preserve
identity attribution. Other UI state, including sessions, authentication
records and settings, travels with the same image.

Session drafts (#979) are in the same image: their text, image bytes,
revisions, tombstones, idempotency receipts and accepted-send records.
Restore returns them to the capture point. A draft deleted or sent after the
capture comes back, and edits made after it are lost; a device that still
holds newer content gets a conflict or a not-found answer from the restored host
rather than a silent overwrite.

Scheduled-task proposals, operator approvals, approved snapshots, publication
and retirement journals, cancel receipts and occurrences are in the same image.
Export and restore refuse a task whose snapshot, fingerprint or approval no
longer matches its proposal. The definition files themselves are content under
`context/scheduled-tasks/` and come back with the content restore. Restore pauses
every enabled task as `restore_pending` and turns each outstanding occurrence
into an `unknown` outcome: an old image cannot prove that no later
cancellation, revocation or effect happened. Restore also ends every
unfinished attempt as `unknown` and drops the Queue work of those occurrences,
so none of it is claimed again. The tasks stay paused and visible until the
operator investigates and runs `brain schedule reconcile <id>` (see the
[schedule contract](integration-contract/package-api.md#scheduled-tasks-additive-914)).
The first reconciliation after a restore into a different brain directory
binds the schedule ledger to the directory that restore named.

Every regular file in the canonical share-staging directory is included,
including metadata, uploaded bytes and interrupted intake's partial directories.
Required staging references and each manifest's declared file sizes must agree.
Missing bytes or staging symlinks refuse export. The export reader waits up to
five seconds for a temporary SQLite lock before failing. A second
database/staging comparison refuses concurrent changes during capture. Retry a refused export;
it leaves the previous published backup intact. Atomic publication syncs a
private temporary file before replacing the destination. Directory aliases
cannot bypass protection of the source database, its sidecars or staging.

The artifact and restored files use mode `0600`; new staging directories use
`0700`. The backup contains private content and authentication state. Keep it
in private backup storage with the same access controls as the live database.
SHA-256 checksums detect corruption; they are not authentication against someone
who can rewrite the artifact and recompute its checksums.

## Empty targets and crash recovery

Restore accepts an absent database file without surviving SQLite sidecars and
an absent or empty share-staging directory. It refuses populated targets
rather than merging operational state.
Unsupported versions/schemas, invalid relations, missing claim reservations,
broken resolution/follow-up links, inconsistent cursors, tampered images and
missing staging fail before a new target is published.

The published database initially contains a durable `pending` restore marker.
App boot, drain startup, model admission/acquisition and compensation claims
refuse this state. Staging publication finishes before one immediate SQLite
transaction reconciles all active reservations, recovers old claims and opens
the marker. A killed process cannot commit only part of that reconciliation.

Repeat the identical restore command after interruption. Resumption requires
the same artifact checksum, canonical brain directory and unchanged restored
database. Existing staging files must match exactly; only that restore's
private publication temporaries are reaped. Changed state refuses resumption.
After successful completion the destination is populated, so another restore
is refused.

Every restored claim belongs to a worker lost with the old installation, even
if its lease had not expired at capture. Reconciliation charges observed spend
or the conservative reservation/larger observed lower bound, retaining the
original admission day and attempted turn. It releases claims into existing
bounded backoff or a stable dead-letter Action without resetting attempts.
Already settled rows remain frozen.

Resolution replay returns its recorded result without another follow-up.
Completed effectful tool/input receipts restrict fresh attempts under current
authority; they never grant permission or replay a runtime transcript.
The [budget guide](inbox-budget.md) describes incomplete-usage accounting and
the exact-call scope of receipt deduplication.

## Recovery point and compatibility

The recovery-point objective is **24 hours**. The host must successfully export
and durably retain a complete artifact at least every 24 hours, retry capture
contention, and report failures/stale backups. A missed export does not satisfy
that objective. The public hosting-template counterpart owns scheduling,
storage retention and an operator restore drill.

Recovery returns to the captured point. Work, spend and effects after that point
cannot be reconstructed from an older artifact; in particular, an unrecorded
external write cannot be proven complete by this backup. Restore the content
Git backup deliberately alongside the operational point, and investigate
uncertain later effects before enabling execution.

Format `brain-ui-operational-backup`, version `1`, supports the exact shipped
SQLite schema/migration set. Restore with compatible package contents; schema
conversion and merge restore are unsupported. The [integration contract](integration-contract/cli.md#operational-recovery-command-additive-686)
defines command JSON, checksums and failure codes. Internal `exportState()`
is an audit read of inbox rows; it omits staging, principal state and Activity
receipts and does not replace this recovery artifact. Production autonomous
dispatch remains subject to the async system's separate enablement gates.

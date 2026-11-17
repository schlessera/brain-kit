# Decision — native brain checkpoints and delta history

The maintainer approved this architecture and storage scope on 2026-10-14 in
[#1790](https://github.com/schlessera/brain-kit/issues/1790#issuecomment-6157433708),
after the [step-by-step audit](https://github.com/schlessera/brain-kit/issues/1790#issuecomment-6157241842).
It supersedes rebuilding complete user-space input copies and journal
baselines for each hosted governed turn. It preserves the complete immutable
execution-input and shared live-brain requirements of
[governed writable workers](governed-writable-workers.md).

## Why the representation changes

Arbitrary shell writes and external edits require reliable old bytes for
undo. They do not require reading, hashing, copying and pinning every unchanged
file before each turn. The released journal did that work with a fresh walker,
then released unchanged baseline objects when the turn ended. Its per-file
accounting also repeatedly checkpointed and measured the shared UI database.
A many-file fixture reproduced multi-second health stalls on first and warm
admission. Moving that whole algorithm to a thread would preserve its cost
and leave shared database contention unresolved.

Complete immutable views serve another purpose: maintenance and restricted
execution must see frozen configuration dependencies, including names absent
at launch, while governed peers continue writing the authoritative brain.
Removing undo alone would not remove those startup copies.

## One supported native path

Hosted governed mode requires managed Btrfs storage. The brain is one
subvolume, with no nested mounts or child subvolumes. Unsupported storage
produces an explicit unsupported-mode result and setup guidance. There is no
full-copy fallback or new pluggable filesystem-provider interface.

Short-lived read-only checkpoints provide complete immutable execution inputs
and observation preimages. Governed workers continue writing the same live
brain; they do not write divergent clones. Other workers receive their admitted
checkpoint at the original brain path with the existing secret/protection masks
and separately bounded writable output areas.

Native incremental metadata deltas identify changed paths. Initial import or
recovery may build a complete metadata inventory; unchanged warm admission
must not walk or hash the whole brain. Changed paths update the existing
entry/type/depth/logical-size checks and each turn's frozen journal coverage.
A malformed, unsupported or incomplete delta cannot be called complete.

Only required changed before/after versions enter the existing private
content-addressed history store. Reflinks may avoid copying changed bytes when
qualified, but hash identity, immutable ownership and conservative object
charges remain. Retained history does not consist of complete 30-day filesystem
snapshots. Release a checkpoint only after its observations are durable and all
execution/recovery consumers have released it. Ignored files can occupy
transient checkpoint space without becoming eligible for history or revert.

Observation timing, shared-turn attribution and truthful partial states remain
binding. Undo compares current paths with their expected versions before
restoring selected bytes. It never rolls back the live filesystem wholesale,
which could erase another turn's later edits.

## Storage ownership and capacity

> **2026-10-18 — Separate reference/worktree policy (#2390).** The
> [reference-worktree decision](reference-worktrees.md#a-separate-logical-btrfs-volume-and-finite-allocation-budget)
> selects a separate logical Btrfs reference/worktree volume with a combined
> actual-allocated-disk allowance, including shared allocations, staging and
> reservations. It does not change the brain-content retained-history charges
> or the frequent-checkpoint store described below. Separate physical storage
> and pre-reserved reference-volume backing are not required. Its concrete
> allocation attribution and worktree optimization require their own runtime
> evidence; this amendment supplies no qualification of either.

The 10 GiB retained-history limit remains: distinct retained objects are charged
by logical file length, alongside journal-owned database allocation and
object-write reservations. Sharing physical extents does not reduce those
logical object charges.

Temporary native checkpoints use a separate operator-configured finite hard
managed-volume limit. That outer capacity contains live data, checkpoints,
private persistence and filesystem overhead, with recovery headroom. This
explicitly changes the former journal cap's temporary-preimage scope. It does
not silently reuse 10 GiB as the total live-brain capacity or invent a new
volume size. Existing worker runtime-state, turn-temp and staged-output
allowances remain unchanged.

A sparse image's apparent size is not reserved physical backing. Automatic
growth and unbounded fallback storage cannot establish the hard bound. Space
reclamation must be observed before it is reused: deleting a checkpoint name
is not proof that the filesystem has finished freeing its blocks. Exhaustion
must preserve status/recovery and record honest refusal or partial history.

Full Btrfs qgroups are not the mechanism for this frequent-checkpoint workload.
[Upstream quota guidance](https://btrfs.readthedocs.io/en/latest/btrfs-quota.html#stability-and-performance-implications)
describes severe snapshot-related latency and inconsistent accounting that can
interrupt enforcement. A bounded managed volume avoids adding a shared-extent
ownership graph to the application merely to reproduce the old byte cap.

## Recovery inventory and identity fences

Recovery pages use a disposable, broker-local SQLite B-tree of checkpoint and
stage identities. The manager rebuilds it from durable JSON intents once at
startup, alongside existing stage accounting. Startup still enumerates and
reads the historical intents; this is not bounded startup work.

Each page seeks strictly after its UUID cursor and reads at most 65 index keys:
64 response candidates and one lookahead. It opens at most 64 durable intents,
keeps the existing response-byte limit, and never enumerates or sorts the
complete intent directory during a page request. The manager serializes an
individual page with mutations. Pages do not promise a multi-request snapshot:
an identity inserted below an already-consumed cursor is not returned later.

Intent rename and parent-directory fsync precede index insertion. If insertion
fails, the manager builds a complete replacement from those durable intents
before continuing. A failed rebuild refuses dependent admission and pages;
each later request retries the rebuild in the same process. Losing the
in-memory index or a transport reply does not lose the durable identity. Deleted intents remain present and continue
to fence delayed create requests; no identity retirement or tombstone lifetime
policy is introduced.

Retained JSON metadata still grows with historical identities inside the finite
managed volume. The in-memory index also grows with that history. Qualification
records allocated JSON blocks and SQLite index pages separately from page work
and startup time; SQLite page bytes do not measure the whole broker heap. An
allocation failure is a refusal, not permission to return an incomplete index.

## Authority and qualification

A concrete host-owned manager operates only the configured store and generated
checkpoint identities. It executes no brain configuration, Git, hooks or CLI.
Workers receive no manager endpoint, block device or administrative capability.
Untrusted writers must be prevented from creating nested subvolumes or changing
snapshot flags; otherwise native snapshots could omit writable content or lose
immutability. Read-only mounts and inaccessible private aliases remain required. Maintenance
masking covers exact regular-file paths as well as directories; the qualified
loop backing file does not rely on its parent being masked or its DAC mode
denying reads.

> **2026-10-15 — Recovery scope for mutable private storage.** The
> [runtime-state recovery amendment](policy-write-boundary.md#cross-uid-runtime-state-and-best-effort-recovery--2026-10-15)
> records #1677 option E. Read-only native checkpoints remain immutable inputs;
> their existence does not snapshot the mutable tmpfs outputs described below.
> After verified owned-tree termination and implemented owned-I/O cleanup,
> recovery is best effort over observed bytes, with explicit external-reference,
> source-consistency and physical-reclamation limits. Configured bounds, known
> retained-resource accounting and this record's no-qgroup policy remain.
> This neither selects Btrfs-backed runtime state nor claims broker/runtime
> qualification; production packaging remains in
> [brain-hosting-template #18](https://github.com/schlessera/brain-hosting-template/issues/18).

Writable maintenance and strict-worker outputs use a private bounded tmpfs
upper layer over the admitted checkpoint. The host manager mounts OverlayFS
with trusted metadata, before handing the mount to an unprivileged worker.
Worker-writable `user.overlay.*` attributes cannot supply whiteouts or hide
unchanged input files. Publication consumes only changed upper-layer entries;
subtree deletion checks enumerate the affected sealed subtree, not every
unchanged file in the brain. The server still checks authoritative paths
immediately before publishing each permitted change.

Separate-UID maintenance prepares only the fixed disposable index family
(`brain.db`, `-wal`, `-shm`, `-journal`) in that same bounded stage. Readable,
regular, singly linked inherited files with owner-write permission are copied
to worker-owned files with the exact original modes. This does not chown or
widen permissions on the authoritative brain. Already worker-owned files are
validated without recopying. Preparation runs before the payload with no other
command active, preserving the complete immutable SQLite family; committed WAL
and hot single-database rollback state remain available for SQLite recovery.
SHM may be reconstructed from WAL. Aliases, special nodes, orphan sidecars,
non-owner-writable inputs and cross-database super-journal recovery refuse.
A failed or interrupted preparation poisons the stage for further payloads and
publication until it is discarded. The private control marker is bound to the
existing stage/checkpoint, command generation, descriptor and owned drain;
no generic copying or reader authority is added (`prepareMaintenanceWorker`,
`packages/ui-sdk/src/server/maintenance-worker.ts:119-150`).

The root manager configuration fixes the application UID/group and the existing
output allowance and aggregate budget. Requests cannot choose host paths or
identities. Manager and application require a shared PID namespace and matching
managed mount paths so the application can reach the retained stage keeper.
These are explicit hosting requirements, not capabilities granted to workers.
A lost stage keeper refuses publication; recovery discards the stage before
releasing its lower checkpoint.

Native checkpoints do not replace namespace isolation, complete input validation,
writer gates, authoritative output checks or guarded per-path restoration.
Filesystem work and cleanup run outside the app event loop with explicit
ownership, cancellation and crash reconciliation. An observation must retain
its worker hold until capture and capacity checks settle; a late helper result
must never restart cancelled work.

The [Btrfs subvolume documentation](https://btrfs.readthedocs.io/en/latest/btrfs-subvolume.html)
explains shared blocks, nonrecursive coverage, dirty-data flushes and deferred
deletion. Its [incremental send interface](https://btrfs.readthedocs.io/en/latest/btrfs-send.html)
provides the native delta mechanism. These primitives do not establish a
constant latency guarantee. Qualification must cover real unchanged/changed
workloads, complete path changes, worker restrictions, overlapping consumers,
crashes, exhaustion and independent HTTP/WebSocket/cancellation measurements.
Native runtime qualification precedes any production migration.

## Turn data trees on the managed volume (#2911)

A strict, voice or autonomous turn reads a data tree copied from its startup
checkpoint ([the data-tree ruling](governed-writable-workers.md#a-turns-own-applications-reach-its-reads-maintainer-2026-10-25)).
On a temporary directory every tree is a full copy of the view's documents and
index. The maintainer's ruling on
[#2911](https://github.com/schlessera/brain-kit/issues/2911) (2026-10-25,
option A) places it on the managed volume instead, where it shares the
checkpoint's extents.

**Placement and ownership.** The manager keeps a root-owned `trees/`
directory (`0710`, the app's group) beside `stages/` under its private root.
`prepareTurnTree` creates one directory per caller-generated identity there,
owned by the fixed app UID and group with mode `0710`; the app creates the
tree's `data/` and `index/` inside it. The directory is outside the live
subvolume, so governed peers cannot write it and no checkpoint snapshots it.
The private root is already a mandatory worker mask, so a worker reaches only
the tree the launcher binds read-only at its fixed path. The worker identity
shares the app's group and can only traverse the directory to that bind. No
request names a path, owner or mode.

**Placement requires sharing.** The app copies with
`COPYFILE_FICLONE_FORCE`. A file that cannot be reflinked fails the turn's
admission and releases its tree; no full copy is made in its place. A managed
view whose manager cannot place a tree is refused the same way. Trees for
views no manager acquired keep the temporary-directory copy.

**Allocation and admission.** Each tree carries a page-aligned allowance: its
admission charge for what it can newly allocate. Shared document extents are
not charged as copies. The charge counts the tree's metadata (4 KiB per
entry), twice the seeded index (every page rewritten, with its log), the
turn's bounded effects (`TURN_TREE_EFFECT_BYTES`, 64 MiB, enforced by the
tree) and 1 MiB of overhead. Admission reads the volume's free space with
`statfs`, which counts every allocation once, shared extents included. It
admits a tree only while the live trees' allowances, this one and one
emergency reserve's worth of headroom fit in that free space. It also needs
an armed reserve. A tree's own growth therefore lowers free space while its
allowance stays charged. That is conservative and never enlarges the
configured capacity. The headroom keeps trees from driving checkpoint and
intent writes onto the emergency reserve, which tree writes can never consume
directly. Qgroups stay disabled; the allowance is an admission charge, not a
kernel quota.

**Durable records.** A tree is a `kind: "tree"` intent in the manager's
existing intent store, with its allowance also recorded beside its directory,
so an unreadable intent keeps its charge. A quarantined tree whose allowance
is unknown refuses tree admission only. Checkpoints, stages and recovery keep
working. Deleted intents fence delayed creation requests, as for stages. The
app's lease owner records each tree as a `tree` root lease before the request,
with the same owner identity as checkpoint and stage leases.

**Release and recovery.** The owner releases a tree after its workers exit.
The manager refuses while any process's mount namespace still holds a mount
of the tree, read from every `/proc/<pid>/mountinfo`. An unreadable census
refuses too. Otherwise it marks the intent `deleting`, removes the directory
with a descriptor-relative walk that follows no link, and observes a
filesystem commit. Only then does it credit the charge and record `deleted`.
A refused or interrupted release keeps the charge and the lease's `deleting`
intent. The lease owner's dead-owner recovery releases a dead owner's trees,
and any tree whose release was already intended, by the same rule. It never
removes a live owner's tree, an unrecorded directory or another identity.
Removal runs in the manager, outside the app's event loop, bounded by its
operation timeout.

The receipts that qualify this placement are the native `--apply-timing` run
and the separate-UID identity cell. The first records each strict tree's
`btrfs filesystem du` total, exclusive and shared bytes at seed and at close
in `apply-timing.json`. The second proves a worker reads its own tree, cannot
write it, and cannot reach a peer tree or the manager's area.

## Alternatives

Watchers can provide hints, but notifications alone neither preserve overwritten
bytes nor prove complete coverage after dropped events or restart. A portable
versioned filesystem layer would add more application machinery than this
concrete native requirement.

OpenZFS has native snapshots and a useful changed-path interface. Supporting
both filesystems immediately would add deployment and qualification work without
removing the temporary-checkpoint accounting decision.

Reduced undo remains a distinct product choice: committed-version restoration
or mediated-tool-only undo can avoid universal preimages. Removing only the
whole-turn revert action cannot. This ruling keeps existing observed-version
undo and changes its storage mechanism instead.

## Containing recovery failures (#3816)

An unreadable native intent stays in place as an identity fence. Startup records
its error class, message, site and timestamp under the manager's private
`recovery-diagnostics/` directory, and continues. `ready` reports the count,
diagnostic directory and conservatively charged staging bytes; authenticated
`/api/status` exposes that boot report as `nativeRecovery`. An invalid UUID
cannot own a stage and has no staging charge. A confirmed absent stage directory
also charges zero: the directory precedes namespace setup and is removed only
after confirmed close. The malformed receipt remains quarantined in both cases.

Before starting a stage, the manager durably records its exact tmpfs allowance
in a separate root-owned `stages/<id>.allowance` file. A surviving or unreadable
directory retains that cap even if today's configured allowance is smaller.
The allowance record is removed only after close and durable directory removal;
neither a failed close nor an I/O error releases it. Healthy stages can use the
remaining aggregate budget. An old stage without this independent record, or a
damaged/unreadable record, has no provable historical bound. Its charge stays
unknown (`null`), new staging returns an explicit recovery refusal instead of a
retryable capacity error, and authenticated status reports `healthy: false`.
A bounded quarantine also returns recovery when its charge plus the requested
allowance exceeds the budget: waiting cannot release quarantined storage.
The boot status reports `stagingRefusal` when the configured allowance cannot
fit, even when the charge is finite. Smaller requests can still use any proven
remaining capacity. Active-stage pressure alone remains retryable busy.
The cause stays in the private diagnostics directory. Repair requires proof of
the historical cap or confirmed cleanup, never a guess based on current config.
No historical checkpoint dependency is released while a quarantined receipt
could own it.
Healthy checkpoint creation and reads remain available;
new roots created after recovery can also be released, since a historical stage
cannot refer to those native identities. A recovery
page touching that identity refuses explicitly. Repairing an authoritative
receipt requires owner judgment; restart after that repair reconstructs the
known reservation. Unknown identities are never adopted or deleted.

Index rebuilds use the same diagnostics directory; they need no owner action.
The reference pool refreshes its accounting map from the same durable intents
before it reopens dependent admission.

Diagnostic writes are best-effort and cannot gate mechanical recovery. If the
private diagnostic directory refuses a write, the structured stderr record
retains both the original cause and that write failure; the authoritative bad
intent remains on disk. A disposable index rebuild publishes only its complete
replacement, and retries pending diagnostic writes on later requests separately
from admission.

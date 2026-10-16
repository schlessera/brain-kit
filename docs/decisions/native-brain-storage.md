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

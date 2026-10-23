# Decision — reference pool allocation, admission and recovery

[#2428](https://github.com/schlessera/brain-kit/issues/2428) implements the
storage foundation that the [reference-worktree decision](reference-worktrees.md#a-separate-logical-btrfs-volume-and-finite-allocation-budget)
selected: a separate logical Btrfs volume with a combined allowance (10 GiB by
default) and a per-operation allowance (2 GiB by default), both charged as
actual allocated disk. That decision left the mechanism to implementation.
This record names the mechanism, the primary sources it relies on and the
native observations that qualified it. The pool is managed by the existing
host-only native manager
(`createNativeReferencePool`, `packages/ui-sdk/src/server/native-reference-pool.ts:270-958`).
No consumer uses it yet.

## A separate volume, not another subvolume of the brain store

The brain store must keep qgroups disabled
([native brain storage](native-brain-storage.md#storage-ownership-and-capacity)).
Btrfs quotas are a property of a whole filesystem. A pool inside the brain
store could therefore have no per-root kernel limit, and polling counters while
workers write directly is not enforcement. The pool is its own single-device
Btrfs filesystem, and the manager refuses a configuration that names the brain
store's fsid or nests either path inside the other. The pool's device can be a
plain disk or partition, a fully allocated loop file or a **sparse** loop file.
A separate disk or preallocated backing is not required.

## Mechanism: simple quotas for attribution and enforcement

Linux 6.7 added simple quotas (squota,
[btrfs-quota](https://btrfs.readthedocs.io/en/latest/btrfs-quota.html#simple-quotas-squota)).
They charge each extent once, to the root that allocated it, when its delayed
reference runs. Kernel v6.18 source shows the details this design depends on:

- `btrfs_record_squota_delta` (`fs/btrfs/qgroup.c`) adds the extent's on-disk
  size (data) or `nodesize` (tree block) to the owner's level-0 qgroup and every
  parent group. It never walks backreferences. Shared, reflinked and
  snapshotted extents stay charged to their first owner.
- `qgroup_reserve` checks limits on `rfer`/`excl` plus outstanding
  reservations at write time and returns `EDQUOT`. Buffered writes reserve
  before they dirty the page, so a worker cannot write past its allowance and
  be noticed later. The only bypass is `quota_override` held with
  `CAP_SYS_RESOURCE`; the manager refuses an enabled override, and workers
  run with no capabilities.
- `btrfs_qgroup_inherit` applies `BTRFS_QGROUP_INHERIT_SET_LIMITS` and parent
  membership inside the creating transaction. Every pool root is created by
  `BTRFS_IOC_SUBVOL_CREATE_V2` or `BTRFS_IOC_SNAP_CREATE_V2` with its own
  allowance and membership in the fixed level-1 qgroup `1/2428`. There is no
  unlimited window between creation and limiting.
- `can_delete_qgroup` keeps a dropped root's qgroup while it still has
  usage, because squota needs it to account later frees. A deleted source whose
  extents a snapshot still references therefore keeps its owner charge.
- `btrfs_record_squota_delta` ignores extents older than the quota enable
  generation. The manager refuses any root created before that generation.

Full qgroups were not chosen. The
[upstream warnings](https://btrfs.readthedocs.io/en/latest/btrfs-quota.html#stability-and-performance-implications)
about backreference walking on snapshot-heavy workloads and inconsistent
accounting apply to full mode. In squota mode the referenced and exclusive
counters are equal and owner-only. A per-root number is then an attribution,
not the root's share of everything it can read.

`TREE_SEARCH` is used only for small censuses: root backreferences, orphan
(dropping) roots and the quota status and relation items. `LOGICAL_INO` is
not used. Paginated search is not a snapshot, so the consistency rule below
applies to the census as well as to counters.

## What is charged

The **aggregate** is the filesystem's own allocation: the sum of
`allocation/{data,metadata,system}/disk_used` from sysfs, plus pinned and
reserved extents scaled by their profile. `disk_used` already multiplies by the
profile (a DUP tree block counts twice). It counts each physical extent once,
however many roots, hardlinks or reflinks reference it, and it includes the
global trees no root owns: extents, checksums, free space, roots and quota
items. The pool's emergency file is reported separately and excluded. The rest
is the amount charged against the combined allowance. It is not
`StorageInventory`'s `512 * st_blocks` and not the advertised filesystem size.

The **per-operation metric** is a root's squota owner charge: data extents at
their on-disk (compressed) size, its own tree blocks at `nodesize`, and any
kernel reservations still outstanding. It covers Git objects, checkout, staging
and inline files written inside that root. It excludes profile replication and
global trees. Per-root charges are not summed to get the aggregate; the status
reports their difference as `globalBytes`.

Supported profiles are exactly `single` or `dup` for data, metadata and
system, with no mixed block groups, zoned or RAID5/6 features. A space with more
than one profile directory (a conversion in progress) refuses.

## Admission

Every admission runs inside the manager's single serialized lock. After that
lock is taken, it rereads the evidence. It records the reservation durably
before creating anything:

```
charged + pending + reserve(allowance) ≤ combined limit
pending = Σ reserve(allowance − referenced) over reserved and writable roots
reserve(x) = ⌈x · (8 · max(data factor, metadata factor) + 1) / 8⌉
```

A remaining owner-charged byte can still land in DUP metadata (2×), and
global trees grow with the data they describe. The factor reserves that worst
case plus one eighth. As a root writes, referenced bytes move from `pending`
into `charged`, so one byte is never charged both as a reservation and as an
allocation. Kernel reservations (delalloc) do not release reservation until
they are allocated. Sealing makes the root read-only, waits for a stable
observation and replaces its reservation with the measured allocation.
Concurrent requests, retries of the same identity and lost replies all pass
through the same lock and durable intent. They cannot spend one allowance twice.

The kernel enforces both bounds independently of the manager's arithmetic:
each root's allowance and `1/2428`'s combined limit. The combined qgroup counts
owner charges without replication, so it is a backstop. Admission is the
binding check.

## Physical headroom shared by capacity identity

A sparse loop backing draws from the free space of the filesystem that holds
its file. The manager records the pool's unbacked bytes (device size minus the
backing file's allocated blocks) in a ledger under a directory `flock` on that
same filesystem. Every participating consumer of that physical capacity shares
the ledger: another manager, another pool, or a bind-mounted alias of the same
inode. Headroom is

```
backing available − max(floor) − other consumers' unbacked − this pool's unbacked
```

and admission refuses when it is negative. As blocks materialize, the backing's
free space falls and the pool's unbacked bytes fall by the same amount, so no
materialized byte is charged twice. The floor and the emergency file are never
spendable budget. The brain store's live writers do not consult the ledger, so
a pool backing on the brain store volume is refused. Non-participating writers
on other backing filesystems are covered only by the floor. A fully allocated
loop or a plain disk has no unbacked bytes and no ledger entry. Device-mapper,
md and other devices whose provisioning cannot be verified are refused.

## Consistent observation

One observation issues `BTRFS_IOC_SYNC`, which commits the running transaction
and runs its delayed references. It then reads every counter, the census and
the quota items twice. The observation is stable only if both reads are
identical. Up to four pairs are tried. An unstable observation still reports
its numbers but refuses admission and sealing with `changing`. Status and
recovery remain available.

Accounting refuses, with a reason, any evidence it cannot explain:

- a subvolume with no recorded identity, or nested inside a pool root;
- a qgroup that no recorded root owns, or a relation outside `1/2428`;
- a writable root that lost its kernel limit, or a changed combined limit;
- a recorded live root that is missing;
- quota mode other than squota, inconsistent quotas, an override, or an
  unsupported profile or feature.

Empty level-0 qgroups left behind by fully dropped roots hold nothing and are
ignored. The manager removes them when it records reclamation.

## Durable intents and recovery

Pool intents live on the pool volume itself, so their bytes are charged to the
pool, and a pool-local emergency allocation records recovery transitions under
ENOSPC. A new reservation never uses that allocation; it refuses instead.
Each intent carries its generated UUID, purpose, source, allowance, state and,
once created, the root's id, UUID and creation generation. States move
`reserved → writable → sealed → deleting → deleted → reclaimed`:

- A reply lost after creation is adopted only if the root sits at the
  recorded path in the managed roots directory with a creation generation no
  older than the reservation and the expected parent UUID.
- A known creation refusal (`EDQUOT`, `ENOSPC`, `EEXIST`) releases the charge
  and fences the identity.
- An unknown outcome keeps the reservation charged.
- A deletion timeout, for example a retained descriptor, cwd or mount, stays
  `deleting` and charged.
- `deleted` keeps the lingering owner charge.
- `reclaimed` is recorded only when the root is out of the census, no longer
  dropping, and its owner charge is zero or its qgroup is gone.

A different root at a recorded path, or any identity mismatch, refuses use and
deletion. Released identities can never be recreated. Retained identities are
bounded by `maxIdentities`.

The SDK lease ledger records pool roots in a separate table. Dead-owner
recovery and app shutdown never delete them, because reference roots outlive
any one app process. Deletion requires a recorded app lease.

## Publication views (#2429)

Readers must see a refreshed source on their next path read without a per-turn
copy, a per-reader pin, or any view of staging
([reference-worktree decision](reference-worktrees.md#request-only-refresh-and-moving-readers)).
Binding a sealed root into a worker pins that root: replacing the root behind
the bind changes nothing the worker sees. The pool therefore publishes through
**views**: one manager-owned directory per sharing domain, `views/<view>`,
root-owned and mode 0755. A worker binds the whole view, never a root.

`poolPublish` takes a sealed source root, a caller-generated view identity and
a plain name. The first publication moves the root from `roots/` into the view
directory and records the view in its intent; a root belongs to one view for
the rest of its life. The name is a relative symlink to the root's identity,
replaced by writing a temporary symlink and renaming it over the old one. A
reader's next lookup of `<view>/<name>` therefore resolves the whole previous
root or the whole new one. Open files and working directories keep the
revision they opened, so a multi-step read may span revisions. `poolUnpublish`
removes a name; releasing a root first removes every name that points to it.
`poolWithdraw` removes a root's names and moves it back into the masked
`roots/` directory, so a reader of the view can no longer reach it by name or by
identity. Withdrawal is how lost authority takes effect while readers still
hold the root: they keep the files they already opened, and the root stays
charged until it is released. Every publication verifies that the root is
read-only, and reseals it if an earlier move was interrupted.

Btrfs refuses to move a read-only subvolume (`EROFS`). Publication clears the
root's read-only flag, renames it and reseals it inside the manager's single
serialized request. The root's top directory is root-owned and its writers have
finished, so nothing can grow it in that window. Startup reseals any sealed root
left writable, and measurement adopts, and reseals, a root found in a view that
its intent does not record yet, after verifying its identity. Census accepts a root only in the
directory its intent records. Sealing also makes the root's top directory
`0755 root:root`, so any worker identity can traverse it; writable roots are
`0770 root:<app group>` so the app's acquisition writers can fill them.

`roots/` and `views/` join the mandatory worker masks. A worker sees reference
source only through a view bound for it, and other domains' views stay
invisible.

## Worktree checkpoints and access generations (#2430)

A managed worktree is a `worktree` root: a writable snapshot of one sealed
source root. Copy-on-write keeps every edit inside the worktree, the source
stays read-only, and the shared extents stay charged once to the source. Two
mechanisms let the host observe and expose it.

**Checkpoints.** `poolCheckpoint(id, from)` takes a read-only snapshot of one
writable worktree. The snapshot is created read-only inside its own
transaction, with a 1 MiB kernel allowance (`REFERENCE_POOL_CHECKPOINT_BYTES`):
it owns only the tree blocks it allocates, and later copy-on-write by the
worktree is charged to the worktree. `poolDelta(from, to)` streams a
metadata-only `btrfs send` between two checkpoints of the same worktree, framed
like brain deltas; any other pair refuses. `poolReadCheckpoint` reads a
checkpoint through the same fixed worker-UID reader as brain checkpoints. A
worktree takes a checkpoint at every journal observation, so a checkpoint's
intent is removed once its reclamation is proved, including a creation that
was refused, and checkpoints never exhaust `maxIdentities`. The manager
keeps the 512 most recently forgotten identities in a private record that
survives restarts: a retried release still reads as reclaimed, and such an
identity is never created again. Only the server's own lease names checkpoints,
and it generates a new identity each time. A worktree is never created from a checkpoint.

**Access generations.** A worker reaches a worktree only through an access
generation: one manager-owned directory `access/<generation>`, root-owned and
mode 0755, bound whole into one worker generation. `poolAccess(id, access)`
renames a writable worktree into it, `poolPark(id)` renames it back into the
masked `roots/`, and `poolAccessClose(access)` parks everything and removes
the directory. A running sandbox sees a grant on its next path lookup and loses
a parked worktree the same way, so no mount is ever added to its namespace.
Btrfs renames writable subvolumes freely. A worktree held by one generation
must be parked before another can take it, so a stale generation can neither
keep nor pass on a grant. The worker cannot create entries in the generation
directory itself. `access/` joins the mandatory worker masks. Census accepts a
writable worktree only in the directory its intent records, and measurement
adopts a grant or park interrupted between its rename and its record.

## Native qualification

`bun scripts/prove-reference-pool.ts` runs `reference-pool-fixture.py` inside
the pinned offline native image. The fixture owns a fully allocated 1 GiB brain
store loop and a separate sparse 2 GiB pool loop with `discard=async`, enables
simple quotas through `BTRFS_IOC_QUOTA_CTL`, and runs
`scripts/native-proof/reference-pool.native.ts` against the real manager. Small
configured limits stand in for the defaults: 256 MiB combined and 32 MiB per
operation. The fixture cannot demonstrate a 10 GiB exhaustion run. Observations
from the qualifying run follow (kernel 6.18 WSL2, btrfs-progs 6.6.3).

| Case | Physical Δ (charged) | Owner Δ | Ratio |
| --- | ---: | ---: | ---: |
| 20 MiB random data plus a 64-file Git commit and branch | 21,663,744 | 21,303,296 | 1.017 |
| 4 MiB COW overwrite in a snapshot, plus a truncation | 4,259,840 | 4,210,688 | 1.012 |
| 8,700,000-byte compressible text, zstd | 274,432 | 274,432 | 1.000 |
| 1,000 inline files | 1,048,576 | 524,288 | 2.000 |
| Mixed root (compressed, sparse, inline, preallocated, hardlinked, reflinked, partially cloned) | 26,558,464 | 25,985,024 | 1.022 |
| 4,000 empty files in 40 directories | 3,538,944 | 1,736,704 | 2.038 |

Every ratio stayed below the reservation factor of 2.125 for single data with
DUP metadata. Metadata-only growth comes closest. The run also observed the
following:

- Writes past a 32 MiB allowance failed with `EDQUOT`; the existing 20 MiB file
  stayed intact.
- A snapshot of a sealed 21 MiB source added under 32 MiB to the charge.
- A 4 GiB sparse file with 4 KiB written added under 1 MiB.
- An 8 MiB preallocation was charged in full.
- Fifty hardlinks and two reflinks added under 1 MiB.
- A 4 KiB clone of a 12 MiB extent kept 12.6 MiB allocated after the original
  file was deleted.
- Compression charged the on-disk size: 274,432 bytes for 8.7 MB of text.
  Btrfs `st_blocks` reports uncompressed bytes, which is another reason the
  file-length inventory is not this metric. One large `writeFileSync` of the
  same text stayed a single uncompressed extent; the case streams ordinary
  writes instead.
- With 172.8 MB available and 71.3 MB reserved per 32 MiB request, three
  concurrent requests admitted exactly two and refused one with `capacity`.
- A second ledger consumer claiming 1 TiB drove headroom to −179.8 GB and
  refused admission. Removing it restored the exact headroom identity.
- Deleting the source while its snapshot (and a reflink of it) remained left
  the source `deleted`, still charged 21,270,528 bytes. Reclamation was
  recorded only after both descendants were released.
- A descriptor held open past a 4-second deadline left the root `deleting` and
  charged. After the descriptor closed, the same identity reached `reclaimed`.
- Each crash case reconstructed on restart: reserved with no root, created but
  recorded as reserved, deleting before the delete, and deleting after it.
- An impostor subvolume at a recorded path was neither used nor deleted; a
  foreign qgroup and a nested subvolume each refused admission.
- A pool filled to `ENOSPC` refused admission and still released a root.
- The `brain-native-store pool` projection reported status and released a root
  through the running socket.
- At the end the charge was back to within 64 KiB of the 327,680-byte baseline.
- Publication (#2429): a bubblewrap reader bound only to one view read the
  published revision, and read the refreshed revision on its next path read after
  the name swap. Its open file and working directory kept the first revision. It
  never saw a writable snapshot being filled, and publishing that snapshot before
  sealing refused. Another domain's view and the pool itself stayed invisible,
  unpublishing removed the name for the next read, and a publish interrupted
  after its rename, with the root left writable, was resealed and adopted on
  restart. A withdrawn root disappeared from the reader's listing while its
  open file still read the old revision, and republishing a root left writable
  resealed it first.
- Managed worktrees (#2430): an edit in a worktree left its sealed source
  byte-identical, and a write to the source failed with `EROFS`. Checkpoints
  were read-only; the delta between two of them named the deleted and the added
  file, but not the file edited before the first checkpoint. A delta across two
  worktrees and a worktree created from a checkpoint both refused. A non-root
  bubblewrap worker (UID 1001, app group) bound to one empty access generation
  saw the worktree appear after the grant, read and edited it, and the edits
  landed in the worktree, never in the source. It could not create an entry in
  the generation directory, saw neither the pool nor another generation's
  worktree, and a cross-generation grant refused. Parking removed the worktree
  from its next lookup. A grant interrupted after its rename was adopted on
  restart and stayed visible; closing the generation parked it and removed the
  directory. Released checkpoints were forgotten once reclaimed; a retried
  release still read as reclaimed, also after a manager restart, and the
  identity could not be recreated.

The baseline was 4,521,984 aggregate bytes: the 4 MiB emergency file plus
311,296 bytes of global metadata on an empty volume.

## Alternatives

- Full qgroups: the documented snapshot performance and consistency
  problems, and rescans, for an attribution squota supplies directly.
- A user-space extent/backreference reader: it supplies no enforcement against
  direct writes, and it needs a multi-call consistent snapshot plus separate
  metadata attribution.
- `st_blocks` or file-length sums: these charge shared extents repeatedly.
- The advertised filesystem size: it is not allocation.
- A pool inside the brain store: it would require qgroups there.

# Decision — reference pool allocation, admission and recovery

[#2428](https://github.com/schlessera/brain-kit/issues/2428) implements the
storage foundation that the [reference-worktree decision](reference-worktrees.md#a-separate-logical-btrfs-volume-and-finite-allocation-budget)
selected: a separate logical Btrfs volume with a combined allowance (10 GiB by
default) and a per-operation allowance (2 GiB by default), both charged as
actual allocated disk. That decision left the mechanism to implementation.
This record names the mechanism, the primary sources it relies on and the
native observations that qualified it. The pool is managed by the existing
host-only native manager
(`createNativeReferencePool`, `packages/ui-sdk/src/server/native-reference-pool.ts:250-600`).
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

## Native qualification

`bun scripts/prove-reference-pool.ts` runs `reference-pool-fixture.py` inside
the pinned offline native image. The fixture owns a fully allocated 1 GiB brain
store loop and a separate sparse 2 GiB pool loop with `discard=async`, enables
simple quotas through `BTRFS_IOC_QUOTA_CTL`, and runs
`scripts/native-proof/reference-pool.native.ts` against the real manager. Small
configured limits stand in for the defaults: 256 MiB combined and 32 MiB per
operation. The fixture cannot demonstrate a 10 GiB exhaustion run. Observations
from the qualifying run follow (kernel 6.18 WSL2, btrfs-progs 6.6.3).

OBSERVATIONS

## Alternatives

- Full qgroups: the documented snapshot performance and consistency
  problems, and rescans, for an attribution squota supplies directly.
- A user-space extent/backreference reader: it supplies no enforcement against
  direct writes, and it needs a multi-call consistent snapshot plus separate
  metadata attribution.
- `st_blocks` or file-length sums: these charge shared extents repeatedly.
- The advertised filesystem size: it is not allocation.
- A pool inside the brain store: it would require qgroups there.

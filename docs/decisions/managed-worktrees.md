# Decision — managed reference worktree lifecycle

[#2430](https://github.com/schlessera/brain-kit/issues/2430) implements the
managed worktrees of the [reference-worktree decision](reference-worktrees.md#centrally-managed-writable-worktrees):
a writable copy of authorized shared source with a fixed reported starting
commit. It builds on the [acquisition service](reference-source-acquisition.md)
and the pool's [checkpoints and access generations](reference-pool-accounting.md#worktree-checkpoints-and-access-generations-2430).
This record names the concrete choices the rulings left to implementation. The
service is `createReferenceWorktrees`
(`createReferenceWorktrees`, `packages/ui-server/src/brain/reference-worktrees.ts:119-462`),
created with the acquisition service. Agent tools that call it arrive with
[#2432](https://github.com/schlessera/brain-kit/issues/2432); cleanup of
eligible worktrees belongs to [#2431](https://github.com/schlessera/brain-kit/issues/2431).

## Allocation

A request names the principal, a repository and a branch or tag, like a source
request. The service asks the acquisition service for that source, so its
authority, freshness and private boundary all apply, and then snapshots the
sealed source root it was given
(`async function allocate`, `packages/ui-server/src/brain/reference-worktrees.ts:264-293`).
The worktree's starting commit is the commit that source reported, and it never
moves with the source. A read-only baseline checkpoint is taken at once. Each
worktree gets the pool's per-operation allowance. A worktree belongs to one
principal; another principal's identity reads as missing.

The worktree is recorded before the pool sees it. An allocation that fails, or
one interrupted by a restart, releases its roots and only then forgets the
record. While any worktree record names a source root, capacity eviction and
startup recovery keep that root: a snapshot keeps its source's extents and
owner charge, so releasing the source would free nothing.

## Worker generations and access

A worker generation is one access generation in the pool, opened for one
running turn of one principal under the `governed` or `strict` profile. A
restricted (autonomous) turn holds no worktree. The generation records the
owning process (PID, start time, boot and PID namespace).

Access makes a worktree available to one open generation
(`function access(input`, `packages/ui-server/src/brain/reference-worktrees.ts:347-357`):

1. The generation must be open in this process for a running turn, and belong
   to the requesting principal.
2. The worktree must belong to that principal and not be released.
3. A worktree held by another generation is busy while that holder is live or
   of unknown liveness. A holder that is provably gone is parked first.
4. Authority is checked again: a path or a cached identity grants nothing. A
   worktree of private source needs a live grant covering its repository at
   every access, even if its branch has since become public. The repository's
   revision is then validated through the acquisition service under its own
   clocks, and the grant is read again after that and after coverage, just
   before the move. A revoked grant, or an expired validation that cannot be
   renewed, refuses.
5. Journal coverage is established for the turn before the pool moves the
   worktree into the generation. Without coverage the service refuses access,
   so no worker reaches a worktree that is not journaled.

Access, resumption after expiry and explicit renewal are the only operations
that move `accessed_at`. Allocation counts as an access. Reads, writes,
commands, listings, journal observation and reconciliation never do. Release is
final: a released worktree cannot be resumed.

Opening a generation registers it as running and accepting grants in this
process. Before the turn's final journal observation, the generation is
retired: it stops accepting grants, and closing waits for any access already in
flight. Everything granted is therefore covered by that final observation, and
no holder can name a closed generation.

## Liveness, expiry and retention

A generation is **live** while its turn runs in this process, or while another
process that owns it is alive. It is provably **gone** when it was closed, when
the boot changed, when its owner process is dead, or when it is this process's
own generation and its turn no longer runs; that record is process-wide, so
every service instance in the process reads the same evidence. Closing a
service ends the registration of the generations it opened. Any other case,
such as an owner in another PID namespace, is **unknown**
(`function live`, `packages/ui-server/src/brain/reference-worktrees.ts:172-178`).

Reconciliation runs at startup and when a generation closes, never on a timer
(`async function reconcile`, `packages/ui-server/src/brain/reference-worktrees.ts:414-431`).
After three days without explicit activity, a worktree expires:

- with a live holder it stays `active` and held, however long the turn runs;
- with a holder that is gone, the worktree is parked and the holder forgotten;
- with a holder of unknown liveness, ownership is kept, the worktree stays in
  its generation and stays charged.

Closing a generation parks everything it holds after the turn's final journal
observation. Nothing in this layer deletes a worktree.

## Worker access

Each governed or strict turn whose journal is recording opens one worker
generation, and every worker of that turn binds the generation's root-owned
directory whole at `/tmp/brain-worktrees`, inside the turn's own `/tmp`
(`// Managed worktrees (#2430): a journaled turn's workers bind one empty generation.`, `packages/ui-server/src/ws/run-session.ts:544-556`;
`// Managed worktrees (#2430): the whole access generation`, `packages/ui-sdk/src/server/worker-launcher.ts:752-763`).
A granted worktree appears there as `/tmp/brain-worktrees/<worktree id>/` on the
worker's next path lookup; the worker cannot create entries beside it, and a
restricted worker never binds a generation. Nothing returns a host path to the
agent. After the turn's workers exit and its final journal observation is
recorded, the generation closes and parks what it held. A turn whose
generation cannot be opened runs without worktree access.

Generations open only when the host enables worktree access
(`WsHost.referenceWorktreeAccess`), which the supported worktree tools of
#2432 do. Until then no turn binds a generation, so this layer adds no
reachable write path.

Acquisition checks out source group-writable (umask 002, Git metadata
directories 0775). Sealed source stays read-only whatever its modes say, and a
worker identity in the app group can edit the files its worktree inherited.

## Journal and scope

A managed worktree is not inside the brain, so the brain's checkpoints never
cover it. The turn journal observes each covered worktree as its own root,
through that worktree's read-only checkpoints and deltas and the same observer
and capture as the brain
(`attachWorktree(turnId: string`, `packages/ui-server/src/brain/turn-journal.ts:367-379`;
`// Each managed worktree is observed through its own checkpoints`, `packages/ui-server/src/brain/turn-journal.ts:213-226`).
Coverage starts with a baseline checkpoint and inventory before the grant, and
every journal observation, periodic, at a scope cap or at the turn's end, then
observes the worktree too.

- **Identity.** A change is recorded under the logical path
  `reference-worktree://<worktree id>/<path>` with scope `reference_worktree`.
  It is never a host or worker path, and history revert never writes it into
  the brain.
- **Classification.** Worktree changes are `content` of the one turn that holds
  the worktree, never steering of the brain. The worktree's own `.gitignore`
  marks ignored versions, and Git internals are excluded except the raw
  `HEAD`/refs coverage, as for workspaces.
- **Scope.** Changed paths and observed bytes count toward the turn's scope
  caps like workspace edits; they are not an exemption.
- **Failure.** An unreadable entry is recorded as missing and makes the turn
  partial. A worktree observation that fails stops its holding turn and leaves
  it partial; other turns continue.

Ordinary brain and workspace journaling is unchanged.

## Guidance

Workers with a bound generation receive fixed guidance in the existing sandbox
note (`const WORKTREE_GUIDANCE`, `packages/ui-sdk/src/server/worker-sandbox.ts:456-462`):
shared source is read-only and moves, a worktree starts at a reported commit
that never moves, where to work, that edits are journaled and scope-counted,
that only explicit access or renewal resets the three-day clock, that expiry
and release keep unfinished work, and that release is final. The text names no
identity, commit or host path, so it is the same for every turn; live facts
arrive only in the results that grant access.

## Cleanup eligibility facts

Release and expiry record durable facts for hygiene review
(`async function assessWork`, `packages/ui-server/src/brain/reference-worktrees.ts:208-246`):
the reason, the holder (`none`, `live` or `unknown`) and whether work remains
(`none`, `unpreserved` or `unknown`). Work is read from a fresh read-only
checkpoint and a metadata delta against the baseline. Nothing of the worktree
runs. Candidates are every path the delta names, including both ends of each
rename. A candidate counts as changed when its mode, inode, link count, size,
modification or change time or link target differs, directories included, so a
swap through a temporary name is work. Access time does not count, so reading
files is not work. A candidate whose metadata cannot be compared makes the
result `unknown`. Each assessment checkpoint is recorded with its owning
process before it is created, released even when its creation reply was lost,
and forgotten once released.

A worktree is `eligible` only with no holder and no work. Any change, including
a commit, an index refresh or an untracked file, is unpreserved work: no host
operation preserves worktree content elsewhere. A release while a worker holds the
worktree is assessed when that generation closes. The facts are evidence for
review, not approval: #2431 revalidates identity, ownership and work before it
acts.

## Evidence

`reference-worktrees.test.ts` drives the service with a directory-backed pool
double and a scripted transport. Named mutations cover implicit renewal, a live
holder losing protection past expiry, unknown liveness treated as gone, a
generation of another principal, a grant crossing generations, access without
journal coverage, coverage after the grant and access without an authority
recheck. An independent review added cases for a private worktree whose branch
became public after its grant was revoked, a grant in flight while its
generation closes, a second service instance in the same process and the
assessment checkpoint ledger. The native pool proof covers source isolation and the access
generation itself.

`reference-worktree-journal.test.ts` runs the turn journal over a copied
fixture brain and a worktree in the pool double. Named mutations cover a
journal that ignores separate roots, scope facts without worktree changes and
a swallowed worktree capture failure. `worker-sandbox.test.ts` mutates the
generation's ownership check. Native case 18 runs the real services against the
simple-quota pool: a worktree allocated from acquired source is covered and
granted, a non-root sandbox edits two inherited and new files through its
generation, and the journal records exactly those paths from the worktree's own
checkpoints with two changed paths counted by scope. Release reports the work as
unpreserved; a second worktree whose worker only read 1,200 files is eligible.
Native mutations cover a checkout without group write and an access-time
comparison that turned a read into work.

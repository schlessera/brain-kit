# Decision — managed reference worktree lifecycle

[#2430](https://github.com/schlessera/brain-kit/issues/2430) implements the
managed worktrees of the [reference-worktree decision](reference-worktrees.md#centrally-managed-writable-worktrees):
a writable copy of authorized shared source with a fixed reported starting
commit. It builds on the [acquisition service](reference-source-acquisition.md)
and the pool's [checkpoints and access generations](reference-pool-accounting.md#worktree-checkpoints-and-access-generations-2430).
This record names the concrete choices the rulings left to implementation. The
service is `createReferenceWorktrees`
(`createReferenceWorktrees`, `packages/ui-server/src/brain/reference-worktrees.ts:150-691`),
created with the acquisition service. Agent tools that call it arrive with
[#2432](https://github.com/schlessera/brain-kit/issues/2432). Hygiene findings,
review and cleanup arrived with [#2431](https://github.com/schlessera/brain-kit/issues/2431)
([hygiene and cleanup](#hygiene-and-cleanup)).

## Allocation

A request names the principal, a repository and a branch or tag, like a source
request. The service asks the acquisition service for that source, so its
authority, freshness and private boundary all apply, and then snapshots the
sealed source root it was given
(`async function allocate`, `packages/ui-server/src/brain/reference-worktrees.ts:429-459`).
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
(`function access(input`, `packages/ui-server/src/brain/reference-worktrees.ts:513-523`):

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
(`function live`, `packages/ui-server/src/brain/reference-worktrees.ts:204-210`).

Reconciliation runs at startup and when a generation closes, never on a timer
(`async function reconcile`, `packages/ui-server/src/brain/reference-worktrees.ts:587-614`).
After three days without explicit activity, a worktree expires:

- with a live holder it stays `active` and held, however long the turn runs;
- with a holder that is gone, the worktree is parked and the holder forgotten;
- with a holder of unknown liveness, ownership is kept, the worktree stays in
  its generation and stays charged.

Closing a generation parks everything it holds after the turn's final journal
observation. Expiry never deletes a worktree that holds work or whose state is
unknown; what happens next is in [hygiene and cleanup](#hygiene-and-cleanup).

## Worker access

Each governed or strict turn whose journal is recording opens one worker
generation, and every worker of that turn binds the generation's root-owned
directory whole at `/tmp/brain-worktrees`, inside the turn's own `/tmp`
(`// Managed worktrees (#2430): a journaled turn's workers bind one empty generation.`, `packages/ui-server/src/ws/run-session.ts:544-556`;
`// Managed worktrees (#2430): the whole access generation`, `packages/ui-sdk/src/server/worker-launcher.ts:775-786`).
A granted worktree appears there as `/tmp/brain-worktrees/<worktree id>/` on the
worker's next path lookup; the worker cannot create entries beside it, and a
restricted worker never binds a generation. Nothing returns a host path to the
agent. After the turn's workers exit, the generation is retired, so no grant can
follow; the turn's final journal observation is then recorded, and the
generation closes and parks what it held. Parking renames the worktree, so it
must never happen while a worker of that generation could still hold a
descriptor inside it: the generation closes only after its workers exited, and
recovery parks only for a holder that is provably gone. A turn whose
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
(`attachWorktree(turnId: string`, `packages/ui-server/src/brain/turn-journal.ts:370-382`;
`// Each managed worktree is observed through its own checkpoints`, `packages/ui-server/src/brain/turn-journal.ts:216-229`).
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
- **Ownership.** Each observation checkpoint is recorded with the process that
  took it before it exists and forgotten once released. Startup recovery
  releases only checkpoints whose owner is provably gone (another boot or a dead
  process); a live or unverifiable owner keeps them.

Ordinary brain and workspace journaling is unchanged.

## Guidance

Workers with a bound generation receive fixed guidance in the existing sandbox
note (`const WORKTREE_GUIDANCE`, `packages/ui-sdk/src/server/worker-sandbox.ts:480-486`):
shared source is read-only and moves, a worktree starts at a reported commit
that never moves, where to work, that edits are journaled and scope-counted,
that only explicit access or renewal resets the three-day clock, that expiry
and release keep unfinished work, and that release is final. The text names no
identity, commit or host path, so it is the same for every turn; live facts
arrive only in the results that grant access.

## Cleanup eligibility facts

Release and expiry record durable facts for hygiene review
(`async function assessWork`, `packages/ui-server/src/brain/reference-worktrees.ts:240-283`):
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
review, not approval: removal revalidates identity, ownership and work
immediately before it acts.

## Hygiene and cleanup

[#2431](https://github.com/schlessera/brain-kit/issues/2431) turns the cleanup
facts into hygiene findings, human review and removal. The maintainer ruled on
2026-10-23 how the two fit together.

**Host-only findings.** Managed worktrees are volatile hosting state: an
implementation detail of how a brain is hosted, not canonical brain data. The
rule that Markdown is the source of truth covers brain content, and this state
is outside it. Worktree findings and their dispositions therefore live in the
host database (`reference_worktree_findings`). They are never written to
`context/hygiene/`, and `brain hygiene list` never shows them. They reuse core's
finding identity and fingerprint (`canonicalFindings`) and its selection
(`selectHygieneNext`), and they join the same human-started review queue. A
lost host database loses these dispositions together with the worktrees'
ownership records; no brain content is lost.

**Detection.** A worktree is one finding at most
(`function kindOf`, `packages/ui-server/src/brain/reference-worktree-hygiene.ts:77-84`):

- `retained`: released or expired, held by no generation, with unpreserved work;
- `unknown`: its holder's liveness, its owner or its work cannot be established,
  even for a single changed path;
- `cleanup-failed`: a removal failed or was interrupted.

A live holder, a positively clean worktree or a removal under way is no
finding. The finding's category is `managed-worktree` and its path
`reference-worktree://<worktree id>`; its ID names only the worktree, so repeated
scans yield the same ID and a worktree is one finding whatever its kind. Its
fingerprint covers the kind, the native identity and owning principal, the
source domain, repository, revision and starting commit, the holder and its
liveness, the work (state, counts and a digest of every changed path's type,
mode, size, link target and file bytes, or its absence; times are left out
because a worker can set them), any removal failure, and the state and last
explicit activity
(`export function referenceWorktreeCandidate`, `packages/ui-server/src/brain/reference-worktree-hygiene.ts:94-110`).
The time of an assessment is not in it, so a fresh assessment of unchanged work
is the same evidence. One assessment hashes at most 64 MiB of changed files,
read without blocking the server; a larger or sparse file is named instead by its
inode and modification and change times, which a snapshot keeps and a worker
cannot set back. A deleted path is established work, not unknown work. A removal
whose outcome has not been read back from the pool is an `unknown` finding, never
a resolved one.

**Dispositions.** Dismissal and snooze follow the Markdown log's state machine,
kept in the host table: each is bound to the fingerprint it was given for, an
unrelated change leaves it in place, a change to its own evidence reopens it with
an invalidation naming the changed fields, a snooze returns when due, and a
finding no longer detected is resolved. A disposition is bookkeeping. It is never
consent to remove anything, and nothing reads it as such.

**Privacy and authority.** Inbox Actions replicate to every usable principal,
so the card of a private worktree carries only its opaque identity, state and
counts: no repository, revision, commit, changed path or principal
(`function display(`, `packages/ui-server/src/brain/reference-worktree-hygiene.ts:179-197`).
A public worktree's card names its source and up to 16 changed paths. The owner
principal is an authorized reader and reviewer of a delegated agent's worktree
findings, as of any other finding; review authority stays with owner and ambient
principals, so a delegated agent can neither operate the review nor remove a
worktree through it.

**Review.** The review reads one backlog: `next` and `list` merge the CLI's
Markdown findings and the host's by core's ordinal rules (severity, known
urgency, age, identity), and every operation that names a host finding goes to
the host, never to the CLI
(`async function cli(args`, `packages/ui-server/src/inbox/hygiene-review.ts:45-57`).
A retained or failed worktree offers one repair, `delete-worktree`; an unknown
one offers none and stays kept and charged, and "check again" assesses it
afresh, after a failed removal too. Selection assesses its winner again before
the card is shown, and a winner whose preview could not be taken is selected
again or shown without that repair, so a card never offers a repair it cannot
confirm. A preview takes a fresh assessment and never removes anything. Because the ID does not carry the kind, a removal that fails
changes the finding's fingerprint: an approval or a recovered review attempt for
the earlier evidence reads as stale, never as fixed. A failure reaches the
replicated card as a fixed reason; the pool's own error, which can name host
paths, stays in the host receipt.

**Removal.** Every operation on one worktree, from any service instance in the
process, runs one at a time, so a grant and a removal never interleave. Across
processes the pool's own release refuses a worktree an access generation holds,
atomically with grants
([#2729](https://github.com/schlessera/brain-kit/issues/2729),
[pool accounting](reference-pool-accounting.md)), so a grant that lands between
the last check and the release fails the removal instead of losing the grant. The worktree
service is the only executor, through one effect
(`async function removeWorktree`, `packages/ui-server/src/brain/reference-worktrees.ts:332-371`).
Immediately before it, with no await between the last check and the receipt:

1. the worktree is released or expired, and no removal of it was already
   admitted;
2. no generation holds it, live or of unknown liveness;
3. a fresh assessment establishes all of its work, with no path left
   uncompared;
4. after that assessment, the pool shows it writable, outside every access
   generation and with the native root UUID recorded at allocation, so a grant
   that landed meanwhile or a root replaced under the same identity is refused,
   and nothing in its host record changed (holder, explicit activity, state,
   receipt);
5. the caller's premise holds against that assessment: automatic removal needs
   no work at all, and a reviewed removal needs the reviewed fingerprint and
   preview, so an edit, a resumption, a renewal, a worker start or a change in
   preservation since the preview refuses;
6. the reviewer's authority is read once more.

The receipt (`reference_worktree_cleanups`) is recorded before the pool sees the
release. The worktree is released first and its checkpoints after it, so a
failure before the deletion leaves the baseline in place and the work still
assessable. Once a removal was admitted, the identity is final: it is never
accessed, renewed or resumed again, whatever the outcome, and a grant whose
removal was admitted while it awaited the pool is withdrawn rather than
recorded. A failed or interrupted
removal keeps identity and charge and appears as a `cleanup-failed` finding,
once; only review retries it. A lost reply or a restart reads the pool's record
and never releases again; a deletion the pool already committed is completed,
which is the same effect. Once the worktree is deleted no checkpoint of it can
be created any more, so on a retry a checkpoint the pool no longer records is
gone, released before a crash or reclaimed and forgotten: it leaves the ledger
without another release, which would fail or leave a tombstone identity. The
lease owner holds a release's lease again when the pool never committed it (the
root is still writable or sealed), so a failed removal stays assessable; it never
does so over a newer release of the same identity
(`async function settle(`, `packages/ui-server/src/brain/reference-worktrees.ts:378-414`).
Capacity is credited only when the pool reports the worktree `reclaimed`:
until then its source root stays protected from eviction.

**Automatic removal.** Release, expiry and the close of a holding generation
remove a worktree only when its fresh assessment shows no holder and no work
(`function removeClean`, `packages/ui-server/src/brain/reference-worktrees.ts:301-304`).
Reconciliation retries a clean worktree whose removal could not run. Nothing is
archived or purged speculatively, and a worktree whose work or owner is
unknown is never removed automatically. Arbitrary repositories and shared
source are never touched: the effect names one pool worktree identity.

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
After the independent review, case 18 also launches a worker through the
production launcher with the manager's real masks: it sees only its granted
worktree and an empty pool, views and access directories. A worker that swaps
two directories through a temporary name leaves every name in place, and the
release reports unpreserved work naming both directories. A recovery case
releases only checkpoints of a provably ended owner.
`ws-reference-worktrees.test.ts` runs a real host turn with the worktree
service stubbed: the worker sandbox binds the turn's generation, and the
generation retires before the turn's first final observation and closes after
it. A second review round added a grant revoked while revalidation awaits, a
lost assessment checkpoint reply and a closed service's generations.

`reference-worktree-hygiene.test.ts` drives detection, dispositions, review and
removal over the pool double, with the real hygiene review and core's hygiene
functions. Named mutations cover the issue's targets: repeated-scan
duplication, a private finding's details, dismissal read as removal consent, a
stale approval after an edit, a resumption or a replaced native root, removal
under a live or unknown holder, removal of unknown or partly unknown work, a
replayed removal after a lost reply, capacity credited before reclamation and
the reviewer's authority not read again. An independent review added an edit
that keeps size and restores the modification time, a grant that lands while a
removal assesses, a grant withdrawn after a removal was admitted, a pool error
reaching the card, evidence frozen after a failed removal, review recovery
reporting a failed removal as fixed and a forgotten checkpoint released into a
tombstone. Its second round added a deleted file read as unknown work, an
unresolved removal checked as gone, a card selected over stale evidence,
removal and grant interleaving across service instances, and, in
`native-brain-leases.test.ts`, an uncommitted release left unassessable and an
interrupted one after a restart. Its third round added a settled release
overriding a newer one, a settle retry after a crash and a card admitted with a
repair whose preview failed. Further mutations cover checkpoints released before the worktree,
access after a failed removal, a lost reply read as a failure, the
reconciliation retry and automatic removal itself. Native case 18 removes a clean
worktree automatically and a private worktree's retained work through the real
review against the simple-quota pool, and keeps the third worktree and its
shared source.

# Storage cleanup and retention discovery

Recommendation for [#1781](https://github.com/schlessera/brain-kit/issues/1781),
under [#1779](https://github.com/schlessera/brain-kit/issues/1779). This is design
input for [#1782](https://github.com/schlessera/brain-kit/issues/1782), coordinated
with the accounting discovery in [#1780](https://github.com/schlessera/brain-kit/issues/1780).
It approves no deletion policy, new retention default or runtime API.

Source inspected at `f2c98da6093c9e1731f061625ba7302f51bf7340`.
Final lifecycle review also includes `2ea27697850dfffe956f2aa8471a720ea738f2bb`:
[#1778](https://github.com/schlessera/brain-kit/issues/1778)'s delivered correction
separates immutable startup inputs from bounded copy-on-write output staging.
The synthetic measurement below retains its original source/conditions.
The [governed-worker decision](../decisions/governed-writable-workers.md),
[writable-area decision](../decisions/worker-writable-areas.md), and
[all-writer boundary](../decisions/policy-write-boundary.md) bind execution.
The governed record supersedes older read-only defaults and HOME overlays.

## Recommendation

Build storage inspection first, then expose existing bounded housekeeping
through its owners. Offer selected canonical attachment removal only after a
dedicated, stale-safe, journaled application operation exists. The current
file routes read files; they have no deletion endpoint. The curated application
route accepts ordinary Markdown, not arbitrary binaries
(`function validatePath`, `packages/ui-server/src/brain/application.ts:34-52`).
Document archive changes visibility/relevance and may move Markdown; it does
not remove an attachment or reclaim its history. Do not present it as Delete.

Use maintenance workers for repository code, the CLI and Git. Host routes may
perform narrowly validated descriptor operations, as the journal/revert do;
they must not evaluate brain configuration, hooks, filters or executables.
The existing brain client supplies boundary execution
(`async function execBrain`, `packages/ui-server/src/brain/client.ts:215-260`).
Do not turn the new surface into a host command runner or an extension seam.

Reuse existing authorization. A requested reversible, fully journaled edit
needs no extra approval solely because it appears under Storage. An unjournaled
delete is irreversible under the governing ruling and cannot masquerade as
that edit. Outward sync retains G5 policy/approval; command rules still apply
to shell actions. Protected policy paths retain R35. UI execution is bound to
the authenticated principal, exact selection and operation; revocation and
profile authority are checked again at execution. Restricted autonomous work
and voice gain no new tools from this recommendation.

## Operation matrix

Logical bytes, allocated bytes and available volume capacity are separate
measurements. Every row requires fresh after-state even when the operation
fails. A removed-byte count is not a volume-reclamation receipt. Temporary
space entries below are requirements to assess, not reservations implemented
by this spike.

| Operation / owner / primitive | Data and eligibility | Protection, revalidation and authority | Recovery / temporary space | Expected effect and after-measurement |
| --- | --- | --- | --- | --- |
| Selected content removal; core deterministic content semantics + ui-server application/journal; **proposed binary operation** | Canonical tracked/untracked attachments, individually selected. Ignored, unindexed and external-link cases need explicit classification. | Recheck exact root/parent/file identity, bytes/hash, permissions, protected paths, references and live ownership under the applicable gate/lock. Authenticated requested edit; no arbitrary host Git. | Retained, verified before-version required for reversible removal; current journal exclusions can make a file ineligible. CAS capture may copy its entire bytes and uses charged temporary capacity. | Current file count/bytes decrease; references can break. Measure working-tree bytes/status, retained journal bytes, local Git and per-volume availability separately. History/remotes can remain unchanged. |
| Attachment sidecars; core conversion/export owners + same application boundary; **proposed grouped selection** | Derived previews/OCR/Markdown/metadata only where provenance demonstrates the relationship. A filename suffix alone is insufficient. | Preview siblings and references; recheck each selected version. Never delete an independently edited or shared derivative automatically. Same authority as each selected content edit. | Each non-rebuildable selected file needs recovery bytes. Rebuildable sidecars still need a declared generator and resource/cost implications. | Report each removed, kept or conflicted sibling and actual aggregate delta. Regeneration can consume disk/CPU or paid services; no automatic paid rebuild. |
| Git packing; core `packRepository`, #398 | Local objects and refs, valid Git worktree. | Existing Git maintenance lock; worker boundary and existing Git locks. No ref deletion, reflog expiry, history rewrite or configuration mutation. | No history restoration needed because reachable content remains. Packs and old loose data coexist during packing; disk headroom and maintenance tmpfs admission are both required. | Loose count often drops; packs can grow before duplicate loose copies disappear. Measure loose+pack bytes, refs and availability after both passes; savings are workload-dependent. |
| Derived index refresh/rebuild/compaction; core index machinery, existing maintain/index entry points | `brain.db` and its owned sidecars only; content remains authority. | Run supported command in maintenance worker; use its locking and indexing configuration. Never infer that `ui.sqlite` or its sidecars are disposable. | Rebuild from Markdown; semantic data may require provider calls. Rebuild, WAL and vector compaction need headroom and can initially grow. | Index correctness/health is the goal, not guaranteed space savings. Report actual DB/sidecar bytes and failures, keeping existing stats contracts. |
| Eligible persistent scratch prune; core `pruneScratch`, server timer/pin bridge; #1656/#1691 | `.brain/scratch`; existing seven-day / 1 GiB policy for unpinned candidates. | Managed pins must be complete/readable; reread pins before each removal. Linked retained answers survive age and cap. Current writers pin their outputs for their own post-write pass. Use existing CLI boundary. | Unlinked scratch is ephemeral; no general Undo promise. Explicit `scratch clean` bypasses pin protection and must **not** back an ordinary safe-prune button. Pin refresh itself can need disk. | Existing report includes removals, failures, remaining/pinned bytes and overage. Show suspension/overage, never release pins merely to make the meter smaller. Re-measure allocated bytes/capacity independently. |
| Settled share staging cleanup; ui-server `createInboxCleanup`, #807/#686 | Server intake staging and partial directories associated with durable cleanup work. | Recovery gate, Queue/Action status, attempts, waits, lease/version and actual originating lifetime/settlement. Age or a terminal Queue row alone is insufficient. | Durable lease acknowledged after idempotent filesystem removal; restart resumes claimed work after recovery. Database writes still need headroom. | Existing sweep counts completed cleanup items, not exact bytes. Measure staged bytes after settlement; preserve attributable item outcomes instead of claiming everything in the directory was discarded. |
| Claude idle compression; backend `archiveIdleSessions`, #1621 | Native session trees idle strictly more than 30 days; at most daily. | Active IDs read after asynchronous metadata; checksum/source comparison before deleting live bytes. Private roots outside brain. Existing backend housekeeping, no session deletion implied. | Durable gzip/manifest/index precede source removal; restore before read/resume, conflicts keep newer live files. Full source and compressed copy coexist; code reads full individual files in memory. Not an emergency no-space operation. | Conversations remain listed. Measure combined live+archive+pending/conflict bytes; later restore can expand usage again. Compression is not guaranteed to save much for already compressed data. |
| Pi idle compression; backend #1637, **unavailable** at inspected source | Native Pi SessionManager trees. | #1637 owns same active-session/30-day/crash-safe policy; this spike does not implement it. | No shipped equivalent archive primitive verified. | Show unavailable, link existing work; do not promise Pi savings or create a duplicate task. |
| Workspace cleanup; ui-server journal + SDK writable areas, **proposed selective operation** | `workspaces/` may contain clones, uncommitted work, ignored build outputs and nested repositories. Index exclusion is not disposability. | Recheck running processes/jobs/locks, Git worktree/common-dir relationships, outside links/mounts, dirty/untracked state and journal coverage. No universal lease exists proving all arbitrary commands are idle. Unknown ownership is ineligible for unattended cleanup. | A recreatable clone still may contain unique work; copy/export guarantees must cover it before removal. Large directory copies are not admitted implicitly. | Report exact selected scope and excluded live/unknown work. Nested Git common storage must not be counted or removed as private to this workspace. No blanket age-based `rm -rf`. |
| Journal collection; ui-server `createTurnJournal` / accounting | Private CAS, journal-owned SQLite pages, manifests, reservations and quarantine/revert evidence. Existing 10 GiB cap / completed-detail retention. | Existing owner collects completed detail oldest-first under cap; active windows, shared refs and reader reservations protect objects. Do not offer a manual “cache clear” that circumvents ownership. | Detail expiry loses Undo; summaries can remain, and no pre-expiry deletion receipt extends retention. Existing cap collection is already approved; **new expiry rules are unresolved**. WAL/checkpoint needs safe headroom and can refuse reader contention. | Measure CAS and owned DB/WAL allocation, not just deleted rows. SQLite free pages may remain allocated. Label expired detail and remaining recovery window honestly. |
| Operational backups; ui-server export/restore + generated host scheduling/retention, #686 and hosting-template #9 | Full operational DB image and matching staging bytes; separate Git content backup. | Capture consistency checks; restore requires stopped writers, empty targets and matching checksum/recovery marker. Backup retention must preserve an operator-tested compatible recovery point. | At least 24-hour successful capture objective; replacement export has private temporary bytes. Retention policy and remote/provider deletion belong to host configuration, not a package default. | List known age/completeness/size; unknown remote or older artifacts stay unknown. Never delete recovery material to make an export fit. Report local and remote outcomes separately. |
| Runtime maintenance; SDK owned turn temp vs externally managed logs/images/layers | `turn_temp` only reaches the current worker's private `/tmp`; runtime state is excluded. Host/container caches and other users' data are outside ordinary app authority. | Existing scoped tool skips output-linked paths; named force may override, all+force refused; no-follow/device checks. No approval for this already-authorized scoped tool. No Docker socket or global prune. | Turn temp expires at exit; linked files promote via held descriptor. Purge is not Undo; runtime transcripts/settings/memory are not its targets. | Tool measures tmpfs usage/limit/actual delta and records governance; persistent storage reclamation is a separate metric. Host logs/images/volumes show externally managed/unavailable and generic operator guidance only. |
| Immutable native inputs and output staging; ui-sdk, #1790 | Short-lived read-only Btrfs checkpoints and separately bounded writable output. These are neither canonical content nor agent turn temp. | Durable owner leases and live references protect inputs and publication material. No storage-UI sweep of host temporary paths or deletion by guessed prefix. | Checkpoints consume the operator-configured hard managed-volume capacity. Recovery releases owned stages before their lower checkpoints; unknown ownership remains retained. Writable upper bytes/metadata use the existing staging allowance. | Measure managed-volume reclamation, writable upper allocation and canonical post-publication state separately. Removing a lower-only input does not free upper write capacity; whiteout metadata can consume it. No promise that canonical deletion fixes a staging-capacity refusal. |

Source foundations for the matrix:

- Packing runs two passes and deletes only loose duplicates already held in
  packs (`export function packRepository`, `packages/core/src/lib/git-storage.ts:76-84`).
  The upstream [maintenance manual](https://git-scm.com/docs/git-maintenance)
  explains these tasks; broad `gc` has different expiry behavior.
- Staging eligibility, removal and acknowledgment are separate
  (`export function createInboxCleanup`, `packages/ui-server/src/inbox/cleanup.ts:14-94`).
- Scratch pin loading and per-entry revalidation sit inside pruning
  (`export function pruneScratch`, `packages/core/src/lib/scratch.ts:626-707`);
  explicit clean is different
  (`export function cleanScratch`, `packages/core/src/lib/scratch.ts:710-728`).
  Server refresh refuses incomplete enumeration and confirms missing histories
  before releasing links (`function openScratchPins`, `packages/ui-server/src/cron/scratch-pins.ts:72-195`).
- Claude publishes and verifies cold copies before deleting the live source
  (`export async function archiveIdleSessions`, `packages/ui-backend-claude/src/transcript-archive.ts:188-242`).
- Journal collection requires no refs/reservations and only expires ended
  turns (`function collectObjects`, `packages/ui-server/src/brain/turn-journal.ts:115-139`).
  Retention is applied at admission
  (`begin(turnId: string`, `packages/ui-server/src/brain/turn-journal.ts:236-264`).
  Object copies reserve temporary bytes before writing
  (`async putFileAsync`, `packages/ui-server/src/brain/journal-objects.ts:66-118`).
- Turn-temp purge has its own scope and measured result
  (`export function purgeTurnTemp`, `packages/ui-sdk/src/server/worker-turn-temp.ts:412-494`),
  and tool validation/recording
  (`export function handleTurnTemp`, `packages/ui-sdk/src/server/bridge-tools/turn-temp.ts:19-41`).
  [Operational recovery](../inbox-recovery.md) specifies backup consistency and
  restart behavior; it is not an index rebuild.
- Startup input ownership is separate from writable staging
  (`export async function prepareNativeWorkerStartupView`, `packages/ui-sdk/src/server/worker-startup-view.ts:78-130`).
  The [native storage decision](../decisions/native-brain-storage.md) supersedes
  complete user-space startup copies and defines checkpoint recovery ownership.
  The staged-write limit states the separation
  (`export function outputStagingLimit`, `packages/ui-sdk/src/server/worker-state-limits.ts:144-150`).

## PDF larger than 5 MB: review and execution

Use decimal MB explicitly: strict `sizeBytes > 5_000_000`. Offer MiB separately
as 1,048,576 bytes. File count and total logical bytes belong to the current
filtered inventory. The accounting discovery owns physical identity, overlap,
volume scopes, partialness and freshness; cleanup consumes that model rather
than summing content and deployment totals.

1. Inspect authenticated file metadata/preview using the existing file reader.
   Display tracked/untracked/ignored status and reference evidence with its
   timestamp/completeness. Query indexed links, but also inspect bounded
   Markdown references and report unindexed/unsupported sources as unknown.
   A zero from the index is not proof of no attachments referenced in Markdown,
   retained conversations, external consumers or another workspace. Do not
   read every PDF's contents just to filter sizes.
2. Select exact files, then review references, related derivatives, current
   Git state and available recovery coverage. For a referenced PDF, offer Keep
   or an explicit removal selection with the broken-link consequence shown;
   editing the referencing note is a separately selected, version-bound effect.
   Do not silently rewrite references or cascade delete sidecars. Unknown
   dependencies remain disclosed and can make automated removal ineligible.
3. The proposed server operation uses principal/session/operation-bound
   idempotency and a durable selected-version manifest. Under the writer gate
   and appropriate content locks, recheck parent descriptors/device identity,
   existence/type/mode/link count, content hash, protected paths, active work,
   reference/provenance changes and journal eligibility. A changed file or
   changed consequence is a conflict requiring refreshed review; never widen
   the set after selection. Do not follow aliases or nested mounts.
4. Retain verified before bytes and record intent before unlink. Use the
   journal's own charged CAS/reader ownership; do not bypass retention to promise
   permanent Undo. Ignored files only listed by name/size, incomplete snapshots
   and unretained versions cannot qualify as reversible. Report refusal rather
   than upgrading authority. A new binary route must define this integration;
   the existing Markdown route cannot be reused by passing a `.pdf` path.
5. Unlink the exact eligible entry; reconcile observations and per-item durable
   status. Queue supported index refresh through its maintenance boundary.
   Worker/maintenance coordination must prevent a concurrent writer replacing
   the selected entry between validation and unlink. Existing shared gate
   admission alone is **not** an exclusive cleanup lock.
6. Report removed/conflicted/protected/failed/not-started separately, references
   left broken, sidecars kept, recovery receipt and expiry/partialness. Offer
   existing journal/revert only where eligible and version-verified. A restart
   reads the original operation receipt; it never blindly reissues deletion.
   Current content deletion and index refresh are distinct outcomes.
7. Git status initially shows deletion; supported sync may later commit and
   push through its credentialed maintenance boundary and G5 authority. A failed
   sync does not undo successful local removal. Report local, committed and
   remote-sync state independently. Previous commits still reach the PDF blob;
   a normal deletion commit is not historical/remote erasure. Git's
   [object traversal](https://git-scm.com/docs/git-rev-list) and
   [GC documentation](https://git-scm.com/docs/git-gc) distinguish reachability
   from storage optimization. Remote provider reclamation is not observed here.

## Pressure, cancellation and recovery

Before execution, classify headroom on **each actual capacity scope**: content,
private journal, operational DB, Git storage, maintenance tmpfs and backup
destination can differ. Logical admission is not proof that disk allocation
will succeed. Preflight cannot eliminate ENOSPC races, quotas or concurrent
writes. Use bounded batches, item/byte/time budgets and cancellation between
items; no recursive unbounded copy or “delete whatever is oldest” fallback.

Include immutable startup-copy disk headroom separately from the bounded
copy-on-write output upper. #1778 corrects the former accidental charging of
the whole input tree to output staging. A lower-only deletion can reduce a
published canonical tree without releasing upper write capacity, so candidate
file bytes cannot predict staging-limit relief. Input copy, staged writes,
turn temp and runtime state keep their own owners and capacity evidence.

At low space, prefer known eligible existing scratch/staging/turn-temp work
where its owner can safely record the outcome. Packing, archive compression,
index rebuilding and backup export need temporary space and must not be offered
as guaranteed immediate rescue. Deleting a journaled PDF may initially use
more storage if its before-version was not already retained.

At zero allocatable space, a new recovery manifest or CAS object can fail.
Refuse new reversible removals that cannot establish durable intent/recovery.
Do not purge journal objects, leases, WAL, authentication state, unsettled staging
or the last complete backup to make the operation succeed. Existing compensation
may remove already authorized eligible bytes but an acknowledgment can fail;
its durable original lease, not a success toast, governs restart. If safe
owned housekeeping cannot progress, show the refused store and required
headroom, and direct the operator to add capacity or manage externally owned
storage. This is an honest manual boundary, not a new privilege grant.

A proposed cleanup receipt must distinguish pre-unlink failure, successful
unlink awaiting reconciliation, complete local mutation awaiting indexing/sync,
and ambiguous result. After a crash, compare the selected before-version and
current entry under the same gate: an absent entry can complete reconciliation;
a replacement never gets deleted on retry. Reconcile intent against the actual
journal and source identity before reporting success. A mixed selection keeps
successful outcomes and does not roll them back automatically; retry only
unstarted eligible items. Cancellation stops admission of more items, finishes
the current critical reconciliation, and keeps completed receipts. Lost responses
read the original receipt. Undo is a fresh stale-safe operation, not a blind copy
over a newer file. Such a receipt protocol is proposed, not implemented here.

The writer gate is cross-process and tracks process identity, not age
(`export function createWriterGate`, `packages/ui-server/src/brain/writer-gate.ts:67-118`).
Use that primitive alongside lifecycle ownership; do not interpret stale leases
as proof an actually running backend is dead. Locks, retained readers and backups
can deliberately prevent immediate reclamation.

## Synthetic evidence

Run from a dependency-installed checkout:

```sh
bun experiments/storage-lifecycle.ts
bun run test packages/core/tests/scratch-pins.test.ts packages/ui-server/tests/inbox-unwind.test.ts packages/ui-backend-claude/tests/transcript-archive.test.ts packages/ui-server/tests/turn-journal.test.ts packages/ui-server/tests/journal-accounting.test.ts packages/ui-sdk/tests/turn-temp-tool.test.ts
```

The manual experiment mutates only a newly created temporary Odysseus brain,
bare local remote and operational store, then removes them. It uses the real
packing and journal primitives, local-only Git subprocesses, fixed synthetic
`2026-07-12` content/commit dates and deterministic PDF-shaped bytes. These are
binary lifecycle fixtures, not valid PDF-rendering proof. No service/network,
real corpus, cleanup API or retention change is exercised.

Observed with Bun 1.4.2, Git 2.55.0 on the local filesystem:

| Measurement | Before | After removal + other PDF edit + local commit | After existing Git packing |
| --- | ---: | ---: | ---: |
| Current PDF count | 2 | 1 | 1 |
| Current logical PDF bytes | 12,000,000 | 6,000,027 | 6,000,027 |
| Attachment allocated bytes | 12,001,280 | 6,000,640 | 6,000,640 |
| Local `.git` allocated bytes | 6,447,104 | 12,787,712 | 6,447,104 |
| Journal object allocated bytes | 6,012,928 | 12,001,280 | 12,001,280 |
| Local bare-remote allocated bytes | 6,430,720 | 6,430,720 | 6,430,720 |
| Loose object count | 5 | 9 | 0 |
| Objects in packs | 0 | 0 | 9 |

Both initial PDFs share identical bytes, so Git and journal deduplicate them.
The second gains 27 bytes after preview. Its hash differs, proving stale
selection evidence; the script observes that conflict but does not implement
the future executor. The first loses its working-tree entry while its referenced
Markdown link remains. A retained journal before-version matches all 6,000,000
original bytes. `rev-list --objects --all` still includes its blob and
`cat-file -s` returns 6,000,000 before and after packing, locally and in the
bare remote. Ref identities are unchanged by packing. There is no remote push.

The three selected local category deltas after removal sum to a **growth of
6,328,320 allocated bytes**: attachment -6,000,640, Git +6,340,608, journal
+5,988,352. Packing later saves 6,340,608 Git allocated bytes; that is neither
historical deletion nor guaranteed volume recovery. These figures exclude DB,
WAL, other files and filesystem metadata. They are `st_blocks * 512` category
observations on a quiescent fixture, not exact exclusive physical attribution
on CoW/compressed/shared storage, nor a free-volume or remote-quota measurement.
They must not be generalized into a savings estimator.

The existing six focused test files execute 66 passing cases / 439 assertions.
They demonstrate: ten-day pinned scratch survives while its unlinked peer expires;
missing/corrupt pins suspend deletion; active Claude sessions are excluded after
async metadata; archive/index/restore interruptions preserve session bytes;
a real gated backend after denial keeps staging until unwind/settlement;
SIGKILL recovery settles cost before one cleanup; journal capacity refuses an
initial snapshot and labels later missing observations partial; interrupted CAS
publication remains charged and recovered; and actual turn-temp purge refuses
runtime-state mounts. These are current primitive receipts, not proof of the
proposed storage UI or binary removal endpoint. They do not simulate a physically
full disk for all operations; no-space execution semantics above require future
ENOSPC/crash injection and actual constrained-volume verification.

Mutation receipt: replacing the archive's post-metadata active-session set with
an empty set makes `running sessions are checked after asynchronous SDK metadata
arrives` fail on `expect(listArchivedSessions(options)).toEqual([])` (one running
session was archived). The original source was restored; the same named test
then passed with both archive-empty and live-source assertions. No runtime
source change is part of this discovery.

## Design inputs, alternatives and unresolved decisions

Recommend the first operation set as inspection, existing non-destructive Git
packing, eligible pin-aware scratch prune and lifecycle-owned staging cleanup.
Backend compression remains existing transparent upkeep, with unavailable Pi
support owned by #1637. Runtime `turn_temp` remains scoped to its own admitted
worker. Generic scratch clean, session deletion, workspace sweeping, backup
purge, ref/reflog expiry, history rewriting/force push and broad container prune
are excluded from initial storage actions.

Prefer an explicit bounded binary content application over assembling shell
commands from user-selected paths: it can bind versions, consequences, journal
coverage and per-file recovery. Ordinary governed agent requests remain available
within their existing policy; this recommendation does not replace that flow or
claim arbitrary shell deletion is a storage API. A trash directory alone is not
a complete alternative: it still retains bytes, needs its own expiry/authority,
and can double storage across filesystems. A plain unlink without a retained
before-version cannot promise Undo.

Longer-term growth handling should reuse #1780's bounded snapshots and capacity
scopes: show which category is growing and which safe owned action can affect it.
Keep snapshot/receipt storage itself bounded. No alert threshold, polling cadence,
new retention duration, session eviction or backup expiry is selected here.
Packing/compression reduce representation costs; attachments, journal evidence
and backups may continue growing. Capacity provisioning remains a legitimate
outcome when protected content accounts for the usage.

Maintainer decisions remain explicit for any permanent loss of history, refs,
reflogs, journal detail beyond existing policy, session data or backup evidence.
Such proposals must specify affected copies/remotes, recovery loss, active/read
protections, rollback feasibility and required authority. Changing a retention
default is not approved by accepting this discovery. #1782 owns visible placement,
interaction, responsive/accessibility design and the final reviewed initial scope.

Proposed implementation slices, for #1782 to turn into scoped tracker work after
review (not a status checklist):

- **Accounting-to-review handoff:** consume #1780 identities, units, hierarchy,
  freshness, known/partial/unknown metrics and distinct volume deltas; add an
  operation eligibility/consequence view without changing existing stats.
- **Existing upkeep orchestration:** server-owned authenticated dispatch and
  attributable bounded results through current worker/pin/staging owners;
  prove live work, revocation, overlap, partial failure and zero-space refusals.
- **Canonical binary removal:** core-supported deterministic selection semantics
  and server application/journal receipt integration; exact-version locks,
  sidecar/reference policy, retained binary before-version, crash/restart,
  mixed-success and stale-safe Undo proof. Stable CLI/JSON/API additions need
  their own contract review, changeset and acceptance tests before shipping.
- **Growth and capacity guidance:** bounded history/refresh/cost model from
  #1780, honest unavailable/manual operations, no unreviewed retention defaults.
  #1637 continues independently; #686 and hosting-template #9 retain recovery
  ownership. No concrete additional generated-host change is established by
  this discovery, so no speculative hosting issue is filed.

These slices depend on the existing sibling design issue, rather than creating
parallel deletion policy or archive projects. Closing #1781 supplies evidence
and recommendations; it does not complete #1779 or authorize those slices.

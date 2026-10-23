# Decision — shared reference source and governed worktrees

The maintainer selected this workflow on **2026-10-18** in
[#2390](https://github.com/schlessera/brain-kit/issues/2390). Its consolidated
specification incorporates the corrections to the individual rulings linked
below. [#2418](https://github.com/schlessera/brain-kit/issues/2418) tracks this
durable record. These are selected requirements; the rulings themselves supply
no implementation, allocation measurement or runtime qualification.

## Why reference acquisition has a separate lifecycle

The issue records a source-inspection checkout acquired under `workspaces/`
producing 5,332 journal paths, including 5,067 content and 265 steering entries.
The turn hit its 1,000 changed-path cap and eventually its independent timeout.
Those are retained journal and Activity observations, not a Git commit count.
Acquiring source to read it needs bounded storage and authority, but should not
consume the brain-content changed-path allowance as thousands of intentional
edits. Editing that source still requires governed, reviewable workspace work.

The [persistent-cache ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6247124178)
places application-managed reference source outside brain content, indexing,
capture and sync. Ordinary readers share source rather than receiving a full
copy per agent or step. Reference source is read-only to agents. This creates
no blanket `workspaces/` journal exemption and does not authorize changes to
user-owned custom skills or automatic cleanup of arbitrary workspace repos.

## Authority and credential isolation

The [connection ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248055518)
allows acquisition through a repository connection already authorized for the
requesting principal, including private access, without an additional approval.
Host credential availability alone grants no authority. Existing principal,
profile, network and governance restrictions continue to apply. Credentials
remain in an isolated transport; no process evaluating repository-controlled
inputs or reading source receives them.

> **2026-10-22 — Authority (#2429).** An "already authorized connection" is an
> [owner-managed reference-source grant](reference-source-grants.md) of brain,
> principal, repository prefix and named host credential, checked live at every
> use.

The [sharing ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248113277)
shares public source across the application host and isolates private source
per brain and principal. Cached bytes do not grant access. Anonymous access to
a repository homepage is insufficient evidence that the requested revision is
public; public-to-private transitions must not expose private revisions under
public cache authority.

The [validation ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248130638)
gives successful repository/revision authorization and public-visibility checks
a configurable five-minute lifetime. Local revocation blocks new access
immediately. After expiry, a successful fresh check is required before a new
mount; failure or inability to check refuses it. An outage allows reuse only
inside still-valid authority. Validation cannot retract bytes already read.

## Request-only refresh and moving readers

The [refresh clarification](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248351828)
supersedes the earlier periodic-refresh wording: refresh happens only on
request, with a five-minute cooldown from the last successful source refresh.
Requests inside that interval reuse the current source; the first request
afterward attempts refresh. There is no background refresh or deferred timer.
Authorization validation and source freshness have independent timestamps and
checks even though their initial periods are equal.

The [reader-consistency ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248364731)
keeps shared reads live. Existing readers see refreshed source on subsequent
reads; a multi-step inspection may span revisions. Readers protect source
against capacity eviction, not revision updates. Publish only complete,
validated acquisition results, and report the current revision and freshness
honestly. Stable multi-step reads require a managed worktree from a reported
commit, rather than pinning shared source per turn or waiting for all readers
before refreshing.

The [failure ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248467569)
returns the previous usable authorized source when refresh fails, explicitly
reporting stale status, its exact commit, the last successful refresh time and
the error. Failure never advances that timestamp or publishes partial staging.
Without usable authorized source, refuse. Stale fallback does not extend
expired authority or bypass failed validation or private-source boundaries.

## Centrally managed writable worktrees

The [managed-tool ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248375273)
requires an agent to request an isolated worktree through a centrally managed
tool before editing reference source or requesting stable multi-step reads.
Its starting commit is fixed and reported; its working files are writable.
Shared reference source stays read-only. Existing concrete host, storage and
worker owners control allocation, authorization, identity, base commit,
active use, access/resumption, renewal, release and cleanup. A request cannot
widen the caller's authority.

Results provide a usable path and stable identity, starting commit,
lifecycle/limits and release/renewal instructions. Both backends need stable,
actionable tool descriptions and worker guidance: when moving shared source
is sufficient, when a worktree is required, how to obtain/resume/renew it,
where to work, how to release it and how expiry or refusal behaves.
Unmanaged checkouts are not the supported bypass. Intentional worktree edits
remain journaled, reviewable and scope-accounted as editable workspace work.
Deterministic execution belongs in CLI/host code; skills orchestrate it.

Tool and configuration changes follow the additive integration-contract rules,
including same-commit documentation, a `CONTRACT:` prefix and a minor changeset.
This policy record introduces no tool name or schema. Guidance and tools must
respect [append-only provider history](provider-history.md): never rewrite an
earlier system prompt, tool roster or message to communicate changed lifecycle
or freshness facts, and keep internal accounting out of provider history.

## Explicit activity, safe cleanup and hygiene

The [final activity ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248527515)
allows only explicit worktree tool access/resumption or renewal to reset the
three-day inactivity clock. Reading, writing, commands and background work do
not renew it implicitly. Guidance must explain this obligation. A confirmed
active worker remains protected even after expiry. Abandoned ownership can be
recovered only after positively establishing the worker is gone; uncertainty
blocks deletion.

The [preservation ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248390114)
qualifies the earlier unconditional three-day purge: release or expiry permits
automatic cleanup only when there is no unpreserved work. Unfinished files,
unpreserved local commits and unknown work/preservation state require retention
and a requested disposition. No automatic archive-then-purge is selected.
Retained work remains capacity-accounted; pressure does not authorize its
destruction. Shared-source snapshots have no idle-age expiry.

Stale worktrees, retained unfinished work and cleanup failures enter existing
deterministic [hygiene review](hygiene-review.md). Stable evidence-based
identities and fingerprints keep repeated scans idempotent. Existing review,
dismissal/snooze, evidence invalidation and validated-effect rules apply.
Dismissal or snooze is not deletion approval. Before cleanup, revalidate the
exact identity, live ownership and current work/preservation state. A stale
identity must never delete a different worktree or shared source. Findings and
effects remain scoped to authorized readers, preserving private-source access.

## A separate logical Btrfs volume and finite allocation budget

The [volume clarification](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248153589)
requires a separate logical volume; the
[Btrfs ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248351828)
requires Btrfs optimized for managed worktrees. Separate physical storage or
pre-reserved physical backing is not required. Reuse existing concrete storage
owners for qualification/status, capacity, reservations, shared-backing
free-space/headroom checks, removal, interrupted cleanup and crash recovery,
as selected in the
[storage-management ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248183626).
Report usage, limits, reservations and storage refusals on appropriate existing
management/status surfaces. Introduce no storage-provider seam.

The [allocation clarification](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248453690)
selects one configurable **10 GiB combined ceiling** for reference source,
managed worktrees and staging, with a configurable **2 GiB per
acquisition/snapshot/worktree** default. Charge actual allocated disk
consumption and count shared Btrfs allocations once in aggregate. Summed
apparent file lengths, advertised logical filesystem size and a
percentage-of-disk ceiling are not the selected metric. Qualify and document
the concrete per-operation/worktree attribution metric, Git/checkout and
staging allocations, relevant allocation overhead and safe pending-write
reservations without double-counting allocated/reserved bytes. A Btrfs label
alone proves neither efficient sharing nor actual-allocation enforcement.

The existing `StorageInventory` reports logical-byte totals and allocation
observations based on `512 * st_blocks`, with an explicit warning that shared
extents may be charged more than once (`StorageInventory`,
`packages/core/src/lib/storage-inventory.ts:25-35`). Those observations are not
the unique aggregate allocation metric selected for this pool; reusing storage
management owners does not qualify their existing inventory as that metric.

> **2026-10-22 — Mechanism (#2428).** The
> [reference pool accounting record](reference-pool-accounting.md) selects the
> concrete mechanism: a separate single-device Btrfs volume with simple
> quotas. Write-time kernel limits apply per root and to a combined group.
> The aggregate comes from the filesystem's own `disk_used` with replication.
> Physical reservations are made before work, and credit waits for observed
> reclamation. It enables no consumer.

This allowance is separate from the unchanged brain-content retained-history
policy in [native brain storage](native-brain-storage.md), which charges
retained objects by logical file length. Independent physical free-space and
recovery-headroom checks remain binding. Shared backing space must not be
counted as independently available to both volumes.

Reserve capacity before acquisition. The
[eviction ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248165997)
selects capacity-driven least-recently-used eviction of unleased reference
source, protecting active users and worktree dependencies. Observe actual
reclamation before reusing capacity. If safe eviction cannot make room, refuse;
neither unbounded fallback storage nor destroying unfinished work is allowed.
Unused source may otherwise remain indefinitely within the finite budget.

## Bounded acquisition, cancellation and recovery

The [concurrency ruling](https://github.com/schlessera/brain-kit/issues/2390#issuecomment-6248484771)
selects a configurable default of **two active acquisition/refresh operations
across the host**. Each operation requires capacity admission and retains the
existing resource, authority, headroom and turn limits. Ordinary readers are
not limited to two. Same-source requests in the same authorized sharing domain
join one in-progress operation, without concurrent writers to published source
or private-activity disclosure across domains.

Central admission, waiting, cancellation and crash cleanup remain bounded and
preserve admitted authority and lifetime. Failed or interrupted work cannot
publish partial source or silently free still-owned reservations. Runtime
qualification must exercise actual Btrfs creation, shared allocations,
isolated writes, overhead, staging, reclamation and refusal alongside actual
worker/journal integration. Keyless fictional repositories and offline fixtures
supply the evidence; mocks, apparent-size sums and policy prose do not.

## Alternatives rejected by these rulings

A cache inside ordinary writable workspaces preserves the acquisition noise;
blanket journal exclusions would hide intentional edits. A full copy per agent
or step discards shared-source reuse. Credentialed source workers expose
authority to repository-controlled inputs. Per-turn source pinning or waiting
for readers conflicts with moving shared reads; background refresh conflicts
with request-only refresh. Logical-size accounting charges shared extents
repeatedly and does not satisfy the actual-allocation condition. Unconditional
age purge, pressure-driven deletion of unfinished work and archive-then-purge
conflict with the selected preservation and human disposition rule. None is an
authorized fallback when the supported path refuses.

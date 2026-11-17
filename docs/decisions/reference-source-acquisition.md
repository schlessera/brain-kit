# Decision — shared reference source acquisition and refresh

[#2429](https://github.com/schlessera/brain-kit/issues/2429) implements the
shared-source half of the [reference-worktree decision](reference-worktrees.md):
authorized acquisition, request-only refresh, admission and capacity eviction
over the [reference pool](reference-pool-accounting.md). It uses the
[owner-managed grants](reference-source-grants.md) as its only private
authority. This record names the concrete choices the rulings left to
implementation. The service is `createReferenceSources`
(`createReferenceSources`, `packages/ui-server/src/brain/reference-source.ts:95-816`),
created at host start when the native manager reports a reference pool, and
closed with the app. The agent tool that requests source arrived with
[#2432](https://github.com/schlessera/brain-kit/issues/2432)
([agent tools](managed-worktrees.md#agent-tools)).

## Requests name a repository and a branch or tag

A request carries the principal, a repository location and a revision. The
revision is a branch or tag name. Requests for a raw commit id are refused:
stable reads of an exact commit belong to a managed worktree created from a
reported commit ([#2430](https://github.com/schlessera/brain-kit/issues/2430)).
Repository locations follow the grant record's rules: HTTPS without
credentials, loopback HTTP, or an absolute `file://` path.

The managed-only qualification in #3613 additionally refuses a short name
shared by a branch and a tag, raw full refs/refspecs and malformed or
conflicting advertisements. Resolution binds the requested full ref and
commit; fetching a moved commit cannot publish it as the earlier resolution.
These checks do not establish repository identity, immutable-read provenance
or network-byte qualification by themselves.

## Sharing domains

Each source lives in exactly one domain, and a domain is one pool view.

- **Public** is shared across the host. A request is public only when the
  anonymous transport resolves the revision right now. Public source is only
  ever fetched anonymously, so a credentialed fetch can never enter it.
- **Private** belongs to one principal of the served brain. It needs a live
  grant covering the repository, checked at the moment of the request. Two
  principals never share a private source or join each other's operations, so
  one principal's activity is invisible to another.

`file://` repositories are never public: anonymous success says nothing about
who may read a host path. A refused anonymous check is remembered for one
validation lifetime, so later private requests skip the public probe.

## Two clocks

The reuse/outage rules below describe legacy transports. Managed GitHub
requests always perform their own bounded metadata/ref validation, including
inside both windows, and do not serve stale results after identity refusal.
The validation window still governs what a pre-proxy bind may expose.

Each source records `validatedAt`, the last successful authority check of its
exact published commit, and `refreshedAt`, the last successful refresh. Both
default to five minutes and are configured separately
(`BRAIN_UI_REFERENCE_VALIDATION_SECONDS`,
`BRAIN_UI_REFERENCE_REFRESH_SECONDS`). Nothing runs on a timer
(`operate`, `packages/ui-server/src/brain/reference-source.ts:301-350`).

- Inside both windows a request reuses the published source without any
  network call.
- When either window has passed, the request resolves the revision under its
  domain's authority. If the resolved commit is the published one, both
  timestamps advance: confirming that nothing changed is a successful refresh.
- If the commit moved, the request acquires the new commit and publishes it.
  This happens even inside the refresh cooldown when validation expired,
  because an exact commit that cannot be validated cannot be served.
- If the refresh fails, the previous revision is returned explicitly
  `stale`, with the error, its exact commit and its unchanged `refreshedAt`,
  only while its own validation is still live. After validation expires, a
  failed or impossible check refuses even though bytes exist.
- An anonymous denial of a public source withdraws it at once, whether the
  check or the fetch is denied. A denied fetch is lost authority, never an
  outage, so no stale copy survives it. A public-to-private transition
  therefore never leaves the old copy under public authority; the principal
  needs a grant and gets a private copy.
- Managed metadata or Git authority refusal withdraws known public and
  requesting-principal private copies, including while a reader holds a lease.
  A successful private metadata check also withdraws the prior public copy.
  An incomplete metadata check withholds cached roots until acquisition can
  establish authority again. Private metadata responses of 401, 403 or 404
  are authority refusals; the selected private grant is checked once more
  after the acquisition wire finishes shutting down.
- A public check that gets no answer proves nothing. Only a principal with a
  covering grant goes on to the private path; anyone else is refused as
  `unavailable`.

## Acquisition and credential isolation

Acquisition reserves a pool root before any work. The root is a snapshot of
the previous root, so a refresh fetches only new objects. Then
(`acquire`, `packages/ui-server/src/brain/reference-source.ts:416-469`):

1. The host writes fixed Git metadata into the root: no hooks, no fsmonitor,
   fsck on transfer, no repository-controlled configuration.
2. The **network transport** fetches one ref into it. It is the only worker
   that may hold a credential: the granted host variable, delivered through a
   fixed credential helper, with one allowed protocol and no redirects
   (`async fetch({ repository, ref, token, root, signal, wire })`, `packages/ui-server/src/brain/reference-transport.ts:211-232`).
3. A separate **checkout worker** has no credential and no network. It checks
   out the commit and evaluates the repository's attributes. No filter or
   hook is configured, so none runs
   (`async checkout({ root, commit, signal })`, `packages/ui-server/src/brain/reference-transport.ts:233-242`).
4. The live grant is read again, the root is sealed, the grant is read
   again, and only then is the root published.

Private authority is also read when an operation is admitted, after any queue
wait, before its credential is taken. It is read once more before any private
lease is returned, including unchanged-commit and stale outcomes. If the reply
to a publication is lost, the staging root is released and the previous root's
name is published again; if that fails, the source is withdrawn.

Neither worker mounts the brain; both use the transport envelope's empty root.
A failure or cancellation releases the staging root through the pool, and only
after the worker has exited. The pool keeps its reservation charged until
reclamation is observed.

## Fixed GitHub wire and identity authority (#3613)

The concrete access owner (`createGitHubReferenceAccess`,
`packages/ui-server/src/brain/github-reference-access.ts:12-129`) uses the
fixed transport (`createGitHubReferenceWire`,
`packages/ui-server/src/brain/github-reference-wire.ts:19-254`).

The host-only GitHub access service binds one canonical repository and short
branch/tag to a bounded acquisition. Anonymous metadata precedes a private
attempt. Only an existing live grant for the actual brain/principal, with
explicit permission for `https://api.github.com`, permits a credentialed
metadata retry. Every use retains the selected grant identity and credential
selector: replacement, revocation, a changed covering grant, changed credential
or lost API permission refuses the operation. Public acquisition stays
anonymous even when the host holds a credential and the principal has a grant.
Owner identity uses its own anonymous `/users/<owner>` operation, without a
Git channel or credentialed mode. Parsed identity data carries no trust or
approved-owner-boundary claim.

The fixed wire shares one operation allowance across metadata, Git discovery,
authentication and fetch, and charges the real turn counter. It counts TLS
framing and both directions. Before forwarding each chunk it rechecks live
authority, final egress admission and the remaining allowance. An inbound chunk
can already have crossed the socket when it exceeds that allowance: it is
refused, the residual turn allowance is consumed, every channel closes and
separate observed socket counts retain the overrun. This does not promise
zero physical-network overshoot. Metadata bodies have a separate 65536-byte
ceiling and never redirect. All DNS answers must be public; connection uses a
checked address with system TLS verification of the fixed host.

Separate random capabilities bind Git/API and anonymous/credentialed channels.
Only the host's fixed Git argv receives a Git proxy capability; callers of the
access service receive neither that capability nor the credential. An invalid
revision is refused before metadata dispatch, fetch needs that acquisition's
resolved full ref, and commit movement refuses before checkout. Failed final
identity revalidation ends the acquisition. Cancellation, turn stop and a
finite deadline close its sockets; a late successful command cannot outlive
the wire. The wire alone establishes neither sealed-root provenance nor
qualified immutable-read evidence and enables no repository trust rule.

Production GitHub acquisition now opens this service on the actual requesting
turn's proxy. Each request, including cache revalidation and worktree source
access, owns its own authority check and budget; it never joins a foreign
turn. The operation limit is 64 MiB or the remaining turn allowance, whichever
is smaller. Lapsed GitHub source found during pre-proxy bind preparation is
withheld without network, then restored only by an explicit admitted request.
Maintenance admission may wait up to 30 seconds for each Git command, then
returns `busy`. Cancellation stops that wait; the wire still checks the live
turn and selected grant before dispatch, and the source service checks them
again before publication. Waiting grants no new authority.
Private GitHub acquisition requires the separately approved API credential
recipient even if an older Git-only grant exists; host credential availability
does not silently widen that grant. Other legacy transports retain their
existing access rules and qualify for no repository trust.

After offline checkout/tree inspection and native sealing, publication
rechecks the acquiring turn, principal, selected grant and final fixed metadata
identity after the source's own exposure lock. It compares sealed/published
root ID, UUID and creation generation, then records those facts together with
the source catalog on the database worker. Lost authority after manager or
database waits withdraws the publication. Recovery compares the retained facts
to the current native sealed root, refusing a different root/generation or
contradictory brain/ref/commit. These host facts are outside repository content
and provider history and are not read receipts. Normal source/worktree file
tools remain workspace restriction signals; shell-local-read coverage retains
its documented limitation. Actual immutable regular-blob/range/digest evidence,
approved-owner matching and complete managed-path native/backend qualification
remain required before repository trust can be enabled.

## Admission

At most `BRAIN_UI_REFERENCE_ACQUISITIONS` (default two) acquisitions or
refreshes run across the host
(`admit`, `packages/ui-server/src/brain/reference-source.ts:241-256`). Requests
for the same legacy source in the same domain join one operation
(`function join`, `packages/ui-server/src/brain/reference-source.ts:259-284`).
Each principal's private source is its own domain, so two principals requesting
the same private repository at once run two operations, each with its own
credential and view. Admitted operations finish independently: a stalled one
holds only its own slot.
At most 64 distinct operations wait; beyond that a request is refused as busy.
A requester that cancels leaves its operation, and the operation is cancelled
when its last requester leaves. Legacy readers are never admitted operations: a
legacy request inside both windows only takes a reader lease. Managed GitHub
cache validation uses an admitted operation and its own turn budget. No manager lock is held across a
fetch; each pool call is one short serialized manager request.

## Readers, refresh and eviction

A request returns a reader lease. Readers protect a source from capacity
eviction but never from refresh. A refresh publishes the new root under the
same name, so a worker bound to the view reads it on its next path read. The
superseded root is released when the last reader of that source releases.

When the pool refuses a reservation for capacity, the service withdraws the
least recently used source that has no reader, no running operation and no
worktree dependency, then retries. If nothing is eligible it refuses with
`capacity` (`evictOne`, `packages/ui-server/src/brain/reference-source.ts:375-391`).
There is no idle expiry.

## Revocation and recovery

Revoking a grant or a principal cancels that principal's in-flight private
operations at once. It also withdraws every private source of theirs that no
live grant still covers. Withdrawal fences the source before any await, so no
new lease can reach it, and records which roots it held at that moment. It
removes the name and moves every one of those roots out of the view
(`poolWithdraw`), so no reader reaches them by name or identity. Storage is
released once readers finish. An acquisition of the same source waits for the
withdrawal to finish
(`revoke`, `packages/ui-server/src/brain/reference-source.ts:803-823`).

The catalog lives in the UI database and is disposable bookkeeping. At start, a
recorded source survives only if its sealed root still exists, its name can be
published again (which repairs a publication whose reply was lost) and, when
private, a live grant still covers it. Every other owned source root is
released: interrupted staging, superseded or withdrawn roots, roots the
catalog lost, and deletions interrupted in `deleting` (`recover`, `packages/ui-server/src/brain/reference-source.ts:826-870`).

## Evidence

- `reference-source.test.ts` drives the service with a directory-backed pool
  double and a scripted transport. Named mutations cover expired validation,
  domain substitution, public-to-private, credentials as authority, partial
  publication, refresh time on failure, pinned readers, duplicate fetches, a
  third admitted operation, an unbounded queue, revocation and early
  reservation release. Further mutations come from an independent review:
  identity access after withdrawal, authority after admission and before a
  lease, fetch denial, revoked grants across a restart, lost publication
  replies, interrupted deletion, eviction racing a new lease, and
  already-cancelled requests.
- `reference-transport.test.ts` uses the real worker boundary against an
  offline loopback Git server and acquires a 1,200-file Odysseus repository.
  Public access is anonymous, private access needs the token, and the token
  appears only in `ls-remote`/`fetch` launches. Checkout runs with
  `--unshare-net`, and no launch binds the brain.
- The native pool proof runs the real service and real transport workers
  against the simple-quota Btrfs pool. It acquires the 1,200-file repository
  into a quota-limited root and reads it through its view from a bubblewrap
  sandbox. The withdrawn root is reclaimed.

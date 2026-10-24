# Decision — shared reference source acquisition and refresh

[#2429](https://github.com/schlessera/brain-kit/issues/2429) implements the
shared-source half of the [reference-worktree decision](reference-worktrees.md):
authorized acquisition, request-only refresh, admission and capacity eviction
over the [reference pool](reference-pool-accounting.md). It uses the
[owner-managed grants](reference-source-grants.md) as its only private
authority. This record names the concrete choices the rulings left to
implementation. The service is `createReferenceSources`
(`createReferenceSources`, `packages/ui-server/src/brain/reference-source.ts:89-497`),
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

Each source records `validatedAt`, the last successful authority check of its
exact published commit, and `refreshedAt`, the last successful refresh. Both
default to five minutes and are configured separately
(`BRAIN_UI_REFERENCE_VALIDATION_SECONDS`,
`BRAIN_UI_REFERENCE_REFRESH_SECONDS`). Nothing runs on a timer
(`operate`, `packages/ui-server/src/brain/reference-source.ts:226-273`).

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
- A public check that gets no answer proves nothing. Only a principal with a
  covering grant goes on to the private path; anyone else is refused as
  `unavailable`.

## Acquisition and credential isolation

Acquisition reserves a pool root before any work. The root is a snapshot of
the previous root, so a refresh fetches only new objects. Then
(`acquire`, `packages/ui-server/src/brain/reference-source.ts:338-383`):

1. The host writes fixed Git metadata into the root: no hooks, no fsmonitor,
   fsck on transfer, no repository-controlled configuration.
2. The **network transport** fetches one ref into it. It is the only worker
   that may hold a credential: the granted host variable, delivered through a
   fixed credential helper, with one allowed protocol and no redirects
   (`fetch({ repository, ref, token, root, signal })`, `packages/ui-server/src/brain/reference-transport.ts:133-148`).
3. A separate **checkout worker** has no credential and no network. It checks
   out the commit and evaluates the repository's attributes. No filter or
   hook is configured, so none runs
   (`async checkout({ root, commit, signal })`, `packages/ui-server/src/brain/reference-transport.ts:149-159`).
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

## Admission

At most `BRAIN_UI_REFERENCE_ACQUISITIONS` (default two) acquisitions or
refreshes run across the host
(`admit`, `packages/ui-server/src/brain/reference-source.ts:166-181`). Requests
for the same source in the same domain join one operation
(`function join`, `packages/ui-server/src/brain/reference-source.ts:184-209`).
At most 64 distinct operations wait; beyond that a request is refused as busy.
A requester that cancels leaves its operation, and the operation is cancelled
when its last requester leaves. Readers are never admitted operations: a request
inside both windows only takes a reader lease. No manager lock is held across a
fetch; each pool call is one short serialized manager request.

## Readers, refresh and eviction

A request returns a reader lease. Readers protect a source from capacity
eviction but never from refresh. A refresh publishes the new root under the
same name, so a worker bound to the view reads it on its next path read. The
superseded root is released when the last reader of that source releases.

When the pool refuses a reservation for capacity, the service withdraws the
least recently used source that has no reader, no running operation and no
worktree dependency, then retries. If nothing is eligible it refuses with
`capacity` (`evictOne`, `packages/ui-server/src/brain/reference-source.ts:298-314`).
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
(`revoke`, `packages/ui-server/src/brain/reference-source.ts:419-436`).

The catalog lives in the UI database and is disposable bookkeeping. At start, a
recorded source survives only if its sealed root still exists, its name can be
published again (which repairs a publication whose reply was lost) and, when
private, a live grant still covers it. Every other owned source root is
released: interrupted staging, superseded or withdrawn roots, roots the
catalog lost, and deletions interrupted in `deleting` (`recover`, `packages/ui-server/src/brain/reference-source.ts:439-477`).

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

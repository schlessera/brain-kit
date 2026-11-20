# Decision — shared reference source acquisition and refresh

[#2429](https://github.com/schlessera/brain-kit/issues/2429) implements the
shared-source half of the [reference-worktree decision](reference-worktrees.md):
authorized acquisition, request-only refresh, admission and capacity eviction
over the [reference pool](reference-pool-accounting.md). It uses the
[owner-managed grants](reference-source-grants.md) as its only private
authority. This record names the concrete choices the rulings left to
implementation. The service is `createReferenceSources`
(`createReferenceSources`, `packages/ui-server/src/brain/reference-source.ts:106-914`),
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
(`operate`, `packages/ui-server/src/brain/reference-source.ts:386-435`).

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
  are authority refusals. The retained lease guard is checked after wire
  shutdown, including validation lifetime, principal, selected grant,
  credential and API-recipient permission. A failed close also checks and
  contains authority loss. Shutdown expiry withholds the expired source under
  its exposure lock, while a newer successful validation stays exposed.
  Each retained lease also rereads the shared catalog before new effects:
  its root, commit and ref must still match the authoritative publication and
  both its captured validation and the current validation must be live.
  Another app or cron owner's durable suspension, withdrawal or replacement
  therefore fences waiting worktree effects too. A valid same-root check by
  another owner preserves access.
  Repository and revision invalidation versions are shared durable catalog
  facts. Every managed request retains its starting versions; checks after
  waits and the publication/validation write transaction refuse changed
  versions. Repository observations cover all revisions in the affected
  sharing domain, including requests with no source catalog row yet.
  Withdrawal inspects staging roots from other owners too: a sealed staging
  identity is retired before returning, so a delayed native publication
  cannot expose it. A still-writing root stays masked and its acquiring
  owner releases it after its worker stops. Cleanup of a failed attempt
  discards only that attempt's root and preserves a newer valid publication.
  Source freshness has a separate comparison: native publication accepts only
  the previously observed root or an absent alias, and the catalog transaction
  compares the previous root again. A delayed fetch cannot overwrite a newer
  commit even when no authority invalidation occurred. Cache/recovery repair
  cannot replace a different native alias target. A concurrent acquisition of
  the exact independently resolved commit can validate the new cache using
  its own turn's wire and allowance; it never joins the other turn's operation
  or reports a different commit as fresh. Failed staging cleanup is separate
  from authority containment, so recovering from this conflict cannot suppress
  a later actual authority refusal.
  Repository metadata fences every cached and in-flight revision of that
  repository. Older requests cannot publish or restore public state after a
  newer private or refused observation, even before the first catalog row
  exists. Withdrawal waits for dispatched publication, reads its resulting
  catalog state and hides any native publication whose catalog receipt is
  still pending. Private revocation includes those in-flight identities and
  confirms they are hidden before returning; storage reclamation may finish
  later. Concurrent valid private requests keep their own authority and budget.
  GitHub cache and grant checks use the fixed transport's canonical repository
  identity. Repository-wide fences also cover retained catalog aliases with
  different owner/repository casing. Incomplete initial or final metadata
  withholds cached and pending native exposure, including before a first catalog
  row exists. Final metadata failures are contained before staging cleanup;
  ending the turn during cleanup cannot undo that observation. A later valid
  metadata check may acquire a fresh root from the retained sealed bytes.
  Managed roots opt into native permanent withdrawal when created. Once
  withdrawn, their identity can never publish again; a new authorized request
  obtains a different root. This closes delayed native restoration after a
  completed revocation without relying on a process-local lock or a check
  after exposure. Valid, still-published roots retain normal cache reuse.
  The shared fence transaction expires matching catalog validation atomically,
  including aliases; recovery retains invalidated roots masked and charged
  without spending network or republishing them. Native restart completes an
  interrupted permanent withdrawal before admitting requests. Legacy roots
  keep their prior semantics and cannot be reused as a managed cache entry.
  Suspension also expires the stored validation clock, so restart cannot
  republish uncertain authority into a newly bound view without fresh
  validation. Post-publication authority loss hides native exposure before
  storage cleanup begins. Anonymous identity refusal withdraws public exposure
  before any credentialed retry, so cancellation during the retry cannot retain
  the refused public copy. Initial metadata failures are captured before wire
  shutdown, just as final metadata failures are.
  Managed failure containment runs once per request;
  its later cleanup cannot unpublish a newer validated source. Refusal before
  any metadata attempt, such as exhausted turn allowance, does not invalidate
  another turn's cached authority. Host source leases retain their authority
  fence, validation lifetime and acquiring principal/private grant/credential
  checks after wire shutdown. Worktree allocation and access read them after
  waits; a previously public snapshot cannot bypass a newer restrictive
  observation. This host check grants no source trust or read provenance.
- A public check that gets no answer proves nothing. Only a principal with a
  covering grant goes on to the private path; anyone else is refused as
  `unavailable`.

## Acquisition and credential isolation

Acquisition reserves a pool root before any work. The root is a snapshot of
the previous root, so a refresh fetches only new objects. Then
(`acquire`, `packages/ui-server/src/brain/reference-source.ts:551-605`):

1. The host writes fixed Git metadata into the root: no hooks, no fsmonitor,
   fsck on transfer, no repository-controlled configuration.
2. The **network transport** fetches one ref into it. It is the only worker
   that may hold a credential: the granted host variable, delivered through a
   fixed credential helper, with one allowed protocol and no redirects
   (`async fetch({ repository, ref, token, root, signal, wire })`, `packages/ui-server/src/brain/reference-transport.ts:231-252`).
3. A separate **checkout worker** has no credential and no network. It checks
   out the commit and evaluates the repository's attributes. No filter or
   hook is configured, so none runs
   (`async checkout({ root, commit, signal })`, `packages/ui-server/src/brain/reference-transport.ts:253-263`).
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
`packages/ui-server/src/brain/github-reference-access.ts:19-189`) uses the
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

Settings repository lookup shares that metadata authority without selecting a
Git revision or fabricating an agent turn. Its separate owner-only operation
returns fresh repository/owner IDs through the same fixed anonymous-first path,
including the requesting owner's own grant for private metadata. Neither that
result nor anonymous owner lookup approves a trust boundary. The Settings
publisher must retain its independent human authority and bind a fresh identity
observation to reviewed publication; changing names or IDs cannot inherit an
old review. Cancellation and operation authority are retained before waits and
rechecked before returning the identity, including after wire shutdown. A
repository observation retains a synchronous authority check over its selected
grant and credential for the final publication boundary; invoking it does not
refresh metadata or approve the target.

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
Bind preparation treats a local suspension or withdrawal as settled only for
the exact catalog root and validation timestamp whose native hiding succeeded.
A replacement root or renewed validation is checked again when it expires;
failed catalog writes or native hiding never excuse that check.
Only a root's confirmed permanent native withdrawal can be reused across
binds. Reversible roots, including catalog orphans, need fresh hiding
confirmation for each bind because another owner may have republished them.
An unpublished staging root remains outside those views while a concurrent
acquisition writes or seals it. Bind preparation reads the native catalog to
confirm that absence without permanently withdrawing its publication authority.
A staging root already in a view still needs settlement or hiding.
Expiry compares the observed root, validation timestamp and freshness inside
the catalog transaction. A concurrent renewal wins that comparison. Managed
expiry retires only that publication, preserving another turn's authorized
staging roots; validation cannot renew a retired root. Revocation and unknown
metadata still invalidate all affected acquisitions. Hiding exposed staging
first retires its catalog identity, and publication commits require a staging
identity, so a delayed native reply cannot create a fresh lease for hidden bytes.
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
its documented limitation. Model-delivery-bound immutable regular-blob/range/digest evidence,
approved-owner matching and complete managed-path native/backend qualification
remain required before repository trust can be enabled.

### Bounded immutable object reads

The transport's host-only `readBlob` primitive reads from the attested sealed
acquisition's Git object database, rather than its checkout. A caller supplies
the recorded commit/tree and a literal normalized Git path. Only regular blob
modes qualify. The credential-free offline maintenance worker bounds the full
blob to 4 MiB, verifies its complete Git object hash, then returns at most
64 KiB with the actual byte range and SHA-256 digest. The host validates that
envelope and exact base64 bytes again; cancellation after the worker returns
still withholds the result
(`readBlob`, `packages/ui-server/src/brain/reference-transport.ts:174-189`).

Git pathspec syntax is disabled, so punctuation in a filename remains literal.
Symlinks, gitlinks and directories never become blob reads. Checkout edits or
an altered `origin` cannot replace the selected object bytes. The caller still
owns native root attestation and live authority checks across waits. This
primitive does not itself connect a read to a backend's actual model delivery;
that durable acquisition/read correlation and approved-owner matching remain
necessary for a source-trust decision. Ordinary file reads keep their existing
workspace restrictions, and no directory, credential or hostname grants trust.

### Turn-bound content delivery

The `reference_read` tool composes the fixed reader with a fresh managed
acquisition request. Its repository/ref/path/range are model input; principal,
turn, network budget and actual backend tool-call identity are independent host
context. Missing or reused call identity refuses. The selected lease pins the
source while native sealing and immutable reading wait, and the service checks
both native root generation and live authority after those waits.

Before returning content, the shared SQLite writer records an acquisition
snapshot and regular blob/path/range/digest, detector version, the selected
read grant and digest of the exact content result. The transaction rechecks
the acquisition mapping, durable authority fence and current private grant.
The caller checks live turn/principal/source authority again after the writer
returns. These records remain outside source files and provider history and
survive eviction of the acquisition. The selected grant for a new read may
differ from the original acquisition's grant; both facts retain their own
meaning.

The awaited input-safety result hook observes a read only when one finalized
text segment exactly matches its prepared result at that turn/call identity.
An absent hook leaves `prepared`, and altered, mixed or unfinished results
become sticky `unknown`. Observation is evidence of that backend result,
not proof of a later provider request. Every read still records workspace
input; ordinary file marks keep their independent signals. Approved-owner
matching and the full qualified source-trust route remain separate work.

Observation compares the complete plain-text result or the fixed tool's
single-text MCP envelope with that segment. Extra content, structured payloads
and error envelopes cannot borrow a matching text part. Pi omits qualified
segments for a mixed reference result instead of filtering away its non-text
parts. Reports lost before the collector's result method, including malformed
or replayed worker RPCs, invalidate that call before failure containment.
An earlier loss also fences a read prepared afterward; another call's known
observation remains independent.

## Admission

At most `BRAIN_UI_REFERENCE_ACQUISITIONS` (default two) acquisitions or
refreshes run across the host
(`admit`, `packages/ui-server/src/brain/reference-source.ts:326-341`). Requests
for the same legacy source in the same domain join one operation
(`function join`, `packages/ui-server/src/brain/reference-source.ts:346-371`).
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
`capacity` (`evictOne`, `packages/ui-server/src/brain/reference-source.ts:453-469`).
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
(`revoke`, `packages/ui-server/src/brain/reference-source.ts:1094-1119`).

The catalog lives in the UI database and is disposable bookkeeping. At start, a
recorded source survives only if its sealed root still exists and, when
private, a live grant still covers it. A source with live validation may have
its name repaired after a lost publication reply. Expired, durably suspended
or permanently withdrawn roots remain masked until a fresh authorized request;
startup never renews their authority or exposes them to already-bound views.
Recovery rereads each catalog entry and expires validation only if its root
and validation timestamp still match, preserving another owner's renewal or
replacement after the initial scan.
Every other owned source root is
released: interrupted staging, superseded or withdrawn roots, roots the
catalog lost, and deletions interrupted in `deleting` (`recover`, `packages/ui-server/src/brain/reference-source.ts:1124-1168`).

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

# Repository read qualification: managed acquisition, immutable bytes

Qualification for [#3612](https://github.com/schlessera/brain-kit/issues/3612),
2026-11-05, against main `35217d283b849b5ef81700d5d4c2ec7486405d12`.
This records a bounded experiment and its selected implementation route. It is
not an approval of a production trust exemption. The shared session-safety
plan/ADR is owned separately by #3599 and is not changed here.

## Selected route

Use the existing explicit managed reference acquisition operation, with new
host-verified identity and immutable-input evidence before repository trust
can affect taint. Ordinary shell `clone`, `fetch` and `pull` keep their existing
egress, credential and taint restrictions. Report **Managed repository reads
only; shell Git and writable workspace reads are not verified** when exposing
this capability. No hostname, command-window or directory exemption is added.

The smart-HTTP relay plus URL rewriting candidate is rejected for this first
implementation. The experiment can clone, fetch and pull with Git protocol v2,
and can refuse receive-pack and unrelated paths. Nevertheless a worker can
request `refs/pull/7/head` through the exact same allowed upload-pack endpoint
using the relay's credential. The returned foreign commit was created on an
orphan branch and is absent from the allowed `main` history. This is a concrete
counterexample to endpoint-only authorization, not proof that a future fully
parsed Git protocol implementation is impossible. That substantially larger
implementation is unnecessary for the managed fallback.

URL rewriting is compatibility configuration, not authority. A changed origin
selects another repo, and a longer `insteadOf` changes the transport. The
fixture sends every bypass to a closed loopback port. A configured pull also
updates the local worktree and executes its post-merge hook. Therefore approving
its read phase cannot approve the whole pull, hooks, merge/rebase or writes.
Ordinary outward operations retain independent permission checks.

## Real runtime evidence and its limits

Run `bun run test ./experiments/git-read-qualification.test.ts` from the root.
The suite prints the installed Git/Bun versions and JSON exit-code receipts
for every Git subprocess, including expected nonzero refusals. The evaluated
installation is Git 2.53.0 and Bun 1.4.4. No external repository, provider or
credential is used; fixture identities and the pinned 2026-07-12 Git dates use
the Odysseus world.

The loopback origin uses the installed `git http-backend`, with separate
`odysseus/navigation` public and `penelope/loom` private bare repositories on
the same listener. A separate candidate relay supplies only a fictional token.
Real Git exercises v2 discovery/fetch, clone, annotated tag fetch, pull, an
orphan PR ref, receive-pack refusal, origin/config changes, parallel unrelated
public traffic, redirects and cancellation of a stalled HTTP request.

The existing `createReferenceTransport` runs its actual argv/environment with
real Git through its `run` test seam. `createReferenceSources` runs with the
actual in-memory UI database, live principals/grants and directory-backed pool
double. The suite proves credential availability alone is insufficient,
principal separation, anonymous public traffic, credentialed private fetch,
credential-free offline checkout launch metadata, revocation of cached source,
and omission of the foreign commit from the fixed-ref acquisition. This is
not proof of the native maintenance worker, Btrfs sealing, kernel quotas or
production read-only mounts. The pool double deliberately permits edits so the
immutable-object counterexample can be exercised.

The standard `scripts/test-offline.sh` was attempted and refused UID mapping
with `Operation not permitted`. Bubblewrap can create a network namespace here,
but cannot bring up its loopback interface (`RTNETLINK ... Operation not
permitted`). The successful fixture run uses only explicit loopback transports,
a complete fixed Git environment, no recursive submodules/filters and the
repository network preload. Native Git is not instrumented by that preload;
this run does not claim OS network isolation. A production-candidate runtime
must repeat under the permitted offline native harness. Missing hosted proof
is not green.

## Concrete boundary to reuse and strengthen

- `createReferenceTransport`, `packages/ui-server/src/brain/reference-transport.ts:97-166`,
  owns credentialed `ls-remote`/single-ref fetch. It disables redirects, ambient
  global/system config, hooks, interactive credentials and other protocols.
  Checkout is a separate credential-free/network-free launch. Host config is
  rewritten; source attributes do not install filters. Do not pass worker Git
  config, headers, URL, helpers, refspecs or HTTP request bodies into this path.
- `createReferenceSources`, `packages/ui-server/src/brain/reference-source.ts:91-782`,
  already separates anonymous public domains from per-principal private domains,
  rechecks grants around queueing/publication, binds sealed root/commit leases,
  cancels revoked work and recovers its catalog. Its authority/freshness windows
  are not sufficient evidence of *current trust identity* on every new read.
- `coveringReferenceGrant`, `packages/ui-server/src/db/reference-grants.ts:158-164`,
  is access authority, independently of any incoming-source trust rule. Grant
  presence never establishes repo ownership. A token must be taken only after
  live principal/brain/grant checks and must not reach a worker-facing relay.
- `startEgressProxy`, `packages/ui-sdk/src/server/egress-proxy.ts:123-352`,
  remains unchanged: CONNECT cannot see a repository path. Its allow/deny,
  recipient permissions and turn byte limits are not waived.
- `inputTaintSource`, `packages/ui-server/src/activity/ingestion-taint.ts:95-109`,
  needs authoritative immutable-input evidence before a future narrow matcher
  can alter the current workspace-read classification. Both backends must
  consume the same host evidence, never worker assertions or timing guesses.

The fixed transport is internal, not an authorization endpoint: `fetch` accepts
an internal ref and expects its caller to have resolved it. Do not expose that
method directly to arbitrary workers. In the production trust route, accept
only a canonical GitHub owner/repo and one short branch/tag name; reject raw
SHA, `refs/*`, ambiguous branch/tag collisions and arbitrary refspecs. Resolve
only `refs/heads/<name>` or `refs/tags/<name>`, record the chosen full ref and
commit, compare resolve/fetch identities and refuse a moved target rather than
publishing mismatched proof. Branch/tag names alone do not authenticate authors
or promise that their history contains no merged contributions from forks.

## Identity, namespace and credentials

The first implementation is concrete GitHub HTTPS, not a generic transport
seam. Canonicalize exactly two path segments on `github.com`, case-insensitively,
with optional `.git`. Reject userinfo, encoded separators, extra components,
lookalike hosts and traversal before URL normalization. The existing generic
reference parser is an access parser; it is not a verified GitHub identity.

Obtain repository ID, current owner identity/namespace, repository name and
canonical transport location from a fixed host-owned GitHub metadata lookup,
never from a worker's remote, HTTP headers or returned source files. Git smart
HTTP does not itself provide GitHub's repository ID. Bind the verified metadata
to the actual acquisition; refresh/revalidate before publication and new trusted
input admission. Unknown, stale, redirected or mismatched metadata supplies no
trust. A transfer during metadata/acquisition is restrictive and must be covered
by production race tests; this local fixture cannot prove GitHub transactionality.

An exact selector pins the stable repo ID **and** the approved owner boundary.
A rename within that owner can match after authoritative revalidation; a
transfer cannot. Reuse of the old repo name with a new ID cannot match. An owner
selector explicitly covers current and future repos currently in that namespace,
including repos later transferred in, and stops matching repos transferred out.
Require current authoritative metadata, no prefix/substring matching. The fixture
models these restrictive semantics; it is not an implementation of the metadata
lookup. Account namespace rename/reassignment must not be inferred from a Git
redirect; require fresh owner review when that boundary cannot be verified.

Private acquisition still requires the existing live reference grant for the
brain/principal/repository and independently available named credential. Public
source and public identity lookup remain anonymous. Never probe a sequence of
host credentials to see which works. Reject before any private metadata request
unless separately authorized. Current credential recipients are `github.com`
and test loopback; sending the same credential to `api.github.com` is **not**
automatically authorized by that rule. The fixed metadata credential recipient
and authority are a remaining production architecture ruling for #3613. Options
are an explicitly approved fixed API credential path with separate recipient
checks, or no repository auto-trust when anonymous identity metadata is
unavailable. Do not remove a genuine decision label based on this experiment.

## Immutable provenance and revocation

A production acquisition record must bind host operation ID, brain, principal
and authority epoch, public/private domain, live grant ID, verified repo/owner
identity, canonical location, full ordinary ref, fetched commit and tree, sealed
pool root ID/generation, identity-validation time and policy revision. This is
host evidence stored outside the source and provider conversation. A root path
or source lease alone lacks stable GitHub identity and is insufficient.

A read record binds that acquisition to the *actual returned bytes*: root
identity/generation, commit/tree, normalized Git path, regular blob ID/mode,
byte range/digest, detector version and matched trust-rule revision. Prefer
bounded object reads from the host-owned sealed acquisition. The fixture reads
regular blobs by commit and rejects symlinks, gitlinks and traversal; replacing
the checkout README or origin leaves those bytes unchanged. It assumes an
honest host-supplied mirror mapping and does not qualify an attacker-writable
`.git` directory. No caller may select a host root/mirror by arbitrary path.

Do not follow symlinks, hard links, nested repositories, submodule gitlinks or
foreign mounts into mutable storage for trusted reads. A hard-linked worktree
file is still mutable and receives no path-based exemption. Explicit untrusted
file marks win over repository trust. Normal worker workspace/search reads,
untracked files, mixed sources and edited files retain current restrictions.
Persist root/commit/identity mapping across restart; unknown or missing mappings
report unsupported/unverified. Recheck live principal/grant and trust revision
at read admission and after waits. Revocation fences future reads and cancels
in-flight private acquisition; it cannot erase already delivered bytes or edit
provider history. Source refresh issues new immutable provenance, never silently
relabels an old read.

## Supported forms and restrictive fallback

| Form | Managed trust route |
| --- | --- |
| Ordinary branch or tag over canonical GitHub HTTPS | Supported only after host identity/ref/commit binding and live independent access checks. |
| Shell clone/fetch/pull; push/force push/history rewrite | Existing restrictions; no new exemption. Pull's configured local mutation is never authorized by a network-read decision. |
| PR/fork refs and raw object IDs | Refuse as request targets. Fork repository requires its own verified identity/rule/grant. No ancestry-based trust claim. |
| HTTP redirects and renamed/transfer redirects | No following; revalidate identity explicitly or refuse. |
| SSH/scp, git://, file://, custom remote/credential helpers | Unsupported for this trust capability, even when ordinary reference access supports local files. |
| Submodules, LFS, filters, recursive fetch | No recursive network or hydration. Gitlink/pointer/config bytes may be inspected as untrusted data; their foreign content gets no inherited trust. |
| Symlinks, nested repos, hard-linked mutable worktree, foreign mounts | No directory exemption; only verified regular immutable blobs qualify. |
| Generic HTTP, credential probes, receive-pack, arbitrary ref/object fetch | No worker-facing authenticated relay exists in the selected route. |

## Production proof obligations

#3613 must prove the fixed metadata recipient/identity path, arbitrary-client
refusal, live revocation during acquisition/read/publication, namespace and
ref movement races, bounded metadata/protocol bodies and response bytes,
wall-clock/cancellation, quotas and cleanup, restart/root-mapping recovery,
TOCTOU/escape mutations and both backend entry points. Count actual network
bytes, including discovery, auth retries and metadata; pack disk size and process
stdout limits are not network byte ceilings. Stop acquisition before delivering
bytes beyond the admitted budget. The present transport has a deadline and
native storage limits but no demonstrated per-turn network-byte accounting;
this is an explicit implementing gap, not a capability granted by the spike.

No browser UI, production contracts, credentials, exemptions or provider-facing
history changed here. #3613 owns its additive interfaces, effective-taint
contracts, minor changeset and reviewed breaking-before-1.0 metadata. Repository
transparency remains independent of initial trigger review and origin CRUD.

Sources checked: installed Git commands and transport source above;
[Git protocol v2](https://git-scm.com/docs/gitprotocol-v2/2.53.0),
[Git URL rewriting/configuration](https://git-scm.com/docs/git-config/2.53.0),
[GitHub repository metadata](https://docs.github.com/en/rest/repos/repos#get-a-repository),
the [reviewed design](https://github.com/schlessera/brain-kit/issues/3596#issuecomment-6652590345)
and [review disposition](https://github.com/schlessera/brain-kit/issues/3596#issuecomment-6652590730).

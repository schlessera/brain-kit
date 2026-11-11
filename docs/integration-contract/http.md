# Integration contract — HTTP routes

Authoritative component of the [integration contract](../integration-contract.md).
Its [shared scope and versioning policy](../integration-contract.md) apply to every section below.

<a id="ui-server-http-routes"></a>

## ui-server HTTP routes

The [supported HTTP specification and complete inventory](../http-api.md) are part
of this contract. They deliberately select routes for independent clients and
integrations, preserve existing promises and SDK dependencies, and explicitly
exclude internal UI transport from independent raw-HTTP compatibility guarantees.
Support is separate from public accessibility: authenticated APIs can be
supported, while a UI-only probe can be internal. Authentication, inputs,
outputs, errors and specified behavior on supported rows follow the versioning
rules at the top of this document. The [selection decision](../decisions/http-api-boundary.md)
records #343 Q6; no route redesign or immediate 1.0 freeze is implied.

The [runtime coverage matrix](../http-api-coverage.md) maps supported operations
to real app mounting checks and named behavior tests. Its inventory also
accounts for internal routes, conditional static serving, HEAD dispatch and
configured CORS preflight without promoting internal payloads to guarantees.

The detailed stats promises below remain binding. The specification records remaining gaps; a gap does not revoke a guarantee.
Login, passkey registration/rename and capture refuse malformed/non-object JSON with JSON 400 errors.
Capture validates content/type/title/tags before CLI dispatch; valid object defaults and pre-handler authentication/owner checks remain binding.

<a id="retained-turn-journal-reads-additive-1652"></a>

### Retained turn journal reads (additive, #1652)

The three authenticated session/turn journal GET routes are specified in
[the HTTP inventory](../http-api.md#retained-turn-journal). They resolve retained
observations owned by that exact session and turn; callers cannot name a CAS
hash directly. Missing/expired raw details never grant a download bypass.
`createBrainApi` adds `turnJournal(sessionId, turnId, signal?)`,
`turnJournalPreview(sessionId, turnId, sequence, signal?)`. Reader download
links use the embedding root's configured API base.
Those read helpers do not execute mutations.

<a id="untrusted-file-marks-additive-2673"></a>

### Untrusted file marks (additive, #2673)

Four internal `/api/files/untrusted` operations mark a readable brain file
untrusted, read one path's mark, list the marks a principal may see and let the
owner clear one. They are paired UI transport, specified with their authority
and disclosure rules in [the HTTP inventory](../http-api.md#untrusted-file-marks-internal-2673).
The `taint` governance event's shape is unchanged: its reserved
`source: "user_marked"` value is now produced.

<a id="brain-wide-configuration-coverage-additive-3257"></a>

### Brain-wide configuration coverage (additive, #3257)

`GET /api/journal/configuration-coverage` returns `ConfigurationCoverageRead`
(`ConfigurationCoverageRead`, `packages/ui-sdk/src/turn-journal.ts:183-185`):
the brain's current set of configuration inputs steering could not trace. It
is `{ state: "known", hash, paths, count, turnId, observedAt }` for the set the
most recent complete turn recorded from a configuration inventory: `paths` is
sorted, `count` is its length (possibly 0), `hash` is the same identity as the
summary's [`configurationCoverageSet`](wire.md), and `observedAt` is that turn's
end. When no complete turn has recorded one it is `{ state: "unknown" }`, never
an empty list. A partial, expired or still recording turn never replaces the
current set, and neither does a turn that changed nothing: capture takes the
inventory only for an observation that saw a change. The route is authenticated
like the other journal reads and is `Cache-Control: private, no-store`. The
per-turn `missing` entries are unchanged.

### Persisted Claude auto-memory history (additive, #1658)

The existing journal routes also return successful external native-memory saves
with `class: "steering"`, `scope: "claude_memory"` and a logical
`path: "claude-memory://<direct-note.md>"`. That identity is distinct from a
brain-relative path; no saved directory, credential, transcript or settings
location is returned. Exact raw before/after versions, creation/replacement,
originating turn/session/model/profile and recorded taint use the existing
fields and bounded retained-version reader. `memory_persistence_unconfirmed`
in `missing` reports an interrupted/refused staged save, never success or a
complete recovery promise.

Existing authenticated human per-file/whole-turn revert and Undo resolve only
the privately retained destination for an eligible change in that source turn.
Client paths cannot select a host directory. Later note bytes, changed store
identity or unavailable raw history refuse recovery. Ordinary persistence
continues to save only validated direct `.md` notes and never deletes memory;
an explicitly reviewed human revert of a created note may remove that note.
Journal cap, active pins, retention and voice/agent/autonomous exclusions stay
unchanged. The initial in-brain steering delivery remains 0.42.0; external
persisted memory is additive in 0.44.0.

### Managed reference worktree history (additive, #2430)

The existing journal routes also return intentional edits to managed reference
worktrees, observed from each worktree's own checkpoints. Such a change has
`class: "content"`, `scope: "reference_worktree"` and a logical
`path: "reference-worktree://<worktree id>/<path>"`. That identity is distinct
from a brain-relative path; no host or worker path is returned. Versions,
ignored state, overlap and taint fields keep their existing meaning, and a
worktree change is attributed only to the turn whose worker held the worktree.
An unreadable worktree entry appears in `missing` under the same logical path
and makes the turn `partial`. These changes count toward the turn's scope
summary like workspace edits. History revert and Undo exclude them as
`non_reversible_metadata`; nothing is written into the brain or the worktree.
The behaviour is recorded in the
[managed-worktree decision](../decisions/managed-worktrees.md#journal-and-scope).

<a id="metadata-only-index-history-breaking-2873"></a>

### Metadata-only index history (breaking, 0.44.0, #2873)

The brain root's disposable index family is journaled by metadata only:
`.brain-index/brain.db`, its `-wal`, `-shm` and `-journal` sidecars, the
embeddings lock database `.brain-index/brain.db.embedding-lock.db` and its
`-journal`, `-wal` and `-shm` sidecars (#2903), and a
`.brain-index/.maintenance-<uuid>` index publication copy, matched by exact
journal-relative path. Each of their versions keeps `kind`, `mode`, `bytes` and
`ignored`, and adds `metadataOnly: true` and an opaque change `stamp`
(`JournalVersion` in `@schlessera/brain-ui-sdk/protocol`); it has no `hash` and
no symlink `target`. The host still records every observed change of these
paths, telling versions of equal size apart by their stamp, so history shows
when and how far the index changed. Their bytes are never retained: preview
answers `{ inline:false, reason:"metadata_only" }` and raw download is 404. A
metadata-only version is never a missing version: it neither adds a `missing`
entry nor makes an otherwise complete turn `partial`. No shared-window
`conflict` is offered between versions that were not retained.

History revert and Undo exclude these paths with the reason `metadata_only`,
including versions retained by releases before 0.44.0, and leave the index for
the refresh that follows the operation; that exclusion alone does not make the
operation `partial`. Rebuild the index from Markdown with `brain index --force`;
metadata is not a restore source. Every other path keeps its exact retained
bytes, including other names inside `.brain-index/`, another root's
`.brain-index/` and similarly named files elsewhere.

This is breaking: index versions were byte-retained, readable and restorable
before, and the maintainer approved narrowing them on #2873 (2026-10-25,
option B). History recorded by earlier releases keeps its index rows, which
present as metadata-only too, without `hash` or `stamp`. Their retained bytes
are purged (#2903): the first journal open after the upgrade (or a later one,
if a capacity or storage refusal defers it) rewrites each such
stored version to that metadata-only form, in turn history and in revert
records, drops the pins only those versions explained, and collects the
objects left unpinned. An object that any other record also names (a
version of another path, a memory note or an attachment removal's retained
original) is kept, and so is any pin of a turn that has not ended. The purge runs once, resumes after a crash, and returns
the bytes to the journal's capacity. The decision is recorded in
[the governed-workers decision](../decisions/governed-writable-workers.md#metadata-only-index-history--2026-10-25-2873)
and [its purge](../decisions/governed-writable-workers.md#purging-earlier-index-versions-and-the-embeddings-lock--2026-10-25-2903).

### User history restoration (additive, #1653)

The four authenticated human `/revert` operations are specified in
[the HTTP inventory](../http-api.md#retained-turn-journal). `createBrainApi`
adds `turnRevertPlan`, `turnRevertLatest`, `turnRevert`, and `turnRevertReceipt`.
Only `turnRevert` POSTs; receipt readback never repeats execution. The caller's
operation ID is bound to principal/session/source/selection. Stale raw state
conflicts, unavailable detail, unknown outcomes and partial work remain explicit;
voice, agent and autonomous execution do not gain a history action. This is
additive in 0.42.0; no existing read or CLI/MCP shape changes.

<a id="native-intent-recovery-additive-3816"></a>

### Native intent recovery (additive, #3816)

Authenticated `GET /api/status` adds optional `nativeRecovery`:
`{ quarantinedIntents: number, stagingChargedBytes: number | null,
diagnosticsPath: string }`, also declared by `SystemStatus`. It reports the
manager's boot quarantine and conservative staging charge. Invalid UUIDs and
confirmed absent stage directories charge zero; surviving stages retain their
independently recorded historical tmpfs allowance. The charge includes known
stage reservations at boot. `null` means no safe bound is proven, never zero:
`healthy` is false and staging refuses with a recovery diagnostic rather than
claiming a temporary busy slot. Other operations remain available. The private
diagnostics path and causes are never exposed by unauthenticated `/api/health`.
This optional reporting is additive in 0.45.0; no CLI/MCP shape changes.

### Staging refusal and unresolved journal recovery (additive, #3826)

Authenticated `GET /api/status` extends `nativeRecovery` with optional
`stagingRefusal: string`. It describes the recovery needed when a quarantined
charge is unknown or when quarantine alone leaves too little budget for the
configured per-stage allowance. In either case `healthy` is false. Individual
stage requests use their actual requested allowance: a smaller request may fit;
only pressure that can clear when active stages finish returns temporary busy.
The refusal tells the owner to inspect private diagnostics, then either repair
the stage's receipt or confirm its storage is removed (bounded quarantine) or
restore the allowance record from proof of the original size (unknown bound),
and to restart the native manager and the server: `nativeRecovery` is read when
the server boots. No unknown or surviving storage charge is released.

The response also adds optional `journalRecovery`, declared by `SystemStatus`:
`{ unresolvedRecords: number, firstCause: null | { reservationId: string,
hash: string, at: number, errorClass: string, message: string, site: string } }`.
This is the journal worker's boot recovery summary: the count is unresolved
object reservations, including multiple reservations of the same hash, and
`firstCause` is the earliest recorded I/O refusal among them (`at` is Unix
milliseconds). The first cause stays on its charged reservation across restarts;
a successful later recovery removes both. Zero unresolved records means
`firstCause: null`. Any unresolved records make `healthy` false without refusing
boot or unrelated work. If persisting a cause fails, the current boot still
reports it and logs the diagnostic-write failure; the existing reservation
remains durable and charged. Neither summary is exposed by unauthenticated
`/api/status` or public `/api/health`. Additive in 0.45.0.

<a id="degraded-backend-availability-and-unknown-expiry-additive-3817"></a>

### Degraded backend availability and unknown expiry (additive, #3817)

A failed secondary backend leaves public `GET /api/health` live (HTTP 200),
with `status: "degraded"` and `reasons: ["backend_unavailable"]`; uptime and
timestamp stay present. Raw causes and backend identities remain protected.
Authenticated `GET /api/status` adds `backendAvailability` with this boot's
`unavailable` array and durable `lastFailures` (latest per backend). Records
carry `backendId`, `phase`, `site`, `errorClass`, `message`, and ISO `at` as specified
in [the HTTP reference](../http-api.md#liveness-and-operational-status).
`healthy` is false while any secondary backend is excluded. The default
backend still must pass; no version-incompatible backend executes.

An invalid subscription mint date adds `subscription.expiryWarning` with
`reason: "invalid_mint_date"`, `message`, `errorClass`, and ISO `at` while
`mintedAt` and `expiresAt` remain null. Serving and authentication continue.
The missing-date and valid-date shapes are unchanged. These additions ship
in 0.45.0; no CLI/MCP envelope or provider history changes. The exported
`assertBackendResolvable` now returns the excluded secondary backends as
`BackendBootFailure[]`; callers that ignored its former void return continue
to work. Primary-backend and shared profile-configuration errors still throw.

<a id="published-react-health-and-sync-helpers-breaking-health-correction"></a>

### Published React health and sync helpers (breaking health correction)

`@schlessera/brain-ui-react` exports `createBrainApi` and `BrainApi`; the
embedding service `root.api` uses the same helpers. `health()` resolves to
`{ status: string; uptime: number; timestamp: string }`, matching the minimal
public route. The previously declared `version: string` never existed in that
response and is removed under the [maintainer's #693 ruling](https://github.com/schlessera/brain-kit/issues/693#issuecomment-5961143224).
This is an approved pre-1.0 breaking correction shipping in a minor. Migrate
`health().version` reads to authenticated `status()` when software identity is
needed; health never fabricates identity or requests protected status.

`brainSync()` POSTs through its configured base getter/request transport and
consumes complete SSE events. A valid terminal `done` maps `success` and `text`
to the existing `{ success: boolean; message: string }` result; terminal false
resolves as a completed unsuccessful sync. Progress and keepalive comments
are not completion. Missing/malformed terminal data, premature EOF and
transport failure reject as incomplete; non-2xx responses retain
`ApiRequestError`. No automatic POST retry or stream resumption is added.
Disconnect does not establish cancellation: the server continues draining and
reserves the canonical repository until its child exits, as specified in
[the HTTP sync contract](../http-api.md#corpus-queries-capture-and-sync).

<a id="typed-status-software-identity-additive-598"></a>

### Typed status software identity (additive, #598)

`SystemStatus` in `@schlessera/brain-ui-sdk/protocol` declares
`software: { release: string; sourceCommit: string }`, the object authenticated
`GET /api/status` already returns ([HTTP reference](../http-api.md)). `release` is
the installed `@schlessera/brain-ui-server` package version and `sourceCommit`
the configured source commit, equal to `version`. `version` stays the source
commit: it is never a release and clients must not parse it as one. The served
response is unchanged; this only types it. The Activity bug report prints
`server: {release}` and `server commit: {sourceCommit}` only when this read
succeeded, and no server line otherwise.

<a id="worker-host-status-additive-1632"></a>

### Worker host status (additive, #1632)

Authenticated `GET /api/status` gains `runtime.workerHost`, typed as
`SystemStatus.runtime.workerHost` (`WorkerHostStatus`) in
`@schlessera/brain-ui-sdk/protocol`. It is the latest real probe of the agent
worker boundary per mode: `ordinary` for chat, voice and handoff turns,
`restricted` for autonomous turns. Each present mode is `{ available,
checkedAt, trigger }`, with `requirement` when `available` is false; that is
the probe's named requirement, the same text a refused turn names. Boot probes
`ordinary`, and `restricted` only while autonomous work is enabled. A failed
boot probe is logged once and never refuses the boot. Every later probe
re-records its mode: each turn's own gate (`trigger: "turn"`) and each
explicit check (`"check"`).

Authenticated `POST /api/status/worker-host` takes no body, re-runs the boot's
probes and answers 200 with the same `WorkerHostStatus` object. In
`@schlessera/brain-ui-react`, `BrainApi.status()` types `runtime.workerHost`
and `BrainApi.checkWorkerHost()` makes this request.

The status reports; it does not decide. A pass is never cached and a known
failure never short-circuits a turn: every turn runs its own probe and refuses
with `worker_host_unsupported` naming the requirement
([maintainer ruling](https://github.com/schlessera/brain-kit/issues/1632#issuecomment-6112509133)).
A requirement may end in a parenthetical detail. When a turn's separate-UID
launch times out during identity setup, its refusal names the supervisor's last
recorded setup step there. The probe's own requirement is unchanged
([additive, #3664](../integration-contract.md#setup-timeouts-name-their-step-additive-0450-3664)).
Clients must tolerate either mode being absent.

<a id="safety-recording-status-additive-3810"></a>

### Safety recording status and owner recovery (additive, #3810, #3812)

For an owner principal, authenticated `GET /api/status` gains optional
`safetyRecording`: `{ latched, since, reason, cause, retained, lastRecovery }`.
`latched` is true while the brain-wide safety recorder is failed. `since` is
the Unix-millisecond time of the first latch; `reason` is `recording_failed`
or `capacity`, and `capacity` only when a capacity check refused the write.
`cause` is the first latch's `{ reason, site, turnId, errorClass, message,
stack, since, count, durable }`: identifiers and error text only, never
message content; later latches only increase `count`. `retained` is true when
only this process holds the loss because its durable notice could not commit;
`cause` is then the cause this process holds, with `durable: false`.
`lastRecovery` is the latest `{ trigger, actor, at, gapped, cause }`, where
`trigger` is `boot`, `automatic` or `owner`. Other principals never receive
the field.

A brain-wide latch is the exception, not the rule. A failure before delivery
refuses its one turn; lost evidence after delivery restricts its chat with a
permanent gap; only an evidence store that cannot take a scoped fact latches
the brain. While latched, new turns run under their tainted policy with a
permanent pre-delivery gap, and the host clears the latch by itself once the
gap facts are durable and every producer that predates it has ended, failed or
not
([proportionate containment](../decisions/proportionate-containment.md)).

Owner-only `POST /api/status/safety-recording/recover` takes a JSON body
(ignored), runs the same recovery and answers 200 with `{ recovery,
safetyRecording }`. It refuses with 409 `{ code: "producers_open", message,
retryable: true }`, changing nothing, while any safety producer or collection
is open. Each recovery is recorded with its trigger, actor, time and the cause
it cleared. Affected chats keep their gaps.

<a id="account-bound-safety-history-additive-3952"></a>

### A chat's safety history belongs to its account (additive, #3952)

A turn, a safety read (`GET /api/sessions/:id/safety`, WS `safety_read`) and
an owner review of a chat now accept any principal of the chat's account, not
only the principal that started it. A principal id always matches itself.
Two different ids match only when both resolve to the same account partition,
which today means two owner logins, so an agent, ambient or system principal
matches only itself; a missing or unresolvable principal matches no other id.
Another account's principal is refused exactly as before. Read
snapshots, review handles, receipts and the verdict's `principalId` stay bound
to the exact principal. Nothing previously accepted is refused, and stored
rows are not rewritten ([decision](../decisions/session-safety-reviews.md#a-chats-safety-history-belongs-to-its-account-3952)).

<a id="root-server-warning-additive-1638"></a>

### Root server warning (additive, #1638)

`WorkerHostStatus` gains `rootServer: { warning }`, present only while the
server runs as uid 0 (real or effective). Its workers then run as uid 0 too
and keep what root can do without writing: they can read root-owned files and
connect to root-owned and abstract Unix sockets. `warning` is the sentence the
boot log emits once, as a `WARN`, and names exactly that. It appears on
`GET /api/status` as `runtime.workerHost.rootServer` and in the answer of
`POST /api/status/worker-host`, and stays for the life of the process. The
server is not refused for running as root
([maintainer ruling](https://github.com/schlessera/brain-kit/issues/1638)).
The app shows a standing notice above the composer while it is present.
Clients must tolerate it being absent.

### Verified worker identity (additive, #1677)

Successful worker-host checks may include `identity: "separate_uid"` and
`workerUid`, the actual nonzero outside UID verified by that execution's host
probe. `GovernedStatus.identity` additionally accepts `"separate_uid"` with
the same optional `workerUid`. With no identity helper configured the governed
status retains `"shared_uid"`. A configured but unqualified helper does not
produce a separate-UID receipt or silently fall back to shared identity.
Clients tolerate omitted identity/UID fields and new named qualification
requirements. See the [host protocol](../hosting/agent-workers.md#separate-worker-identity).

The optional host input `BRAIN_UI_WORKER_IDENTITY_HELPER` is one absolute
root-owned executable path, never a shell prefix. Its versioned descriptor
protocol, required group access and best-effort recovery limitations are
documented with the host boundary. Production helper installation belongs to
the public hosting template; the packages ship no production setuid binary.
Version 1 gains an additive `view` operation and launch field in 0.44.0
(#2696). A governed launch that retains provider folders requires it, and a
helper without it refuses those launches before payload start.

<a id="governance-events-additive-1651"></a>

### Governance events (additive, #1651)

Authenticated `GET /api/governance/events` reads the governance events the
server keeps with session history: one machine-readable record per sandbox or
governance intervention in a turn. It filters by `session`, `turn` and `kind`
and pages with `after` and `limit`, answering `{ events, nextAfter }` in id
order. Each event is `{ id, sessionId, turnId, at, kind, schemaVersion, actor,
model, profile, payload }`. The [HTTP specification](../http-api.md#governance-events-additive-1651)
holds the parameters, the errors, the attribution values and every kind's
payload fields.

The additive `egress_connection` kind records the concrete turn proxy's host,
port, visible HTTP method/path, bytes, accounting scope, duration and outcome.
CONNECT records opaque bytes without a path or content claim; the inference
tag comes only from the actual relay. Existing `egress_denial` remains named
and versioned as before. Header values, query strings and bodies are excluded.

The additive `provider_mask_refusal` kind (#2690) records a host bridge tool
that refused a path the turn's provider folder masks hide: the tool as the
agent called it, the brain-relative path, the `providers` rule and the policy
hash. One event is written per refused call.

**Durable session safety collection (breaking before 1.0, #3600).**
The version 1 governance taint payload optionally adds strict host occurrence
metadata; the source enum adds `legacy_unknown`. Every input/output/path/mark
signal is independent, including later signals from the same source. Exact
host-key retries deduplicate; changed identity/payload retries refuse. Admission
records `trusted: false`, the admitted policy hash (or `null`) and trust revision
`"0"`. Runtime source trust remains disabled. Verified proxy provenance records
only the actual web origin or opaque tunnel authority; worker tool arguments
never establish transport or repository provenance. The proxy's optional
`connectionId` relates its admission and receipt, without guessing a tool call.

An immutable occurrence starts open. The separate `taint_exposure` event records
host-proven bounded HTTP/tool delivery completion, or interrupted/unknown
completion. Each external result segment and later connection has independent
evidence. A CONNECT close or shell completion cannot prove bounded input ended.
Claude pre/post hooks and the Pi worker's awaited result RPC commit detection
before execution/result delivery. The host provider relay also refuses
unsettled/failed recording, independently of runtime hook cancellation, and
rechecks recording health and cancellation after awaiting budget admission.
Shared recording loss in another turn therefore fences the pending dispatch.
Claude reserves resumed input synchronously so immediate follow-ups remain
accepted while collector readiness is pending. Readiness must complete before
worker or SDK startup; failure releases the input reservation for retry.
Unsupported or metadata-free collectors retain
an incomplete epoch. The version 1 detector manifest explicitly excludes
proxied-shell local file reads and opaque tunnel inner protocols.

Pi's outer Agent hooks collect curated tool results before continuation.
Managed workers refuse all loaded external extensions and extension loading
errors before session creation, and recheck the live loader/runner before Agent
provider dispatch. No extension path, name or package identity is exempt. This
includes web/MCP/subagent extensions and handlers registered during execution:
live result/message mutation and independent custom-message injection make a
handler blacklist insufficient. No arbitrary extension delivery is qualified.

Refusal awaits the existing optional internal
`BackendBridge.inputSafety.unavailable()` notice and stops the worker. The host
owns durable failure retention; callback rejection alone cannot establish it.
Startup collector loss uses a typed one-way worker error, without awaiting an
RPC answer behind initialization. The host awaits its loss notice before
acquisition settles; only successful initialization acknowledges the detector
epoch. Ordinary cancellation, busy-session and caller refusals preserve their
existing outcomes and do not fail recording across the app. A
refused configuration must retain incomplete coverage through recovery. The
notice cannot grant authority or clear evidence, and transformed history is
never rewritten to recover coverage.

Failure to commit a collector-loss notice retains a bounded connection-local
loss marker and immediately refuses new collection/provider dispatch through
every facade. Producer completion must durably retain that loss before sealing
the epoch; failure leaves it open for restart classification. Explicit recovery
commits affected historical gaps before clearing local state, even if the
original notice rolled back. Unknown/capacity-overflow loss correlation retains
conservative gaps for all epochs.

No external extension receives nested `ctx.executeTool()` access; curated tools
contain no nested calls. The prior inline nested gate is removed, and no nested
execution capability is advertised. Managed workers pin the installed
`SettingsManager.getCacheWarmingMode()` method to `off`, including across
settings reloads and mode writes. This disables the installed CacheWarmer's
separate direct `ModelRuntime.streamSimple()` dispatch, which the Agent stream
fence does not wrap. Both provider-history guards and supported-host/selected
hosted proof remain required qualification; focused in-memory SQLite loopback
captures are not FULL write-worker/restart or namespace proof.
Search paths and explicit marks remain independent signals when the same line
also indicates truncation or contains ordinary excerpt words such as omitted.

The host retains an independent durable ledger, decimal uint64 revision,
once-only provisional-to-SessionKey binding and bounded coverage epochs. Every
pre-upgrade session is incomplete, including those with no old taint row; an
old row migrates as one known occurrence. Imported/discovered histories remain
unknown, including provisional owners discovered after migration. Canonical
aliases and actual history generations bind that evidence, including when
the catalog announcement precedes retained-dialogue adoption. A later typed
dialogue reuses the already-bound host owner; neither opening nor resuming it
rewrites the original binding. Resumes/backend
changes retain prior epochs, and forks inherit
unresolved evidence and unknown coverage only on their first unresumed turn.
Queued continuations retain that snapshot without recopying source evidence or
importing later source activity. Actual catalog creator, principal,
history owner, aliases and generation govern binding. Retired session/owner/turn
identities refuse late callbacks even after private detail is removed.
The principal binds as its account
([additive, #3952](#account-bound-safety-history-additive-3952)).

Effective admission is restricted for any unresolved occurrence, incomplete or
unknown coverage, pending recording, failure or exhausted capacity. Only a
proven new session with acknowledged mandatory collectors and zero unresolved
records can be normal. This deliberately changes the former no-row-means-clean
G6 default under the [dated ruling](../decisions/session-safety-reviews.md).
Existing provider history remains byte-identical. No review/clearing route,
trust enforcement or safety capability is enabled; the reviewed
public safety-history DTOs remain prospective. Older clients continue under host
restrictions without new mutation controls.

**Live admission supersession (breaking before 1.0, #3602).** Proxy dispatch,
both first-party backend gates, outward policy allowances and new journal
attribution use the current effective aggregate. The host reads
`(evidenceRevision, trustRevision, authorityEpoch)` with the exact turn/session
generation and frozen ordinary policy hash after its last asynchronous wait,
in the continuation that dispatches. Pi also rechecks after its post-permission
RTK and lock waits, with an exact-input, one-use final worker admission. New/pending input, recording loss and
unknown coverage remain restrictive; pending/failed verdicts never clear them.
A proxy may exclude only its own newly retained input from that request's
first-byte test when it was otherwise normal. A concurrent connection cannot
borrow that authority. Contacted-host legacy grants begin only at dispatch;
validated provider relays remain excluded from those grants.

A completed per-use outward approval is distinct from standing policy authority.
An earlier standing allowance is recomputed at dispatch; a stale pending card
is claimed/withdrawn through the coordinator, with a durable
`safety_admission_expired` governance event before the backend wait settles.
Its existing tool-resolution outcome is `expired`. No denied or interrupted
operation replays automatically. Direct host permission callers have the same
host-owned snapshot and withdrawal behavior. An answer claimed by a handler
stays under coordinator ownership while its legacy grant write waits; safety
invalidation, cancellation and grant-write failure settle it exactly once and
cannot dispatch a stale grant. Terminal event reasons are `safety_changed`,
`turn_ended` and `grant_storage_failed`. A successfully persisted legacy grant
remains its independent historical fact and cannot revive the expired call.
Receipt-storage failure stops the turn and emits an explicit failed terminal
outcome, without claiming durable withdrawal. Ordinary budgets, commands, profiles,
egress configuration, credential routing and outward/voice controls keep their
existing independent, turn-bound meanings. No persistent source matching,
Settings publication, scoped-network capability or owner review route is enabled
by this admission slice. Historical journal/egress/approval facts and provider
prefixes are unchanged; only later decisions and new journal attribution use
the live state.

**Individual verdict persistence (breaking before 1.0, #3601).** The host-only
writer now prepares one selected finalized occurrence and atomically commits
its immutable `safe` decision, revision and terminal request receipt on the FULL
SQLite write worker. This implements the dated
[G6 ruling](../decisions/session-safety-reviews.md); owner-authenticated HTTP/wire operations remain a separate implementation slice.
No endpoint or capability is added by this persistence layer. Host identity
arguments do not establish human authorization.

The authoritative projection reduces all retained compact identities and
committed decisions, independently of any history page. Resolving A leaves B
and later same-source C unresolved. Only complete detector coverage, zero
unresolved/pending occurrences and no recording/capacity latch permit normal.
Open/interrupted exposures refuse review; original occurrences, transitions,
decisions and historical policy facts remain immutable. Pruning removes display
detail only; selected IDs, verdict references, counts and revision survive.

Internal preparation accepts a strict version-1 single-occurrence body bound to
the exact SessionKey and expected evidence revision. Ranges, source-wide clears,
session-wide clears and caller authority fields refuse. Trust publication is not
part of this operation. A host-minted request binds canonical body digest,
principal, channel and generation, and expires after 900000 ms.
Time is sampled inside the acquired write transaction, after writer-queue and
SQLite lock waits. Issuance starts the full handle lifetime; decision and replay
expiry use execution time, and receipt retention starts at terminal storage.
New committed evidence stales a prepared review; pending input restricts immediately, and a
pending verdict never decrements the aggregate. Failed verdict COMMIT rolls back
decision, revision and receipt together without reporting success.
Recording-loss refusals remain `recording_failed`, distinct from input that is
still `recording_pending`, including loss retained only by the app connection.

Same-body retries retain their exact original receipt, including its historical
projection, for 86400000 ms after terminal commit; admission always reads the
current projection separately. Changed-body reuse returns `request_conflict`;
already-resolved, nonfinal, stale, expired and unavailable requests have explicit
refused outcomes. Refusals carry no normal projection. Receipts are reserved
before handle issuance: 32 outstanding per principal, maximum 256 per brain,
10000 retained receipts and 16777216 reserved bytes. The implementation reserves
262144 bytes per receipt, so the effective brain ceiling is 64 retained handles.
Capacity refuses new preparation without evicting live receipts or consuming the
verdict space prepaid by retained occurrences. Unknown/pruned handles can never
become fresh requests. Restart preserves prepared and terminal receipts; open
collection epochs still degrade under the existing restart rule. Retirement
precedes successful replay and returns `retired` for the owning identity even
after private request/decision detail is removed. Permanent lifecycle fences
remain; no request TTL recreates a retired session. Provider history is unchanged.

The ledger enforces the design's 8192-byte occurrence, 100000-row/67108864-byte
session and 1000000-row/536870912-byte brain ceilings, counting reserved verdict
and terminal slots. Durable pending ceilings are 256 rows/1048576 bytes per
session and 4096 rows/16777216 bytes per brain, shared across writers. Unbound
collection is capped at 1024 bindings/8388608 bytes, with 128 epochs per session.
Collection metadata and permanent retirement-fence capacity are reserved too.
Catalog and collection admission atomically include all outstanding durable row
and byte reservations in the same ceilings. Binding unbound collections also
atomically checks their combined pending count and serialized pending bytes.
Before accepting input, failure/capacity restrictions use preallocated durable
emergency cells. Outstanding terminal evidence uses its existing reserve.
Restart retains pending failure and unknown exposure; explicit internal recovery
requires stopped producers, settled connection-local writes and available
capacity. Only a committed recovery clears the shared local failure latch;
existing and new facades retain historical gaps and unresolved evidence. Ended
failure facts remain in epoch coverage but, after that recovery, no longer
represent an active outage preventing a new restricted turn on that session.
Detail pruning preserves IDs, counts and compact audit/reserved capacity;
unbound safety evidence has no eviction TTL. Revision exhaustion refuses before
wrap. These foundations supply the later verdict slice's projection without
publishing a mutation surface.

<a id="shell-taint-behind-the-egress-proxy-breaking-3429"></a>

**Shell taint behind the egress proxy (breaking before 1.0, #3429).** On a
turn behind the turn egress proxy, `taint` is no longer recorded with
`source: "fetching_command"` or `"unclassified_command"`; the proxy's
`egress_connection` source covers shell network access there. A turn without
the proxy still records both. The payload shape and version are unchanged, and
stored events keep their recorded sources.

<a id="tainted-destinations-ask-additive-3430"></a>

**Tainted destinations ask (additive, #3430).** In a tainted interactive turn
behind the proxy, a connection to a host outside `taint.egress.allow` and the
session's contacted hosts now raises the existing tool-permission request
before it is refused: `toolName: "Network"`, `kind: "command"`, `input` of
`{ host, port, method, target }` with `target` as `host:port`, and a
`description` naming what tainted the session and what allowing does. No
request field, kind or card variant is added. An allowed connection records
`egress_connection` as any admitted one does; a declined one records
`egress_connection` with `reason: "taint_not_approved"` and the existing
`egress_denial` with `reason: "taint_allowlist"`. A turn stopped while the card
is pending records the connection as `cancelled` with `turn_cancelled`, as any
connection its turn stops. Voice turns refuse without a request, as before,
with `reason: "taint_not_allowed"`.

The `outward_action` kind's `action` gains `compute_run` and the `taint`
kind's `source` gains `compute_output` (both additive, #3108): a hosted
external compute run's approval decision, its target the instance id, and a
collected job's output. Version 1 is unchanged otherwise.

Authenticated `GET /api/status` gains `runtime.compute` (additive, #3108):
`{ enabled, reason, core, stateDir, stateMasked, bindings, instances,
openJobs }`. `reason` says why hosted compute refuses every run, or is `null`.
`core` is `present`, `missing` or `unknown`. Each binding is `{ provider,
package, remoteExpiry, defaultKeyEnv, credentials }`, with each credential `{
name, implicit, present, leakedToWorkers }` (names only, never a value).
`instances` is the last configuration a turn read, each `{ id, provider,
builtin, credential, bound, present, refusal }`, or `null` before any read.
No vendor is called to produce it.

The kinds and each kind's payload are versioned separately. A payload change
that is not purely additive bumps that kind's `schemaVersion`, and stored
events keep the version they were written with, so a new version or a new
kind is an additive change. Clients must ignore unknown kinds and unknown
payload fields. A kind no release emits yet may still change its version 1
payload before its emitter ships.

The server emits `roadblock` from #1671 on, so its version 1 payload is now
extended additively by #2034 with remedy `abandoned`; existing values and stored
version-1 evidence retain their meaning and are never rewritten. Unresolved
waste now stops at the first success starting strictly after the last failure
was known, without inventing semantic resolution. A single such failure with
no retry is abandoned; repeated unresolved failures remain capability.
The report's optional `remedy` filter matches `query_activity`: `actionable`
(default, excludes abandoned before aggregation), `all`, or one of `guidance`,
`capability`, `abandoned`. Counts add `abandoned`. This is an approved breaking meaning/default change before 1.0, shipped in a
minor under the recorded #2034 maintainer ruling. Its `signature` is a grouping key whose format the HTTP specification
defines, so readers such as a roadblock report can group episodes across
sessions by comparing signatures for equality.

The events are host operational state in the server's own database. They are
never written to `brain.db` or the brain, never authoritative for anything,
and never shown to the user. They survive the Activity span-detail prune and
are deleted with their session.

<a id="worker-resource-limits-additive-1660"></a>

### Worker resource limits (additive, #1660)

`WorkerHostStatus` gains `limits: { enforced, absent }`
(`WorkerLimitsStatus` in `@schlessera/brain-ui-sdk/protocol`), re-read with
every probe. Each `enforced` entry is `{ limit, source, value }`; each
`absent` entry is `{ limit, source, reason }`. `limit` is one of `processes`,
`data`, `file_size`, `open_files` (`source: "rlimit"`, per process) or
`memory`, `pids`, `cpu` (`source: "cgroup"`, for the whole worker). `value` is
bytes for `data`, `file_size` and `memory`, CPUs for `cpu`, and a count
otherwise. `reason` says why a limit is not enforced: no delegated cgroup, no
`prlimit`, no `nsdelegate` on the cgroup2 mount, uid 0 for `processes`, a
malformed `BRAIN_UI_WORKER_LIMITS`, or the host turned it off.
It appears on `GET /api/status` as `runtime.workerHost.limits` and in the
answer of `POST /api/status/worker-host`. Clients must tolerate it being
absent and must not assume the list of limit names is closed.

<a id="governed-availability-additive-1648"></a>

### Governed availability and host execution (additive, #1648)

`WorkerHostStatus` gains `governed`, typed as `GovernedStatus` in
`@schlessera/brain-ui-sdk/protocol`: whether the `governed` worker profile can
run on this server, and where the server evaluates the brain's own code.

- `{ available: true, hostExecution: "worker" }`: governed can run, so every
  evaluation of the brain's config and its imports, every server-spawned
  `brain` command, every cron job and every git invocation against the brain
  runs in a maintenance worker, never in a host process.
- `{ available: false, reason, detail, hostExecution }`: governed cannot run,
  and interactive and voice turns run under `strict`. `reason` is
  `server_cwd_in_brain` (the server was started inside the brain, so Bun
  already loaded the brain's `bunfig.toml` and `.env` into it),
  `database_in_brain`, or `worker_host_unavailable` (with the probe's
  requirement as `detail`). `hostExecution` stays `"worker"` once a governed
  turn has ever run on this brain or a real probe has proven the worker
  boundary in this process; otherwise it is `"host"`.

Boot records it, and `POST /api/status/worker-host` re-records it in its
answer. Each change is logged once: a warning, except for
`worker_host_unavailable`, which the worker host entry already warns about.
Clients must tolerate it being absent.

<a id="internal-queue-poke-additive"></a>

### Internal Queue poke (additive)

The supported `POST /api/internal/inbox/poke` operation uses an independent
boot-minted bearer token and the actual loopback socket, before general API
authentication in every auth mode. Forwarding headers never authorize it.
Its runtime-file configuration, rotation, exact success/error shapes and
bounded stopped-interval recovery are specified in [inbox-runtime.md](../inbox-runtime.md).
The generated host consumes this operation; its `/internal` path does not
exclude it from HTTP compatibility. The shipped app wiring performs recovery
and heartbeat work with no production dispatcher. An unavailable or closed
runtime never grants access to ordinary APIs or enables autonomous execution.

<a id="interactive-html-preview-additive-1084"></a>

### Interactive HTML preview (additive, #1084)

`GET /api/files/html?path=…` is an internal UI transport for the file
viewer's script-running preview and its "Open in new tab" link. Its raw path
is not an independent API. Its isolation is a security property that a
consumer and a reviewer may rely on: it serves `.html`/`.htm` files under the
raw route's path, auth and size rules, with a CSP `sandbox allow-scripts`
directive (an opaque origin), `connect-src 'none'`, `form-action 'none'` and
`frame-ancestors 'self'`. It is the only response sent with
`X-Frame-Options: SAMEORIGIN`; every other response keeps `DENY`. The
[HTTP specification](../http-api.md#interactive-html-preview-additive-1084) has
the full header set and the residual risks accepted in #1084. Removing a
sandbox restriction or widening a source list is a reviewed change, and the
real-Chrome test fails on it. `GET /api/files/content?raw=1` and its CSP are
unchanged. The SDK's default service-worker policy never answers an `/api`
navigation from the app shell.

<a id="account-partition-key-additive-1014"></a>

### Account partition key (additive, #1014)

```
GET /api/vpn-check → 200 { vpn: true, accountKey?: string }
```

The authenticated connectivity probe now also names the account the caller
is signed in as, for device-local partitions. `accountKey` is an opaque
22-character base64url digest. It is the same for every sign-in as the same
account on the same host and root, and differs between hosts (each UI
database has its own random seed) and between brain roots. It is a partition
name, not a credential: holding it grants nothing on the host. A client must
not parse it, and must not use `server_hello.principalKey` in its place,
because that one changes at every sign-in.

| Auth mode | Who gets a key | Same key across sign-out and sign-in |
| --- | --- | --- |
| `password`, with a password or a passkey | every owner login, one key | yes: every owner login is the one owner |
| `tailscale` | every admitted client, the owner's key | yes: the mode has no sign-in |
| `proxy` | each upstream user, its own key | yes, per upstream user |
| `none` | every client, the owner's key | yes: the mode has no sign-in |
| any mode, an agent principal | nobody: the field is absent | — |

A refused probe (401, 403) carries no key. A host older than this field
sends none, and the client then keeps nothing in an account partition.

`@schlessera/brain-ui-react` uses the key to keep the composer's work
context (drafts, images, voice review text, selection, focus and transcript
position) in IndexedDB, in a partition it opens only while it holds the same
key. That storage layout is client behaviour, not wire contract. It is a
boundary inside the client, not encryption, and not protection against
someone with access to the device.

<a id="corpus-stats-history-get-apibrainstatshistory-additive-in-0400"></a>

### Corpus stats history (`GET /api/brain/stats/history`, additive in 0.40.0)

Passes `brain stats --history --json` through untouched, behind the auth
guard with the other `/api/brain/*` routes; the shape is under "Stats
history" above. A brain CLI older than 0.40.0 rejects the flag, and the route
answers `500` with `{ error }`. A consumer treats that, and a 404 from an
older server, as no history.

<a id="index-reads-wait-for-applications-2835"></a>

### Index reads wait for applications (0.44.0, #2835)

Hosted applications index their Markdown after they return (see the
[application contract](mcp.md)). `GET /api/brain/search`, `/api/brain/list`,
`/api/brain/stats`, `/api/brain/stats/history`, `/api/brain/briefing` and every
`/api/graph/*` route first wait for the index update covering every
application committed before the request. When that update fails, the route
answers `503` with `{ error, code: "index_stale" }` instead of a stale result;
the error names the committed paths and the index failure, and a retry tries
the update again. Shapes are otherwise unchanged; the status and code are additive.

<a id="runtime-stats-get-apiactivitystats-additive-in-0370"></a>

### Runtime stats (`GET /api/activity/stats`, additive in 0.37.0)

The runtime half of a stats surface. `GET /api/brain/stats` passes
`brain stats --json` through and stays the corpus channel; this route reports
what the **server's own** database holds — sessions, runs, tokens, cost — and
never reads brain.db. A consumer calls both and merges. It sits behind the
auth guard with the other `/api/activity/*` routes. `?days=N` picks the
window (default 30, clamped to 1–90). The shape is `ActivityRuntimeStats` in
`@schlessera/brain-ui-sdk/protocol`; timestamps are ms epoch:

```
{
  generatedAt,
  lifetime: { scope: "lifetime", sessions, turns, costUsd,
              firstActivityAt | null, lastActivityAt | null, elapsedDays,
              averages: { costUsdPerSession, turnsPerSession,
                          costUsdPerDay, costUsdPerMonth } },
  window:   { scope: "window", days, since, until,
              recordedSince | null, coveredDays,
              detailRetention: { days, cutoffAt, insideWindow },
              detailPrunedRuns,
              runs, failures, costUsd, effectiveCostUsd,
              unpricedRuns, unpricedListCostRuns,
              inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
              averages: { runsPerDay, costUsdPerDay, costUsdPerMonth,
                          effectiveCostUsdPerDay, effectiveCostUsdPerMonth } },
  database: { sizeBytes }
}
```

Rules a consumer may rely on:

- **Every figure is labelled with what it covers.** `lifetime` is read from
  the never-pruned session catalog; `window` from the run rollups, over
  exactly `[since, until]` — a closed interval whose upper end is enforced, so
  a run dated after `until` (a clock corrected backwards leaves such rows) is
  not summed. The two do not agree and are not meant to: the catalog predates
  the activity record, and the two count different things.
- **The window says how much of itself it can vouch for.** Rollup rows
  outlive detail pruning, so the sums are complete back to `recordedSince`
  (the oldest run in the record at or before `until`) — and no further;
  `coveredDays` is the span the per-day averages divide by.
  `detailRetention.cutoffAt` is where drill-in detail stops, `insideWindow`
  says whether that boundary falls inside the window, and `detailPrunedRuns`
  counts the runs in it that are already rollup-only. Say "detail older than
  N days is pruned"; do not present a window as a total.
- **Unknown never reads as $0, on EITHER cost axis.** Each cost sum is a sum
  of known values, and each carries **its own** excluded count, because the
  two columns are independently nullable: `costUsd` (list price) excludes
  `unpricedListCostRuns`, `effectiveCostUsd` excludes `unpricedRuns`. A
  subscription-billed run with no backend-reported cost is in the first
  counter and not the second — its effective cost is a known $0 while its
  list price is unknown. Render both the same way: "≥ $X · N unpriced" when
  the counter is nonzero, and wholly unknown when it equals `runs` — never as
  the `0` that a sum of no known values carries.
- **An average is `null` rather than a fabricated rate.** Every average is
  `null` when its denominator is zero, `costUsdPerDay`/`PerMonth` are `null`
  whenever `unpricedListCostRuns > 0`, and `effectiveCostUsdPerDay`/`PerMonth`
  whenever `unpricedRuns > 0` — a rate over a partial sum would hide the hole
  the sum shows. `lifetime.elapsedDays` is `0`, and its per-day and per-month
  figures `null`, when the catalog is empty *or* its oldest session is dated
  after `generatedAt`; the lifetime totals still include such a session, since
  it happened.
- **The route does no rounding or formatting**, while
  `GET /api/activity/rollups` rounds each completed day/job/session sum on
  both cost axes to 4 decimal places, only at the response boundary; stored
  costs retain their original precision. Over the same window the two therefore
  report `0.299997` and `0.3` for one quantity. Round at render time, identically for both, rather than treating
  either as pre-formatted. This channel stays raw on purpose: rounding a sum
  to 4 dp turns a real sub-$0.0001 cost into a `0` that reads as free.
- **`lifetime.costUsd` is a floor, and cannot be better than one.** The
  session catalog folds an unreported cost into `0` at write time, so no
  unpriced counter is recoverable at read time; `window` is the channel that
  separates unknown from zero. `lifetime.turns` has the same shape.
- `database.sizeBytes` is the logical size of the server database (pages ×
  page size, the WAL sidecar aside). It is a rebuild-cost figure for a
  disposable store, not a claim that the file holds authoritative state.

### Scratch overage events (additive, #1656)

`GET /api/governance/events` also accepts and returns kind `scratch_overage`,
version 1, with `{bytes, pinnedFiles, pinnedBytes, overageBytes}`. Periodic scratch
pruning records it with actor `server`, null session/turn/model/profile, and the
existing unbound-event retention. A failed event write falls back to the overage
log; pinned files remain protected. The closed kind/payload specification is in
[the HTTP reference](../http-api.md#governance-events-additive-1651).

## Governed profile status (additive, 0.42.0, #1649)

`runtime.workerHost.governed` adds optional `profile` (`governed` or `strict`),
`protectedPaths` (objects with `path`, `mode` and `reason`), `profileFallback`,
`identity` (`shared_uid`) and `configurationView` (`live` or `startup`). A mode
is `read_only`, `mask_file`, `mask_directory` or `absent`. These describe the
current ordinary-turn default; each turn resolves its protections again.
The existing availability and host-execution fields keep their meaning.

`runtime.workerHost.governed.egress` (additive, 0.44.0, #1665) is
`{ active, detail }`: whether governed and strict turns run on their own turn
egress proxy. The server boots only on managed native storage (#1793), so it is
`active: true` on every running server, and `detail` says which turns are
routed. The field is not removed: `active: false` remains for a brain that is
not on managed native storage, where `detail` says that every governed and
strict turn is refused rather than run without the proxy (#3314).

### Operational-state layout refusal (additive, #1649)

The host boundary status reason adds `private_state_in_brain` alongside
`database_in_brain`, with the same migration detail the boot refusal uses.
Every hosted profile refuses boot as `OperationalStateInBrainError` when
`DB_PATH` or private poke-token state resolves inside the brain. The error
carries the unavailable diagnostic as `status`; no HTTP listener is created.
The hosting guide documents migration and the retained directory masks.


<a id="session-worker-profile-additive-1663"></a>

## Session worker profile (additive, #1663)

Authenticated hosts advertising `capabilities.sessionProfiles` support
`GET` and `PUT /api/sessions/:id/profile` for a catalogued chat, and
`GET` and `PUT /api/drafts/:id/profile` for the existing unbound composer
identity. The draft route keeps only a preference; it creates no session,
reservation or dummy text. A PUT body is `{ preference: "governed" | "strict" }`.
Requests and responses are not cached. JSON bodies are bounded to 4 KiB.

Successful responses carry `SessionWorkerProfile`: confirmed `preference`,
current lower-bound `policyProfile`, nullable `policyHash`, `origin`
(`interactive` or `voice`), optional `actualProfile` of the latest admitted
worker, and `limits` (`{ name, value, onHit? }[]`). Draft responses additionally
carry `draftPreferenceStored`, true only after a successful durable save.
Unknown enforcement facts are explicitly `Unknown`; parsed future budgets
and scope caps are not represented as active enforcement. The actual worker
may be stricter than the preference because of policy or launcher fallback.

Unknown catalog sessions return 404; invalid values/identities return 400;
revoked/expired principals return 401. The store revalidates durable authority
inside each save transaction after reading the body. A governed save below a
strict policy, or any voice save, returns 409. Failed saves preserve the
confirmed preference. A change affects subsequent interactive admission,
never the authority already frozen for a running turn.

Draft preferences are principal-bound and capped by the existing host draft
count. At capacity the host refuses a new preference with 507 instead of
evicting a live confirmed choice. Expired-principal rows are removed on save;
a successful first-session binding consumes that draft preference into the
session catalog. Another principal or draft cannot borrow it.

## Policy review reads (additive, #1662)

The internal authenticated `GET /api/policy-proposals/:turnId/:requestId`
returns only the existing principal-owned `PolicyChangeReview`; an optional
`session` must match its bound session. Reads never approve, write or revive
execution. `GET /api/agent-policy` reads the admission policy cache and recorded
worker-limit facts, without an editor or another policy cache. Their shapes,
refusal states and recovery behavior are specified in the
[HTTP reference](../http-api.md#policy-proposal-receipts-additive-1662).
The governance event API additionally accepts/returns `policy_change` with
request id, exact base/proposed hashes, changed sections and updated outcome,
with actor `user`.


### Steering observations (additive, #1658)

Journal details may add `tainted: true` and an optional `taintSourceEventId` to a steering
change. New observations capture effective restriction, including unknown
coverage without an attributable source. An available ID names the current
unresolved event. Older rows retain their original attribution; replay never
derives it from later events or verdicts. A missing flag is not a claim that untrusted-input coverage
is complete. Policy changes remain class `policy`, with user attribution, and
are excluded from `steeringFiles`.

The governance event API accepts/returns `steering_change`, version 1, with
`path`, journal `sequence`, nullable `beforeHash`/`afterHash`, nullable
`taintSourceEventId`, `overlappingTurnIds` and optional `tainted: true`. New observations retain effective restriction even when unknown coverage has no attributable source; older rows and events are unchanged. It records an observation, not
an exclusive writer or per-write interception. Configuration inventory that
cannot identify a retained local input is named in journal `missing` with
`configuration_inputs_not_fully_identified`; raw-version availability remains
independent of that classification limitation.


### Observed shared-window conflicts (additive, #1659)

`TurnJournalChange.conflict` may contain `versions` and `latest`, each an
explicit retained `{ turnId, sequence, side: "after" }` observation reference.
The host marks a conflict only after two distinct after-version identities were
observed in a shared window. A single version with overlap remains shared
attribution, not a conflict or an exclusive writer claim. Raw versions
superseded between observations remain unrecoverable.

Existing user `/revert` POST and `createBrainApi.turnRevert` additionally accept
`keep_version` or `keep_both`, `path`, `version`, `expected`, and (for keep both)
`otherVersion`. All references must belong to that path's original retained
turn; `expected` names its reviewed latest observation. At application the
actual raw state must still match; later work is skipped. The durable operation
identity includes the selected references. Receipt `resolution` preserves them;
Check again never repeats an effect or revives authority.

Keep both creates the other regular-file version with exclusive creation beside
the selected file, using sync-style `-remote.md`, `-remote-2.md` naming (for other
suffixes, `-remote` follows the whole name). Existing names are never overwritten.
The generated sibling receives explicit journal coverage and index refresh.
Both effects remain user journal entries, with existing conflict-safe Undo.
Partial writes or unavailable storage remain partial/unknown, not an atomic
merge guarantee. Existing owner/ambient, voice, expired-detail, protected-path
and cross-session restrictions remain binding.

### Human-only Storage inventory (additive, #2010)

The six [Storage inventory operations](../http-api.md#storage-inventory) and
SDK `StorageStatus`, `StorageSnapshot`, `StoragePage`, `StorageFileEntry`,
`StorageReferenceEvidence`, `StorageTreePage`, `StorageTreeNode` and related types are additive contracts. They bind
authorization, configured-root scope, bounded output/lifetime, opaque cursors,
object/capacity deduplication and explicit partial/unknown semantics. This
transport foundation does not register a pane or authorize cleanup.

Storage pages distinguish `fileLogicalTotal` (logical bytes per matching regular-file
entry, including aliases) from `totals` (the deduplicated physical-object union).
Empty unavailable ownership views carry null bytes, not zero. Capacity `kind`
identifies `tmpfs` as memory-backed; `filesystem` does not promise exclusive disk
ownership and `unknown` cannot be drawn as healthy capacity.

Hierarchy pages separate per-subtree object-union `totals` from disjoint sibling
`area`, preserve alias names and unknown coverage, and bind cursors to the tree
operation and its search/order/ownership criteria. Projection uses retained scan
evidence only. Entry search/order is additive; absent options preserve ordering.

### Recoverable attachment removal (additive, #2012)

The six [attachment removal operations](../http-api.md#recoverable-attachment-removal-additive-2012)
and SDK `StorageRemoval*` review/capability/receipt types are additive contracts.
They bind current human-owner authority, exact versioned selections and durable
identities to charged retained originals. Unknown outcomes never authorize
replay. Undo is separately reviewed, cannot overwrite a replacement, and expires
with actual journal detail. Existing Markdown application semantics are unchanged.

### Storage history and pressure guidance (additive, #2058)

The two [history/guidance operations](../http-api.md#storage-history-and-pressure-guidance)
and SDK `StorageHistoryResponse`, `StorageGuidanceResponse`, named observation,
pressure, rate and scenario types are version 1 additive contracts. They retain
current human-owner authorization, nullable unknown quantities, actual endpoint
and window times, independent causes, explicit stale/scope gaps and transport
uncertainty. Public types do not expose compact persistence tuples or host paths.
The next compatible server/SDK minor includes these endpoints; clients must
retain an unavailable state when an older host does not provide them. No core
CLI, MCP, frontmatter, config or content-index contract changes.

### Activity host timing envelopes (additive)

`GET /api/activity/runs` adds `lifecycles: ActivityTurnLifecycle[]`, bounded by
its list limit and filtered by session when supplied. Backend live/history
summaries add optional `lifecycle`; existing list membership, filtering,
backend durations and costs remain unchanged. Envelope-only attempts are in
`lifecycles`, never disguised as backend runs. `GET /api/activity/runs/:runId`
adds optional `lifecycle` plus its `lifecycleSeq` high-water, also on its rollup, and resolves an envelope-only
turn with no spans/rollup and `detailPruned: false`. Historical records omit
it. The agent Activity query returns the same envelope on run/recent reads.
See [host turn lifecycle](wire.md#host-turn-lifecycle-additive) for timestamp,
terminal, missing-phase and historical semantics. No inference aggregation
includes envelope records.

### Prompt-cache diagnostics (additive, #2050)

Retained `GET /api/activity/runs/:runId` detail adds optional `cacheDiagnostics`:

- `firstRequest`: nullable `{ inputTokens, cacheReadTokens, cacheCreationTokens,
  source, coverage }`. Each counter is a nonnegative integer or `null` when unreported;
  `source` is `claude_root_stream` or `pi_main_message`. Claude selects the first
  root `message_start`; Pi selects the first completed non-error assistant
  `message_end`. `coverage` is `provider_reported` for Claude and
  `runtime_normalized` for Pi. Installed Pi normalization fills absent provider
  cache-read/write fields with zero; a Pi zero is a normalized runtime value,
  not evidence that the provider explicitly reported zero. Later responses, child channels and title-helper evidence
  cannot replace it, including when helper and main use the same model.
- `prefix`: nullable `{ tools, system, model, thinking, gitStatusIncluded,
  coverage: "assembled_inputs" }`. Each component is a lowercase 64-character
  SHA-256 digest or `null` when unavailable. `gitStatusIncluded` is boolean or
  `null` when unknown. No prompt, tool description, schema or message text is
  retained in these diagnostics.
- `resumed`: nullable boolean; `suspectedBreak`: true only for a known resumed
  turn with first cache-read zero and creation positive, false for a fresh
  turn or a known nonmatching split, otherwise `null`.
- `changed`: an array of changed component names (`tools`, `system`, `model`,
  `thinking`, `gitStatusIncluded`), `unchanged`, or `unknown` when a comparison
  baseline or required component is unavailable. This compares assembled
  inputs against the preceding retained conversation turn, excluding auxiliary
  accounting runs. A pruned baseline is unknown.

Fingerprints cover backend assembly, not complete provider wire bytes. Claude's
roster digest includes the ordered assembled brain-ui schemas and explicit SDK
built-in selection/exclusions; CLI-owned built-in schemas and project MCP
configuration remain opaque. Its system digest includes the preset and exact
append passed to the SDK; runtime/model defaults are unknown when unspecified.
Pi computes its ordered active tool schemas, system prompt, model and effort
inside the actual worker before prompting. Subsequent runtime extensions may
still alter provider assembly. Neither backend's digest establishes a provider
cache key, cache eligibility, first-party request equality or savings.

`GET /api/activity/stats` adds optional `window.cacheDiagnostics` with
`scope: "retained_detail"`, `observedRuns`, `runtimeNormalizedRuns`, `unknownRuns`, sums of first-request
`inputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `suspectedBreaks` and
`unknownBreakRuns`. Token sums include only runs with all three reported
counters; old, auxiliary, uninstrumented and pruned runs count as unknown,
not zero cache usage. `runtimeNormalizedRuns` counts included Pi records so
normalized zeros remain distinguishable from provider-reported evidence. Detail pruning removes these diagnostics with the root
span; existing lifetime/window accounting and turn totals retain their meaning.
No historical rows are backfilled, and these fields do not assert a live cache
hit. Existing root attributes also expose the hash-only records to Activity's
span/query consumers.

<a id="reference-source-grants-additive-2429"></a>

### Reference-source grants (additive, #2429)

`GET`, `POST /api/auth/principals/:id/reference-grants` and
`DELETE /api/auth/principals/:id/reference-grants/:grantId` are specified in
[the HTTP inventory](../http-api.md#reference-source-grants). A grant binds the served brain, one live
owner or agent principal, a canonical repository prefix and one named existing
host credential from a fixed list, or none. Private reference source is fetched
only while a live grant covers the requesting principal and repository; a
configured host credential never grants access by itself. Revoking the grant or
its principal applies to the next authority check, including in-flight private
refreshes. The routes add no credential storage and return no credential value.
The [grant decision](../decisions/reference-source-grants.md) records the ruling.

## Content renderer bootstrap declarations (additive, #2087)

Authenticated `GET /api/status` includes optional `contentRenderers`, an array of
`{ module, version, name, fences, extensions }`. `module` is the manifest name,
`version` is the installed package version or `null` when unknown, `name` is the
renderer contribution key, and `fences`/`extensions` are arrays of declared
strings. Only active configured modules contribute. An empty array means the
server knows there are no declarations; absence means its CLI cannot report
metadata or the lookup failed. Clients retain code fallback in either case.

The payload contains no client/static entry specifier and authorizes no imports.
The build registers trusted client packs. Missing packs retain source with a
“Renderer not bundled.” note. Explicit development mode warns once per root and
known differing version pair; unknown versions do not imply a mismatch.

## Session safety history read (additive, #3604)

Owner review is separately available through the two-phase
[individual review API](../http-api.md#individual-safety-review)
(#3603). Both supported method/path entries belong to the classified HTTP
inventory, with matching mounted-handler and lifetime coverage. Its exact
request, immutable historical receipt, fresh aggregate, password-mode human
authority, strict Origin/JSON checks, refusal envelopes and
lifetime/capacity bounds are authoritative there. Reviewing A never resolves
later B/C, unknown coverage or failed recording. Prepared authority is checked
on the acquired FULL transaction and final response boundary, including replay.
Migration 084 retains finalized-only SQLite enforcement while accepting the
aggregate's durable canonical/adopted membership; no old decision is rewritten.
This additive transport implements the already approved individual-verdict
semantics and ships with a minor changeset under the pre-1.0 ruling.

`GET /api/sessions/:id/safety` adds the bounded authenticated `SafetyPage`
read defined by [the HTTP specification](../http-api.md#session-safety-sidecars)
and [wire sidecars](wire.md#session-safety-history-additive-3604). Queries never
execute a review or policy change. Principal, generation, retirement and cursor
expiry are rechecked at delivery after settlement. `snapshotComplete` and
detector completeness are separate; neither omitted details nor a review receipt
replace the aggregate. Route absence and refused reads are explicitly
unavailable. Existing history visibility and mutation authority remain intact.


### Selectable dictation providers (additive, #3707)

The [dictation routes](../http-api.md#selectable-dictation-providers) add
read-only `/api/voice/providers` discovery and revisioned
`/api/voice/dictation/settings` GET/PUT. The registered set is fixed; a removed
saved choice blocks dictation. Only human owners/ambient accounts write settings.
`POST /api/voice/session` accepts optional `{ providerId, smart }`; an explicit
id is exact or 409 `speech_provider_unavailable`, never a fallback. Bodyless
clients and `/voice/capabilities` retain their shapes. Discovery never mints.
Saved-audio PUT binds `Speech-Provider` before claim/body consumption; absent
headers preserve effective-provider resolution. Retry provider changes return
409 `transcription_provider_mismatch` with the receipt. Settings revisions,
error codes, response schemas and operation binding are supported HTTP promises.


### Live-conversation service default (additive, #3616)

[`GET`/`PUT /api/settings/voice`](../http-api.md#live-conversation-service-default)
read and save the brain-wide default live-conversation service as the top-level
`VoiceLiveSettings` pair `{ defaultProvider: string | null, revision: number }`,
beside the persona selection (#3617) with its own revision.
Reading needs a human session (owner or ambient); writing has its own
owner-only guard: the owner's password or passkey session, or the ambient human,
and 403 with an empty body for anyone else, before the body is read. Unknown
ids are 400 `LIVE_PROVIDER_UNKNOWN`, malformed bodies 400 `LIVE_SETTINGS_INVALID`,
stale revisions 409 `LIVE_SETTINGS_CHANGED` with `current`. A save sends
[`live_settings`](wire.md#live-service-selection-additive-3616) and applies from
the next explicit Start. It is independent of `/api/models/default` and
`/api/voice/dictation/settings`. The route shapes, error codes and the guard are
supported HTTP promises.

### Live-conversation personas (additive, 0.45.0, #3617)

The [persona routes](../http-api.md#live-conversation-personas) read and write
`_voice/personas/<id>.md` and the selection. Every route requires a human
session of the brain (an owner, or an ambient-auth account); delegated agent,
worker and system principals receive `403` with an empty body. Writes replace
the file atomically inside the brain and never follow a link out of
`_voice/personas`. Revisions are the sha-256 of the file bytes; `PUT` and
`DELETE` must name the current one or receive `409 PERSONA_CHANGED`. Error
bodies are fixed codes, never persona text. Route paths, request and response
schemas, revision semantics and error codes are supported HTTP promises.

### Checkpoint cleanup diagnostics (additive, #3815)

Authenticated `GET /api/status` adds `journalCleanup`: `retained` contains
`pending`, `failed` and `retainedBytes` for this process's superseded checkpoints;
`lastFailure` is null or the durable historical failure with `kind`,
`checkpointId`, `at` (epoch milliseconds), `scope`, `errorClass`, `cause` and
`retrying: true` at the time it was recorded. The historical cause survives
recovery and restart; it does not assert a currently blocked turn. Current
charges remain separate in `retained`. No field changes public `/health`.

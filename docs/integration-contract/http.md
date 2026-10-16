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

### User history restoration (additive, #1653)

The four authenticated human `/revert` operations are specified in
[the HTTP inventory](../http-api.md#retained-turn-journal). `createBrainApi`
adds `turnRevertPlan`, `turnRevertLatest`, `turnRevert`, and `turnRevertReceipt`.
Only `turnRevert` POSTs; receipt readback never repeats execution. The caller's
operation ID is bound to principal/session/source/selection. Stale raw state
conflicts, unavailable detail, unknown outcomes and partial work remain explicit;
voice, agent and autonomous execution do not gain a history action. This is
additive in 0.42.0; no existing read or CLI/MCP shape changes.

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
Clients must tolerate either mode being absent.

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

Journal details may add `tainted: true` and `taintSourceEventId` to a steering
change only when an existing taint record preceded the observation in that
session or turn. The ID is retained with the change; replay never derives it
from later events. A missing flag is not a claim that untrusted-input coverage
is complete. Policy changes remain class `policy`, with user attribution, and
are excluded from `steeringFiles`.

The governance event API accepts/returns `steering_change`, version 1, with
`path`, journal `sequence`, nullable `beforeHash`/`afterHash`, nullable
`taintSourceEventId`, and `overlappingTurnIds`. It records an observation, not
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

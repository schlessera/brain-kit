# Integration contract — http

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


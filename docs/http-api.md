# Supported HTTP API

This is the `@schlessera/brain-ui-server` HTTP specification under the
[integration contract](integration-contract.md) and the
[HTTP selection decision](decisions/http-api-boundary.md). **Supported** means
an independent client or integration may rely on the specified method, path,
inputs, responses and behavior. **Internal** means a transport used by the
paired UI implementation; its raw path and payload are excluded from the HTTP
compatibility guarantee. Authentication requirements are a separate property.
A public liveness probe can be supported; an authenticated settings route can
be internal.

The inventory includes the additive Queue intake, poke, scheduled-task, session-draft, session-recovery interactive HTML preview, saved-audio transcription and human-started hygiene-review routes mounted by `createApp`: 119 unique declared
method/path pairs, plus the conditional SPA fallback. It describes the current
implementation, including limitations, rather than a proposed redesign.
Unknown response fields must be tolerated. There is no HTTP API revision
parameter, universal JSON envelope, or HTTP `schema_version` field.

## Inventory and selection

Each row is one declared method/path. `S` means supported and specified below;
`I` means internal. The reason column names the current consumer and any
inherited promise. New selections of independent retrieval/capture endpoints
are deliberate here; existing promises are retained even where runtime or
client code has a gap. Source owners are listed after the table.

| Method | Path | Class | Purpose | Consumers, existing promise and reason |
| --- | --- | --- | --- | --- |
| GET | `/api/activity/digest` | I | Read digest and record app visit | React Activity presentation state; retained public client functions do not promise independent raw transport. |
| POST | `/api/activity/digest/dismiss` | I | Record digest dismissal | React Activity presentation state; retained public client functions do not promise independent raw transport. |
| POST | `/api/activity/digest/generate` | I | Generate digest manually | React Activity presentation state; retained public client functions do not promise independent raw transport. |
| GET | `/api/activity/inbox` | I | List presentation intents | React Activity presentation state; retained public client functions do not promise independent raw transport. |
| POST | `/api/activity/inbox/:id/ack` | I | Acknowledge one intent | React Activity presentation state; retained public client functions do not promise independent raw transport. |
| POST | `/api/activity/inbox/ack-all` | I | Acknowledge all intents | React Activity presentation state; retained public client functions do not promise independent raw transport. |
| GET | `/api/activity/rollups` | S | Aggregate runs by day/job/session | Independent monitoring; preserve activity README, SDK wire shapes and detailed stats contract. |
| GET | `/api/activity/runs` | S | List live roots and paginated history | Independent monitoring; preserve activity README, SDK wire shapes and detailed stats contract. |
| GET | `/api/activity/runs/:runId` | S | Read retained run detail or pruned rollup | Independent monitoring; preserve activity README, SDK wire shapes and detailed stats contract. |
| GET | `/api/activity/stats` | S | Read labeled runtime statistics and coverage | Independent monitoring; preserve activity README, SDK wire shapes and detailed stats contract. |
| POST | `/api/auth/login` | S | Verify password and issue owner cookie | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/auth/logout` | S | Revoke cookie session(s) and clear cookie | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| GET | `/api/auth/methods` | S | Report available login methods | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| DELETE | `/api/auth/passkey/:id` | S | Delete credential and revoke its sessions | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| PUT | `/api/auth/passkey/:id` | S | Rename a credential | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| GET | `/api/auth/passkey/list` | S | List credential summaries across RPs | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/auth/passkey/login-options` | S | Create authentication challenge/options | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/auth/passkey/login-verify` | S | Verify assertion and issue owner cookie | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/auth/passkey/register-options` | S | Create registration challenge/options | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/auth/passkey/register-verify` | S | Verify and store a passkey | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| GET | `/api/auth/principals` | S | List live principals | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/auth/principals` | S | Mint a delegated agent credential | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| DELETE | `/api/auth/principals/:id` | S | Revoke a principal and its descendants | Independent client access; preserve principal README and SDK PasskeySummary promises. |
| POST | `/api/brain/add` | S | Capture content and report indexing outcome | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| GET | `/api/brain/briefing` | S | Read CLI briefing text | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| POST | `/api/brain/index` | S | Retry incremental indexing without recapture | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| GET | `/api/brain/list` | S | List filtered document summaries | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| GET | `/api/brain/search` | S | Search corpus and return degraded-mode warnings | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| GET | `/api/brain/stats` | S | Read current corpus statistics | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| GET | `/api/brain/stats/history` | S | Read recorded corpus-stat series | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| POST | `/api/brain/sync` | S | Stream a serialized repository sync | Independent corpus clients; preserve CLI pass-through, capture recovery and sync lifetime promises. |
| GET | `/api/drafts` | S | List live session drafts | Paired composer and independent clients (#979, D52); preserve revisions, receipts, tombstones, limits and the no-execution boundary. |
| GET | `/api/drafts/:draftId` | S | Read a draft's text and images | Paired composer and independent clients (#979, D52); preserve revisions, receipts, tombstones, limits and the no-execution boundary. |
| PUT | `/api/drafts/:draftId` | S | Create or replace a draft revision with If-Match | Paired composer and independent clients (#979, D52); preserve revisions, receipts, tombstones, limits and the no-execution boundary. |
| DELETE | `/api/drafts/:draftId` | S | Delete a draft, leaving a tombstone | Paired composer and independent clients (#979, D52); preserve revisions, receipts, tombstones, limits and the no-execution boundary. |
| POST | `/api/drafts/:draftId/attachments` | S | Store one draft image | Paired composer and independent clients (#979, D52); preserve revisions, receipts, tombstones, limits and the no-execution boundary. |
| POST | `/api/drafts/:draftId/bind` | S | Bind a draft to the session its accepted first message started | Paired composer and independent clients (#979, D52); preserve revisions, receipts, tombstones, limits and the no-execution boundary. |
| GET | `/api/files/content` | S | Read content metadata/text or raw bytes | Independent content clients and SDK service-worker policy; raw API media remains network-only. |
| GET | `/api/files/html` | I | Serve an HTML file for the sandboxed, script-running preview | React file viewer iframe and "Open in new tab" link (#1084); browser-rendered UI transport. Its isolation headers are specified below. |
| GET | `/api/files/resolve` | I | Resolve ancestor navigation and existence | React file browser; view/navigation helpers are paired UI transport. |
| GET | `/api/files/tree` | I | List browsable directory entries | React file browser; view/navigation helpers are paired UI transport. |
| GET | `/api/files/wikilinks` | I | Read or refresh cached slug-to-path map | React file browser; view/navigation helpers are paired UI transport. |
| GET | `/api/geo/coastline` | S | Read attributed map geometry for a bounding box | Independent map clients; preserve show_block map HTTP promise and graceful geometry degradation. |
| GET | `/api/graph/clusters` | I | Read clustered presentation graph | React graph views; no independent HTTP guarantee. Existing CLI/MCP and direct-SQL promises remain separately binding. |
| GET | `/api/graph/discovery` | I | Read root-based discovery subgraph | React graph views; no independent HTTP guarantee. Existing CLI/MCP and direct-SQL promises remain separately binding. |
| GET | `/api/graph/maintenance` | I | Read graph maintenance findings | React graph views; no independent HTTP guarantee. Existing CLI/MCP and direct-SQL promises remain separately binding. |
| GET | `/api/graph/meta` | I | Read graph availability and provenance | React graph views; no independent HTTP guarantee. Existing CLI/MCP and direct-SQL promises remain separately binding. |
| GET | `/api/graph/neighborhood` | I | Read bounded local presentation subgraph | React graph views; no independent HTTP guarantee. Existing CLI/MCP and direct-SQL promises remain separately binding. |
| GET | `/api/health` | S | Probe SQLite liveness without identity | Health probes and React connectivity; preserve public minimal response without identity. |
| GET | `/api/hygiene/review` | S | Read the durable review strip and pending Action | Independent clients and hygiene review controls; preserve SDK review/read shapes. |
| POST | `/api/hygiene/review` | S | Start, pause, resume or refresh human review | Human principal authority and one pending Action; preserve SDK command/read shapes. |
| POST | `/api/hygiene/review/preview` | S | Bind typed handler input to a current CLI preview | Human principal authority, stored option and version; preserve SDK preview shapes. |
| POST | `/api/internal/inbox/poke` | S | Recover and trigger the Queue lifecycle | Generated-host cron caller; independent boot bearer token plus actual loopback socket. See the [runtime specification](inbox-runtime.md). |
| GET | `/api/models` | S | Read full catalog including hidden profiles | Independent chat clients; preserve model README and SDK ModelCatalogResponse/hidden-set promises. |
| PUT | `/api/models/billing` | I | Replace billing classification overrides | React settings: incidental configuration transport; no independent HTTP promise. Supported hidden-set override listed separately. |
| PUT | `/api/models/custom` | I | Replace custom OpenRouter model IDs | React settings: incidental configuration transport; no independent HTTP promise. Supported hidden-set override listed separately. |
| PUT | `/api/models/default` | I | Replace preferred model selection | React settings: incidental configuration transport; no independent HTTP promise. Supported hidden-set override listed separately. |
| PUT | `/api/models/hidden` | S | Replace hidden-profile set | README and SDK explicitly name this route; hidden profiles remain usable by pinned sessions. |
| GET | `/api/models/pricing` | I | Read pricing-table freshness | React settings: incidental configuration transport; no independent HTTP promise. Supported hidden-set override listed separately. |
| POST | `/api/models/refresh` | S | Force model discovery refresh | Independent chat clients; preserve model README and SDK ModelCatalogResponse/hidden-set promises. |
| PUT | `/api/models/thinking` | I | Replace reasoning-effort overrides | React settings: incidental configuration transport; no independent HTTP promise. Supported hidden-set override listed separately. |
| GET | `/api/modules` | I | List configured modules, including unavailable neighbors | React module settings; CLI module/settings contracts remain binding. |
| GET | `/api/modules/:name/settings` | I | Read schema, values, provenance and revision | React module settings; CLI module/settings contracts remain binding. |
| PUT | `/api/modules/:name/settings` | I | Validate and commit JSON overrides with If-Match | React module settings; CLI module/settings contracts remain binding. |
| POST | `/api/modules/:name/settings/preview` | I | Validate a draft and compute module notes without writing | React module settings; CLI module/settings contracts remain binding. |
| POST | `/api/modules/:name/migration/preview` | I | Preview a module-owned content migration | React module settings; CLI module/settings contracts remain binding. |
| POST | `/api/modules/:name/migration` | I | Apply the reviewed migration atomically | React module settings; CLI module/settings contracts remain binding. |
| POST | `/api/modules/:name/state` | I | Activate or park a configured workflow | React module settings; CLI module/settings contracts remain binding. |
| POST | `/api/modules/:name/actions/:id` | I | Run a declared module CLI action using saved settings | React module settings; CLI module/settings contracts remain binding. |
| POST | `/api/pi-auth/login` | I | Start configured vendor OAuth flow | Pi settings UI; configured-vendor-specific administrative transport, not brain session authentication. |
| DELETE | `/api/pi-auth/login/:id` | I | Cancel vendor login flow | Pi settings UI; configured-vendor-specific administrative transport, not brain session authentication. |
| GET | `/api/pi-auth/login/:id` | I | Poll vendor login flow | Pi settings UI; configured-vendor-specific administrative transport, not brain session authentication. |
| POST | `/api/pi-auth/logout` | I | Remove configured vendor credential | Pi settings UI; configured-vendor-specific administrative transport, not brain session authentication. |
| GET | `/api/pi-auth/providers` | I | Read configured vendor credential status | Pi settings UI; configured-vendor-specific administrative transport, not brain session authentication. |
| GET | `/api/providers` | S | Read visible profiles and backend capabilities | Independent chat clients; preserve model README and SDK ModelCatalogResponse/hidden-set promises. |
| GET | `/api/push/public-key` | S | Read VAPID application-server public key | SDK push renewal and custom PWA clients; preserve principal ownership and private-key exclusion. |
| POST | `/api/push/subscribe` | S | Bind/renew a browser subscription | SDK push renewal and custom PWA clients; preserve principal ownership and private-key exclusion. |
| GET | `/api/push/subscriptions` | S | Inspect caller-owned subscription summaries | SDK push renewal and custom PWA clients; preserve principal ownership and private-key exclusion. |
| POST | `/api/push/zone` | I | Refresh a client context's reported notification zone | React lifecycle refresh for client-local Action notice timing; registration carries the device zone through the supported subscribe input. |
| POST | `/api/push/unsubscribe` | S | Remove caller-owned subscription | SDK push renewal and custom PWA clients; preserve principal ownership and private-key exclusion. |
| POST | `/api/render` | S | Render supplied document to PNG or PDF | Independent share/render clients; preserve RenderRequest, renderer seam and 501 without renderer. |
| GET | `/api/sessions` | S | List backend sessions with partial availability | Independent session clients; preserve SDK ChatSession/history shapes and partial-backend availability behavior. |
| GET | `/api/sessions/:id` | S | Read owning-backend session transcript | Independent session clients; preserve SDK ChatSession/history shapes and partial-backend availability behavior. |
| GET | `/api/sessions/:id/recovery` | S | Read a session's latest accepted work and pending interactions | Trackers and independent session clients (#964, D52); preserve the revision ordering, Activity terminal proof, honest unknown and the no-execution boundary. |
| POST | `/api/queue` | S | Queue authenticated CLI intake without filing content | CLI and independent intake clients; preserve explicit key, provenance and queue receipt. |
| GET | `/api/schedules` | S | List stored scheduled tasks, cancelled ones included | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| POST | `/api/schedules` | S | Publish an approved schedule proposal | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| POST | `/api/schedules/:id/cancel` | S | Cancel future and unstarted work of one task | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| POST | `/api/schedules/:id/reconcile` | S | Reopen a task paused by a restore or an unknown effect | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| GET | `/api/schedules/due` | S | Read due candidates without claiming them | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| POST | `/api/schedules/proposals` | S | Store a schedule proposal for review | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| POST | `/api/schedules/proposals/:id/approve` | S | Record a verified operator approval | CLI and independent schedule clients; preserve keys, receipts, operator approval and the no-execution boundary. |
| POST | `/api/share` | S | Stage and queue confirmed untrusted share payload | SDK share-target and custom PWA shells; preserve ShareIntakeResult and body-unread fallback. |
| GET | `/api/skills` | I | List built-in and custom skills | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| POST | `/api/skills` | I | Create custom skill and sync agent links | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| DELETE | `/api/skills/:name` | I | Delete custom skill and sync | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| GET | `/api/skills/:name` | I | Read skill detail and files | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| PUT | `/api/skills/:name` | I | Replace custom skill content and sync | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| POST | `/api/skills/:name/enabled` | I | Change enabled state and sync | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| POST | `/api/skills/install/github` | I | Install skills from GitHub and sync | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| POST | `/api/skills/install/zip` | I | Install uploaded skill archive and sync | React skill settings; integration directories and UI editor transport are internal. CLI/module/skill formats retain their own guarantees. |
| GET | `/api/status` | S | Read protected operational/runtime status | Independent monitoring and React status; preserve release/runtime/subscription promises. |
| POST | `/api/track-upload` | I | Validate and stage composer track originals | Paired React composer transport; the published file-reference wire/block behavior remains its own contract. |
| GET | `/api/tracks` | I | Resolve canonical imported-track evidence | Paired React track-block/export transport; no independent retrieval API selected. |
| GET | `/api/tool-permissions` | I | List remembered always-allow grants | React approval settings; paired administrative transport. Permission behavior remains governed by its own contract. |
| DELETE | `/api/tool-permissions/:tool` | I | Revoke one remembered grant | React approval settings; paired administrative transport. Permission behavior remains governed by its own contract. |
| GET | `/api/voice/capabilities` | S | Read active-provider capabilities without minting a credential | Saved-audio discovery and independent clients; additive #1021 contract. |
| GET | `/api/voice/recordings/:recordingId/transcription` | S | Read an account-owned durable transcription receipt | Saved-audio status recovery; never dispatches a provider. |
| PUT | `/api/voice/recordings/:recordingId/transcription` | S | Explicitly upload or retry saved audio | Account ownership, verified hash, bounded body and durable claim protect idempotency. |
| DELETE | `/api/voice/recordings/:recordingId/transcription` | S | Erase transcript text and retain a tombstone | Explicit acceptance/discard; delayed uploads cannot reopen consumed ids. |
| GET | `/api/voice/keyterms` | S | Read or rebuild domain keyterms | Independent speech clients; preserve SDK VoiceSessionResponse, deprecated token transition and keyterm shapes. |
| GET | `/api/voice/overrides` | S | Read pronunciation replacements | Independent speech clients; preserve SDK VoiceSessionResponse, deprecated token transition and keyterm shapes. |
| POST | `/api/voice/session` | S | Mint active-provider dictation session | Independent speech clients; preserve SDK VoiceSessionResponse, deprecated token transition and keyterm shapes. |
| POST | `/api/voice/token` | S | Mint deprecated Deepgram token response | Independent speech clients; preserve SDK VoiceSessionResponse, deprecated token transition and keyterm shapes. |
| GET | `/api/vpn-check` | I | Probe authenticated reachability and name the account partition | React ConnectionGate probe; mode-independent {vpn:true} is UI transport, not a VPN assertion for integrations. Additive `accountKey` names the device-local account partition ([contract](integration-contract.md#account-partition-key-additive-1014)). |
| GET | `/api/web-search` | I | Read backend web-search settings | Pi settings UI; backend-specific config editor rather than a query API. |
| PUT | `/api/web-search` | I | Update provider routing/keys and invalidate cache | Pi settings UI; backend-specific config editor rather than a query API. |
| POST | `/share-target` | S | Explain missing service worker without reading body | SDK share-target and custom PWA shells; preserve ShareIntakeResult and body-unread fallback. |
| GET | `/ws` | S | Authenticate and admit WebSocket upgrade | SDK BrainUiClient; supported HTTP upgrade boundary, followed by the existing wire contract. |
| GET | `/*` (conditional) | I | Serve configured SPA deep links | Custom shell with `staticRoot`; deployment asset transport, not an independent JSON API. |

The route factories live under [ui-server routes](../packages/ui-server/src/routes/).
Authentication factories live in [auth.ts](../packages/ui-server/src/middleware/auth.ts),
[passkeys.ts](../packages/ui-server/src/middleware/passkeys.ts) and
[principals.ts](../packages/ui-server/src/middleware/principals.ts).
[app.ts](../packages/ui-server/src/app.ts) owns prefixing and middleware order.
All 119 declared endpoints are mounted regardless of backend, renderer or
speech-provider availability: unavailable capabilities return the responses
below rather than removing their handlers. Only static serving is conditional.

### Implicit methods and wildcard handlers

Hono dispatches **HEAD through GET**, preserving response status/headers and
removing the body. This applies to each GET row and the conditional fallback;
it does not create another payload contract. Middleware still sees the original
HEAD method, so the non-GET origin policy also applies. Raw-file HEAD ignores
Range. WebSocket upgrade requires an actual GET.

`ALL /api/*` installs origin policy, configured CORS and authentication.
With nonempty `ALLOWED_ORIGINS`, CORS middleware answers allowed **OPTIONS
/api/** preflights with 204 before authentication, advertising GET, POST, PUT,
DELETE, the `Content-Type`, `If-Match` and `Idempotency-Key` and `Content-SHA256` headers, and credentials. Origin policy runs first; a rejected
origin gets 403. Without that configured middleware there is no universal
OPTIONS endpoint: authentication/routing decide the response. These are
transport behaviors, not independently supported OPTIONS resource operations.

`ALL /api/internal/inbox/poke` refuses methods other than its supported POST
with JSON HTTP 405 and `Allow: POST`, before general authentication. The
supported POST retains origin policy and its independent token/socket checks.

`ALL /api/auth/passkey/*` and `ALL /api/auth/principals/*` add mode and owner
checks to the management families after authentication. Public login ceremonies
are mounted earlier. `ALL /*` supplies logging and security headers; with
`staticRoot`, another `ALL /*` serves files and then normalized `GET /*` (declared as `"*"`) serves index.html
for unresolved deep links. Missing index.html yields 404. That fallback can
also answer an unmatched authenticated GET API path with HTML; clients must
check status and content type. Without static serving, unmatched paths use
Hono's 404. Wildcard middleware is not an additional independent resource API.

### Supported SDK and React dependencies

The SDK's published `/push-handlers` entry defaults renewal to
`POST /api/push/subscribe`; the whole supported subscription lifecycle is
specified below. Its `/share-target` entry defaults interception to
`POST /share-target`; the fallback and confirmed upload remain supported.
`/sw-policy` treats all `/api` traffic, including raw content loaded as images,
as network-only. It does not turn every matching URL into a stable HTTP API.
`BrainUiClient` accepts a caller-supplied socket URL; `/ws` admission and the
wire protocol are supported. SDK HTTP payload types named below retain their
public shape promises.

The React package exports `createBrainApi` and exposes `root.api` as an
embedding service. Those **public function signatures and behavior** must
remain compatible under the public-export policy; this inventory does not
reclassify ordinary exports or signature-reachable SDK types as internal.
Some functions implement UI settings/digest workflows through internal HTTP
rows. Changing such transport requires changing the paired client together
while preserving the public function's supported behavior, or obtaining the
required ruling for a public API break. Internal here excludes independent
raw HTTP consumption, not working published UI functionality. The inventory
is an input to the public-export audit (#534), not a substitute for it.

The published `health()` helper resolves to `{ status: string; uptime: number;
timestamp: string }`. Its former `version: string` declaration is removed by
the approved breaking correction in #693; the public route never supplied
version. Migrate former version reads to authenticated `status()` when
software identity is needed. `health()` does not fabricate a value or fetch
protected status automatically.

`brainSync()` retains `{ success: boolean; message: string }` by consuming the
actual SSE response through its configured request transport and current base
getter. Only a complete valid terminal `done` resolves, mapping `success` and
`text`; terminal false is a completed unsuccessful result. The parser handles
UTF-8 byte boundaries, LF/CRLF/CR lines, multiline data and keepalive comments.
Missing/malformed terminal data, premature EOF and transport failure reject as
incomplete, without establishing job cancellation. Non-2xx responses preserve
`ApiRequestError`; the helper never implicitly retries the POST or resumes the
stream. Server admission/reservation/draining semantics below still apply.

## Common request and response rules

Use the method shown. Paths are origin-relative. Protected rows use the app's
configured auth mode:

- `password`: a signed `brain_ui_session` cookie naming a live, unexpired,
  unrevoked owner or delegated agent principal; missing/invalid credentials
  yield 401 `{ error: "Authentication required", authRequired: true }`.
- `proxy`: a validated upstream identity header, configured and trusted by the
  operator; missing identity yields the same 401. Do not treat a caller's
  self-declared header as proof outside that trusted boundary.
- `tailscale`: the configured trusted client-IP policy; denial is 403
  `{ error: "VPN access required" }`.
- `none`: an ambient principal with no credential requirement, for an app
  deliberately configured without application authentication.

These modes share the protected route set. Ordinary protected reads and writes
are not owner-only or per-principal content partitions unless explicitly stated
below. An agent credential therefore has access to the authenticated corpus and
execution APIs; it is not a read-only credential. Passkey and delegated-principal
management additionally require an owner in password mode: other modes return
400, an authenticated non-owner returns 403 `{ error: "Owner access required" }`.

Origin policy precedes authentication for every **non-GET /api/** request.
It accepts same-origin fetch metadata, matching Origin or a configured
allowlist; opaque `Origin: null` is rejected. Headerless non-browser requests
are accepted by origin policy and still require authentication. Proxy trust
controls external-origin resolution. WebAuthn's ceremony allowlist is confined
to `/api/auth/passkey/`; it does not authorize other API writes. Rejection is
403 `{ error: "cross_origin_rejected" }`. `/share-target` is deliberately
outside this policy; `/ws` has its own admission checks.

A row marked **JSON** requires `Content-Type: application/json`, with standard
parameters permitted; other media types yield 415
`{ error: "unsupported_media_type" }`. Rows marked **body ignored** do not
parse or validate a supplied body. Parsed JSON is limited to 262,144 bytes,
except rendering's 5,000,000-byte limit; declared or streamed excess yields
413 `{ error: "Request body too large" }`. Index recovery requires the media
type but does not read a JSON body. No universal validation layer exists:
route-specific checks below are what currently run. Unspecified query keys
and extra object fields are generally ignored, not rejected.

Unless specified otherwise, successful JSON responses are 200 and use the
object/type described below. Timestamps are milliseconds since epoch except
explicit ISO strings. Route-local failures generally return `{ error: string }`;
wording from a subprocess/provider is diagnostic and not a machine error enum.
Uncaught failures, including some malformed JSON values, can return Hono's
500 plain text `Internal Server Error`; clients cannot assume every error is
JSON. The validation gaps below are observations, not an invitation to depend
on accepting malformed inputs. No `Retry-After` guarantee is made.

Ordinary HTTP replies carry `X-Frame-Options: DENY` and a CSP with
`frame-ancestors 'none'`; route-specific CSP is retained. Genuine WebSocket
upgrade attempts bypass those response-header writes. CORS is opt-in and
credentials are allowed only for configured origins. Caching is specified on raw content, rendering and geometry below; no
universal Cache-Control header is promised.

## Liveness and operational status

**GET /api/health** is public, accepts no inputs, and performs a real read of
the app's SQLite schema. Healthy: 200
`{ status: "healthy", uptime: number, timestamp: string }`, where uptime is
milliseconds since the route module initialized and timestamp is ISO UTC.
An unreadable database yields 503 `{ status: "unhealthy" }`, without detail.
It never exposes release, source commit, runtime, credentials or session state;
healthy does not certify upstream model or brain CLI availability.

**GET /api/status** is protected, accepts no inputs, and returns
`{ healthy: true, uptime, version, software, cronJobs, activeSession, metrics,
runtime?, subscription? }`. `version` is the configured source commit (default
`"dev"`), not a release; `software` is `{ release, sourceCommit }`. `cronJobs`
contains `{ name, lastRunAt, lastStatus, lastDurationMs, lastError }`, nullable
when a job has not run; it includes recorded jobs and configured in-process
jobs. `activeSession` means any active turn, not simply an open socket.
`metrics` is the recorded metric-series snapshot, or `[]` without a reader;
series have name, kind (counter/updowncounter/histogram/gauge), numeric
value and scalar attributes; histogram value is the observation count.
Operational reads can fail with the common 500.

`runtime` reports observed chat runtime and optional sync state, using the
[runtime identity declarations](../packages/ui-server/src/activity/runtime-status.ts)
and the [sync reporting contract](integration-contract.md#activity-stream-rev-3-additive).
`subscription` contains `tokenSet`, nullable ISO `mintedAt`, `expiresAt`,
`lastProvenAt`, `provenBy: "turn" | "model_discovery" | null` and nullable
`lastAuthFailure` (`errorClass`, ISO `at`, `action`, `source`, optional
`runId`, `message`, `status`). It never returns the token. Optional monitoring
fields reflect injected capabilities; they are not a liveness requirement.

## Login, passkeys and delegated credentials

These auth routes are supported for independent clients as well as the login
UI. Public ceremonies precede the general guard; management does not.

**POST /api/auth/login — public, JSON.** Body `{ password: string }`; missing,
empty or non-string passwords become invalid credentials. Password mode only:
other modes return 400; a passkey for the current RP disables password login
unless recovery is configured, returning 403. Malformed JSON returns 400,
invalid credentials 401, rate/capacity limits 429, and principal capacity 503.
Malformed JSON and non-object JSON (null, arrays or scalars) return 400
`{ error: "Invalid request body" }`; object password defaults remain unchanged.
The limiter currently counts five failed passwords per IP and 100 globally
per minute, with bounded concurrent verification. Success returns `{ ok: true }`
and a Secure, HttpOnly, SameSite=Strict signed session cookie at `/`, with a
30-day owner principal. Verification failure does not reveal hash validity.
The cookie is an opaque capability; no token-format parsing is supported.

**POST /api/auth/logout — body ignored.** In password mode this public-before-
guard handler requires a valid cookie itself (401 otherwise). An owner's
logout revokes all cookie-bearing owner and agent sessions; an agent's logout
revokes only that agent. Live connections and queued work are invalidated.
In other modes it clears the cookie without credential revocation. All successful
calls return `{ ok: true }` and delete the session cookie. It does not sign a
caller out of the upstream proxy or VPN.

**GET /api/auth/methods — public.** No inputs; returns
`{ password: boolean, passkey: boolean }`, with `Cache-Control: no-store`.
Both are false outside password mode. In password mode the current RP's
credential presence and password-recovery setting decide the flags.

Passkey ceremonies require an allowed **Origin** even for a non-browser
client. RP ID comes from the configured override or Origin hostname; ceremony
origin must match the app, general/scoped allowlist or explicit loopback opt-in.
Disallowed/missing ceremony origin returns 400 `{ error: "Origin not allowed" }`.
All passkey operations return 400 `{ error: "Passkey login is not enabled" }`
outside password mode, after the common guard on management requests.
Challenges are single-use and expire after two minutes; retry requires new
options. The bounded, process-local challenge store can evict old challenges.

| Supported operation | Auth/body and inputs | Success | Additional errors and behavior |
| --- | --- | --- | --- |
| POST `/api/auth/passkey/login-options` | Public; body ignored; Origin required | WebAuthn JSON request options: challenge, RP ID, empty allowCredentials, userVerification required | 429 options-rate limit (currently 10/IP/minute); creates an authentication challenge. |
| POST `/api/auth/passkey/login-verify` | Public; JSON `AuthenticationResponseJSON` from the browser ceremony | `{ ok: true }`, with the same owner session cookie as password login | 400 malformed JSON; 401 unknown/foreign-RP credential, expired/replayed challenge or failed verification; 429 failed-verify/in-flight limit; 503 session capacity. Verifies challenge, origin, RP and credential, updates counter/last-use; a failed attempt consumes its challenge. |
| POST `/api/auth/passkey/register-options` | Password owner; body ignored; Origin required | WebAuthn JSON creation options | Discoverable credential and user verification required; no attestation; excludes existing RP credentials; ES256/RS256 algorithms. Creates a registration challenge. |
| POST `/api/auth/passkey/register-verify` | Password owner; JSON `{ response: RegistrationResponseJSON, label?: string }`; Origin required | `{ ok: true, credential: PasskeySummary \| null }` | 400 missing response, malformed/non-object JSON, expired/replayed challenge, duplicate or failed registration. Label is trimmed and sliced to 64 characters; absent/non-string becomes empty. Stores only verified credential data. |
| GET `/api/auth/passkey/list` | Password owner; no inputs | `{ credentials: PasskeySummary[] }` | All RPs, newest registration first; no credential public-key bytes. |
| PUT `/api/auth/passkey/:id` | Password owner; JSON `{ label?: string }`; credential ID in path | `{ ok: true }` | 400 malformed/non-object JSON; 404 unknown credential. Same label normalization; omitted label clears it. |
| DELETE `/api/auth/passkey/:id` | Password owner; body ignored; credential ID in path | `{ ok: true }` | 404 unknown credential. Revokes sessions derived from that credential and their delegated agents; deleting the last RP credential re-enables password login unless configured otherwise. |

`PasskeySummary` is the SDK shape `{ id, label, rpId, createdAt, lastUsedAt,
backedUp, deviceType, transports, aaguid }`; lastUsedAt, deviceType, transports and aaguid are nullable; backedUp is boolean.
Credential IDs and ceremony data are opaque WebAuthn values, not paths.

**GET /api/auth/principals — password owner.** Returns
`{ principals: [{ id, kind, auth_method, label, created_at, expires_at,
last_seen_at, is_own }] }` for live principals. `is_own` identifies the calling
principal; dates use epoch milliseconds and last_seen_at may be null.
Credential cookie values are never included.

**POST /api/auth/principals — password owner, JSON.** Body
`{ label: string, ttlDays?: number }`. Label strips control characters, trims
and slices to 64 characters; empty is 400. TTL defaults to seven days and must
be an integer 1–30; invalid JSON, a non-object body, or invalid TTL is 400.
Success returns `{ id, label, expiresAt, cookie }` and `Cache-Control: no-store`;
the cookie is the signed value for `brain_ui_session`, returned once rather
than installed as the owner's session cookie. Send it in a Cookie header.
Unusable creator is 403; exhausted principal capacity is 503. The new agent
has no owner-management privilege.

**DELETE /api/auth/principals/:id — password owner, body ignored.** Revokes
the principal and its delegation descendants, invalidates associated live
runtime state, and returns `{ ok: true }`. Unknown/already revoked target is
404. An owner can revoke their own credential; later requests then fail auth.

## Corpus queries, capture and sync

All are protected. HTTP query values are strings; the brain CLI supplies its
configuration defaults, taxonomy validation and degraded search behavior.
The route does not create a second independent taxonomy or ranking policy.

| Supported operation | Inputs/defaults/validation | Success | Errors and behavior |
| --- | --- | --- | --- |
| GET `/api/brain/search` | Required nonempty `q`; optional `type`, `tag`, `mode`, `limit` (Number conversion). Mode is fts/vector/hybrid when valid; default mode hybrid, limit 20; archived documents excluded. | `{ results: BrainSearchResult[], warnings: string[] }` | 400 missing q; 504 search deadline (15 seconds by default); other CLI/parsing failures 500 `{ error }`. Request abort cancels the read-only child. Result fields include path, title, type, relevance, score, snippet and comma-separated tags (null when none). Old bare-array CLI responses become results with empty warnings. |
| GET `/api/brain/briefing` | No inputs | `{ content: string }` | CLI briefing stdout, including its formatting; failed command is 500 `{ error }`. Keyless: `brain briefing` gathers facts without a model. The React Daily briefing panel reads this route; no route runs a repo-local briefing script. |
| GET `/api/brain/list` | Optional type, tag, status, relevance and Number-converted limit; limit 20 when omitted; archived excluded unless status=archived | `{ results: SearchResult[] }`, the full CLI list result | CLI/subprocess failures are 500 `{ error }`; filter strings are not HTTP enum-validated. Rows include path, title, type, status, relevance, nullable summary, updated, nullable deadline/generatedFrom, comma-separated tags (null when none), score=0 and empty snippet. No created field or tags-array conversion is added by HTTP. |
| GET `/api/brain/stats` | No inputs | Full `brain stats --json` object | No HTTP wrapping, filtering or formatting; CLI failure 500 `{ error }`. The integration contract owns the complete corpus shape, including unknown values. |
| GET `/api/brain/stats/history` | No inputs (no HTTP since filter) | Full `brain stats --history --json` object | Preserve [stats-history behavior](integration-contract.md#corpus-stats-history-get-apibrainstatshistory-additive-in-0400), including 500 with an older CLI; older servers can lack the route. |
| POST `/api/brain/add` | JSON `{ content: string, type?: string, title?: string, tags?: string[] }`; nonempty string content and declared optional field types are checked before CLI dispatch; CLI supplies default type/title/taxonomy rules | `{ success: true, action: "created" \| "appended", path, title, type, indexed: boolean, indexError?: string }` | 400 missing/empty content; common body limit/media type; CLI/save/outcome parsing failures 500 `{ error }`. Malformed/non-object JSON or invalid field types return JSON 400 before CLI dispatch or content writes. Capture may succeed with indexed:false: retry index, never resubmit content automatically. |
| POST `/api/brain/index` | JSON media type required; body ignored | `{ success: true }` | Concurrent retries coalesce per route instance. Failed index is 500 `{ error }`; no captured content is written again. |

The approved nullable declaration correction (#702) preserves these HTTP
values. TypeScript clients must handle `SearchResult.tags: string | null`;
`result.tags ?? ""` is a local display fallback. The server list mirror now
matches the CLI fields above. See [the declaration migration](integration-contract.md#stable---json-shapes)
and [reranker/provider migration](extending/rerankers.md#nullable-tags-migration).

Search/list payloads are the actual CLI JSON results, not the server's narrower
TypeScript mirrors. Optional/additive CLI fields are retained. Type/tag/status/
relevance filters are passed through as strings; there is no HTTP taxonomy enum
validator. Search has no HTTP include-archived switch. Capture defaults come
from CLI ingestion: explicit type/title/nonempty tags override classification;
otherwise taxonomy hints/append matches choose the type (fallback inbox type),
matched title or first content line chooses the title, and content-derived tags
are used. See [ingestion](../packages/core/src/lib/ingestion.ts).

Empty, zero or NaN search/list limits are not forwarded by the CLI wrapper;
other Number-converted values are forwarded for CLI interpretation. These are
current pass-through rules, not an HTTP promise to accept arbitrary strings
or out-of-range limits as valid numbers.

**POST /api/brain/sync — protected, body ignored.** A successful admission is
200 `text/event-stream`. SSE `data` records contain JSON:
`{ type: "start" | "progress" | "done", text?: string, success?: boolean }`.
Progress is line-oriented human CLI output; a `done` frame contains success
and a human message. It is not the CLI JSON sync result and is not a single
JSON HTTP response. Keepalive comments may occur every 15 seconds; parsers
must ignore SSE comments. A terminal failure after admission stays HTTP 200
with `type: "done", success: false`; transport termination without done is
an incomplete result, not success.

One HTTP sync per canonical brain root is admitted across app instances;
concurrent attempts get 409 `{ error }` before SSE starts. The route invokes
`brain sync --human`. Disconnecting the reader stops delivery but **does not
cancel sync or release its reservation**; output continues draining until the
child exits. Successful sync attempts voice keyterm rebuild; a rebuild failure
is progress text and does not turn successful sync into failure. A degraded
rebuild (no usable core peer, or an index core cannot read) is reported as
progress text and not cached. A canonical
root-resolution failure before admission can use the common 500. No idempotency
key or SSE resumption promise exists.

## Sessions and execution records

All are protected; access is to the shared server record, not solely the
calling principal's runs or sessions.

**GET /api/sessions.** No inputs. Returns `{ sessions: ChatSession[],
unavailableBackends?: string[] }`, newest lastActiveAt first. Each session has
id, nullable title, createdAt, lastActiveAt, totalCostUsd, numTurns and
backendId. Stored nonzero accounting supplements a backend's zero figures.
A cross-backend handoff destination (additive, #61) also carries
`handoffFrom: { sessionId, title, backendId?, afterTurns? }`, as the
[integration contract](integration-contract.md#cross-backend-handoff-additive-61)
describes. A session the host has labelled (additive, #1004) carries
`label`, a few words about its latest request, as the
[integration contract](integration-contract.md#pill-labels-additive-1004)
describes.
Each backend list has a three-second wait; unfinished work is reused by retries
and is not canceled. One unavailable backend is omitted and identified in the
optional list without discarding healthy backends; registry-level failure is
500 `{ error }`.

**GET /api/sessions/:id.** ID is opaque; no body/query inputs. Returns
`{ id, messages: SessionHistoryMessage[] }` using the stored owning backend.
Message shapes follow the SDK/wire history contract. An unknown/unavailable
backend or history failure is 500 `{ error }`; the route does not translate
missing sessions into a universal 404 or provide a separate history deadline.

| Supported operation | Inputs/defaults | Success and observable behavior | Errors |
| --- | --- | --- | --- |
| GET `/api/activity/runs` | Optional origin/job/session/status strings; limit defaults 50, Number-converted and clamped 1–200 (zero/NaN → 50); before Number-converted, default now+1 (zero/NaN → default) | `{ live: ActivityRunSummary[], history: ActivityRunSummary[] }`. Live open roots match origin/job/session, are not limited/paginated or filtered by before/status. History is newest-first rollups strictly before before, with all filters and limit; live IDs excluded. SDK summary preserves unknown/null accounting. | Read failures 500 `{ error }`; filters are not enum-validated by the route. |
| GET `/api/activity/runs/:runId` | Run ID; `include=payloads` opts into tool_input/tool_output events | `ActivityRunDetail`: retained `{ runId, detailPruned:false, spans, events, highWaterSeq, rollup? }`; after pruning `{ runId, detailPruned:true, rollup }`. Same wire mappers and accounting semantics as activity WS frames. | Never-existed run 404 `{ error: "Unknown run" }`; read failures 500 `{ error }`. Pruned detail is a successful resolution, not a missing run. |
| GET `/api/activity/rollups` | days: truncate Number, zero/NaN/absent → 7, clamp 1–90 | `ActivityRollups`: `{ timeZone, days, jobs, sessions }`, aggregates over runs started at/after now−days. Days newest-first, in configured timezone (default UTC); invalid timezone grouping degrades to UTC. Root-only sums; unknown list cost is a floor, unknown effective cost is counted by unpricedRuns. | Read failures 500 `{ error }`. No upper bound is applied by this older aggregate route. Both cost axes round each completed group sum to four decimals at the response boundary; stored costs retain their original precision. |
| GET `/api/activity/stats` | days: truncate Number, zero/NaN/absent → 30, clamp 1–90 | Full `ActivityRuntimeStats`, specified in the [runtime-stats contract](integration-contract.md#runtime-stats-get-apiactivitystats-additive-in-0370). Closed window, labeled coverage, raw sums, independent unpriced counters and nullable incomplete averages. | Read/computation failures 500 `{ error }`. Does not read brain.db. |

For fractional/negative finite values these rules produce whole-day windows;
query conversion does not produce a validation 400. Aggregate arrays and
optional/null wire fields follow the SDK declarations. The more detailed
runtime-stats and cost-tracking contract continues to govern those payloads.

## Content and confirmed shares

**GET /api/files/content — protected.** Required nonempty repo-relative `path`;
`raw=1` requests bytes, every other raw value requests JSON. No body. Paths
cannot be absolute, contain `..`, NUL or Windows path syntax, or escape the
canonical brain root via symlinks. Directory browse exclusions are not a second
access-control layer on this read endpoint. Files larger than 10,485,760 bytes
are refused.

Default response is `FileContentResponse`:
`{ path, kind: "markdown" | "html" | "text" | "binary", size, mtime, mime,
content?: string }`; binary metadata omits content. Raw mode returns bytes
with MIME by type/extension, Content-Length, inline disposition, nosniff,
Accept-Ranges: bytes, restrictive CSP and
`Cache-Control: private, max-age=0, must-revalidate`.

A valid single Range on raw GET returns 206 with Content-Range and exact
Content-Length; unsatisfiable range returns 416 with `bytes */size`. Malformed
or multiple ranges are ignored (200), as are Range with If-Range and HEAD.
Suffix/open-ended ranges are supported. A changing file is remeasured once;
a partial still-changing response can report an unknown total `*`.
Missing path is 400 `missing_path`, unsafe path 400 `invalid_path`, missing file
404 `not_found`, excess size 413 `{ error:"file_too_large", size }`, other
failures 500 `internal_error`. Error names are JSON `error` strings.

**POST /share-target — public, body ignored, outside /api.** Always 303 to
`/?share_error=no_worker`; no payload is read or saved. This is the network
fallback when the SDK service worker did not intercept a share navigation.
It must precede authentication: a cross-site POST does not carry the Strict
session cookie. Successful SDK interception instead stashes locally and
redirects with `?share=<id>` (or `share_error`); that is the SDK's local flow,
not a server upload. Loading the app makes the next worker interception possible.

**POST /api/share — protected.** Multipart fields `title`, `text`, `url` are
optional nonempty strings; binary files must be repeated in `files`. Empty
files are ignored. Normalized payload must contain text, URL or a file. Only
http/https URLs become the normalized URL; unusable URL text is retained as
text, not fetched. The app must show untrusted stashed input and obtain user
confirmation before uploading it for ingestion. Intake stages bytes and creates one untrusted thread and ready triage item; it does
not authorize the agent to execute a share's instructions.

Limits: 10 files, 25,000,000 bytes/file, 50,000,000 total file bytes and
200,000 UTF-8 bytes per normalized text field; at most 50 staged shares and
three simultaneous intakes per route instance. The body reader allows total
file cap plus 1,000,000 bytes for multipart framing, counting streamed bytes
before parsing rather than trusting Content-Length.

Success: 201 `ShareIntakeResult` (`id`, repo-relative `dir`, `receivedAt`,
optional title/text/url, `files: [{ name, path, mediaType, bytes }]`, optional
`skipped: string[]`). Paths and ID are server-minted; names are sanitized and
conflicts deduplicated. Data is staged under `.brain-ui/inbox` and the result
omits the manifest's source field. Individual unwritable files are reported as
skipped instead of discarding other staged data. Oversized bodies/fields/files
or full inbox yield 413 `{ error, limit }` with `share_too_large`,
`text_too_large`, `file_too_large`, `too_many_files` or `inbox_full`; malformed
form 400 `invalid_form`, empty payload 400 `empty_share`, concurrent capacity
503 `busy`, other staging failures 500 `share_failed`. The common origin
rejection remains 403. Trust/profile/source/principal and capability overrides are rejected as
`invalid_form`, including case and underscore/hyphen spelling variants.
Unrecognized application metadata retains the existing ignored-field behavior.
Identical normalized fields and file names/media types/actual bytes replay the
original staging result and update `lastSeenAt`, with one thread/item/staging
area. Changed content is a new arrival; share and CLI dedup namespaces are separate.
Committed Queue staging is protected from legacy seven-day housekeeping;
ordinary standalone staging keeps that TTL. The item retains its declared
expiry. This endpoint starts no model run and provides no execution grant.

## Push subscription lifecycle

All are protected and return JSON. Stored subscriptions belong to the resolved
principal, not just to anyone who can present their endpoint. No API returns
VAPID private key or stored delivery key material.

| Supported operation | Inputs/validation | Success | Errors and behavior |
| --- | --- | --- | --- |
| GET `/api/push/public-key` | None | `{ publicKey: string }`, application-server public key | Sender failure 500 `{ error }`. |
| GET `/api/push/subscriptions` | None | `{ subscriptions: [{ label, createdAt, lastUsedAt, endpointHash, timeZone }] }` for caller only; label/lastUsedAt/timeZone nullable | Endpoint hash is first 16 hex characters of SHA-256; never endpoint or keys. `timeZone` (additive, #683) is the device's last usable reported IANA zone; null means its Action notices wait for a zone report. Store failure 500 `{ error }`. |
| POST `/api/push/subscribe` | JSON `{ subscription: { endpoint: URL string (max 2048), keys: { p256dh: string (1–512), auth: string (1–512) } }, label?: string (max 120), timeZone?: string (max 256) }` | `{ ok: true }` | Invalid JSON/schema/store error 400 `{ error }`; unusable principal 401 `{ error:"Authentication required" }`. Upserts the caller's subscription; resubmitting the same endpoint updates keys/label and binds it to the current caller. Additive `timeZone` (#683) records the device's notification zone; a value the server's zone database rejects is stored as missing rather than refused, and omitting it keeps the device's last reported zone. |
| POST `/api/push/unsubscribe` | JSON `{ endpoint: URL string (max 2048) }` | `{ removed: boolean }` | Invalid JSON/schema/store error 400 `{ error }`. Removing an unknown or another principal's endpoint returns removed:false. |

These routes preserve the default SDK worker renewal request; custom shells
may override subscribeUrl only with an endpoint implementing the same request
semantics. A revoked/logged-out worker may fail renewal and retry when the app
opens; the service worker does not acquire fresh authentication itself.

## Rendering

**POST /api/render — protected, JSON.** Body `RenderRequest`:
`{ content: string (nonempty), contentType: "markdown" | "html",
format: "png" | "pdf", title?: string (max 200) }`. No defaults for the three
required fields; title defaults to `"share"` for the download name. Limit is
5,000,000 raw request bytes, including inlined media. No renderer: 501
`{ error:"render_unavailable", detail }` before body parsing (after media-type
check). Invalid JSON/schema: 400 `{ error:"invalid_request", detail }`;
common excess body: 413. Renderer failure: 500
`{ error:"render_failed", detail }`.

Success is bytes, 200 `image/png` or `application/pdf`, Content-Length,
`Cache-Control: private, max-age=0, must-revalidate` and inline filename. The
filename replaces characters outside letters/digits/underscore/dot/hyphen
with underscore, takes at most 60 characters and appends the format extension.
Content uses the shared document-template behavior; rendering capabilities
are injected by the host and are not evidence of a new renderer extension seam.

## Models and speech

Model operations are protected. Roster IDs and discovered membership can evolve;
clients use IDs as opaque selections and the declared metadata for presentation.

**GET /api/providers.** No inputs. Returns
`{ providers: ProviderInfo[], backends: Record<string, { id, capabilities }>, unavailable?: UnavailableProfileInfo[] }`.
Visible profiles only; hidden profiles still resolve for pinned sessions.
`providers` lists only profiles that can run now. `unavailable` (additive,
#1044) lists visible profiles a backend is configured with but cannot run, each
`{ id, label, reason, backendId }` with `reason` from the closed
`ProfileUnavailableReason` enum (`needs-credentials`); it is absent when there
are none, and its ids are never valid `providerId`s. Clients own the reason's
copy and show an unknown reason generically.
Each backend record contains id and declared capabilities. ProviderInfo has id/label,
optional vendor/backendId/contextWindow/thinkingLevel/source/billingMode/
pricingRoute, with SDK meanings. Cached discovery is refreshed when stale;
only a cold source blocks on discovery. Uncaught source/registry failures use
the common 500, not an invented success-with-empty fallback.

**GET /api/models.** No inputs. Returns `ModelCatalogResponse` with
`models: ModelCatalogEntry[]` (ProviderInfo plus hidden and optional billing/
thinking override), nullable `refreshedAt`, boolean `stale`,
`discovery: { enabled, error? }`, and current default/custom-model metadata
(`defaultModelId`, optional resolvedDefaultId, customModels). Includes hidden
profiles. Same freshness semantics and common 500 failure boundary.

**PUT /api/models/hidden — JSON.** Body `{ hidden: string[] }`, a full
replacement, not a delta. Only array/string shape is validated; empty clears
visibility overrides and unknown string IDs are retained. Invalid JSON/body
is 400 `{ error }`; common limit/media errors apply. Persists the set,
invalidates profile memo and returns the new ModelCatalogResponse; subsequent
visible picker reads reflect the change. Other database/registry failures can
use common 500. Pinned-session profile resolution remains possible.

**POST /api/models/refresh — body ignored.** No inputs. Absent discovery source
returns 409 `{ error }`. Otherwise forces refresh, invalidates profile memo
and returns ModelCatalogResponse. Refresh failure serves the previous roster
and its discovery failure metadata; it does not erase models or turn that
refresh failure into a 500. Other registry/catalog failures can use common 500.

Speech operations are protected, with body ignored for POST. They support
SDK speech-session payloads rather than exposing long-lived provider keys:

| Supported operation | Inputs/defaults | Success | Errors and behavior |
| --- | --- | --- | --- |
| POST `/api/voice/session` | No inputs; configured active speech provider, including `createApp({ speechProvider })` | `VoiceSessionResponse`: providerId, connection url, optional token/params, expiresAt and capabilities (streaming, interimResults, keyterms, endpointing, derived savedAudio) | 500 `{ error }` for unavailable provider/minting, invalid provider/session, or explicit provider/value mismatch; no fallback. Keyterms are included only when supported by the provider; browser/local sessions can omit token and use empty URL/zero expiry. |
| POST `/api/voice/token` | No inputs | `{ token, expiresAt }` | Deprecated Deepgram-specific alias retained for client migration; mints directly with 60-second requested TTL, 500 `{ error }` on failure. |
| GET `/api/voice/keyterms` | `rebuild=1` forces cache rebuild; all other values read normal cache | `{ keyterms: string[], generatedAt, count }` | 500 `{ error }` on read/build failure, including a missing, corrupt, locked or unreadable index. Without a usable optional `@schlessera/brain` peer, or with an index version core cannot read, 200 with an empty vocabulary that is never cached ([optional core peer](integration-contract.md#ui-server-optional-core-peer-breaking-host-migration-697)). |
| GET `/api/voice/overrides` | No inputs | `{ overrides: [{ match, replacement }] }` | Configured pronunciation replacements; 500 `{ error }` on cache read/build failure. |

## Map geometry

**GET /api/geo/coastline — protected.** Required `bbox=w,s,e,n`, four finite
numbers with −180 ≤ west < east ≤ 180, −90 ≤ south < north ≤ 90, each span at
most five degrees. Invalid/missing bbox yields 400 `{ error:"invalid_bbox" }`.
Optional width Number-converted, default/fallback 330 when invalid or nonpositive,
bucketed upwards to 330/660/1320; optional detail coast/roads/streets overrides
otherwise automatic detail. Unknown detail values use automatic detail.

Success is 200 `CoastlineResult`: coastline/roads/streets as arrays of `[lon,lat]`
polylines, land rings, detail, partial, toleranceM and attribution. Every reply,
including empty geometry, includes OpenStreetMap attribution. Provider
unavailability/failure degrades to empty or partial geometry with 200 rather
than a chat-rendering failure. Complete nonempty geometry is cached indefinitely
with quantized keys; cache hits include
`Cache-Control: public, max-age=31536000, immutable`. Partial/empty results are
not stored indefinitely. This deliberate exception to private content caching
does not override the SDK's network-only `/api` service-worker rule.

## WebSocket admission

**GET /ws** supports an actual WebSocket upgrade, followed by the
[wire protocol contract](integration-contract.md#revision-negotiation).
It is outside `/api`; origin checking runs first, then the same auth-mode
credential/IP policy, then connection capacity, then upgrade. Rejected origin:
403 `{ error:"Cross-origin WebSocket rejected" }`; failed auth: 401
`{ error:"Authentication required" }`; capacity: 503 plain text
`WebSocket connection limit reached`; authenticated non-upgrade: 400
`{ error:"WebSocket upgrade required" }`. A successful upgrade changes the
transport; wire negotiation, frames and close behavior are governed by that
existing contract, not by a JSON HTTP success envelope. There is no bearer-token
query parameter or new HTTP version negotiation in this inventory.

## Recorded gaps

The supported promises above are not removed to accommodate these observations:

- The [runtime coverage matrix](http-api-coverage.md) maps every supported
  operation to a real mounting check and named behavior tests (#691).
  Guard-only failures are not proof that a protected handler is mounted.
- [#693](https://github.com/schlessera/brain-kit/issues/693) aligns the public
  React health and sync helpers: health currently requires a version absent
  from the intentionally minimal public response; brainSync parses SSE as JSON.
  Correcting the supported health return type needs the maintainer ruling
  recorded there. This specification does not implement that type migration.

No route removal, consolidation or authentication redesign is authorized here.
A proposal affecting an existing supported promise needs its own ruling before
implementation. The tracker holds unfinished work; this page holds the current
boundary and the evidence needed to interpret its promises.

## Authenticated CLI intake (additive, #679)

**POST /api/queue — protected.** JSON has exactly `{ key, title?, text?, url? }`;
unknown fields are 400 `invalid_request`. `key` is 1–128 ASCII characters,
starting with a letter or digit and then letters/digits/`.`/`_`/`:`/`-`. At
least one normalized content field must survive; text normalization and limits
match share intake. The common 256 KiB JSON body cap and JSON media type guard
apply. Files are supported by `/api/share`; CLI intake takes these text fields.

Success is 201 `{ queued: true, created: boolean, threadId: string,
itemId: string, stagingId: string }`. The server derives immutable `cli` /
`trusted` provenance and the admitting principal from the authenticated endpoint.
The staging manifest records `source: "cli"`; a receipt in the operational UI
store retains principal attribution after credential pruning. A trusted origin
is no blanket execution authority. Existing password, proxy, tailscale and
explicitly configured none authentication rules apply, including delegated
principals' ordinary route access. Current authority is rechecked after awaited
input/staging and inside the committing transaction.

Replaying the key with identical normalized content returns `created: false`
and the same IDs, updates `lastSeenAt`, and creates no additional staging area.
The first arrival's provenance stays unchanged. Different content for that key
is 409 `{ error: "key_conflict" }`. Replays never revive a terminal/removed item.
Other responses: common 401/403, 400 `empty_share` / `invalid_request`, 413
`{ error, limit }` from text limits, common 413 body limit, 415
`unsupported_media_type`, and 500 `queue_failed`. Keep the same key after an
unknown delivery outcome; a committed operation followed by response loss is
safe to retry.

A server-minted staging ID is journaled before files are written. The work and
committed receipt enter the UI database in one transaction. Definite failed
writes compensate staging; failed compensation is retained for boot/next-intake
reconciliation. Abandoned preparations become cleanup after an hour, protecting
other live writers. Cleanup never removes a committed receipt's bytes. These
receipts are included in the existing audit-only operational export; they do
not turn it into a filesystem backup. The CLI never accesses UI SQLite or
`brain.db` for this operation, and intake does not file markdown or dispatch
production autonomous work before its containment/system gates.

## Scheduled tasks (additive, #914)

Seven protected routes store and inspect scheduled tasks for `brain schedule`
and other clients. None of them runs work: no dispatcher is wired, and the
stored task reports `executionAvailable: false` / `dispatch_disabled`. Request
bodies must be `application/json`, at most 64 KiB of valid UTF-8, with no NUL
and no duplicate object keys. Unknown fields or query parameters are
`invalid_request`. Every response is `Cache-Control: no-store`. Errors are
`{ ok: false, error: { code, message } }` with the closed codes and statuses of
the [schedule contract](integration-contract.md#scheduled-tasks-additive-914):
400 `invalid_request`/`invalid_cursor`, 401/403 `unauthorized`, 404
`not_found`, 409 `key_conflict`/`approval_required`/`approval_expired`/
`definition_conflict`, 503 `server_unavailable`/`unsupported_capability`.
The common authentication guard answers before these handlers with its own
401/403 body.

**POST /api/schedules/proposals** takes `{ key, definition, clientTimeZone? }`
and answers 201 `{ ok: true, proposal }` (200 for a matched replay by the same
principal and key). It validates and materializes the definition, resolves the
zone, and stores nothing authoritative. **POST
/api/schedules/proposals/:id/approve** takes `{ fingerprint, decision:
"approve" }` from an operator principal and answers 200 `{ ok: true,
approvalId }`. **POST /api/schedules** takes `{ proposalId, approvalId? }` from
the proposal's creator; it answers 201 `{ ok: true, created: true, task }` once
the ledger and the definition file agree, and 200 `created: false` when a
receipt already exists. **GET /api/schedules** accepts `limit`, `cursor`,
`state` and `id`. **POST /api/schedules/:id/cancel** takes `{ key }` and
answers 200 `{ ok: true, changed, task, runningOccurrences }`. **POST
/api/schedules/:id/reconcile** takes `{ key, decision: "reopen" }` from an
operator principal and answers 200 `{ ok: true, changed, task }`: it reopens a
task paused as `restore_pending` or `unknown_effect` once its file still
matches the approved bytes, and `changed: false` for a matched replay or a task
with nothing to reconcile. **GET
/api/schedules/due** accepts `limit` and `cursor`; it is read-only. Cursors are
host-signed, bound to the caller, filters and evaluation time, and expire after
15 minutes. Responses stay under 512 KiB.

## Session drafts (additive, #979)

Six protected routes keep each session's unsent composer draft on the host,
as [D52](decisions/design-kit.md#5-per-session-drafts-stored-on-the-host-storage-c)
designed. They are advertised by `server_hello.capabilities.sessionDrafts:
true`, with `server_hello.sessionDraftLimits` carrying the bounds; a client
must not claim host saving without that flag. Shapes are the SDK's `Draft*`
types in `@schlessera/brain-ui-sdk/protocol`, and the
[integration contract](integration-contract.md#session-drafts-additive-979)
holds the semantics. None of them sends, starts, answers or grants anything.
Every response is `Cache-Control: no-store`. The common authentication guard
answers first; each handler then re-resolves its principal inside its write
transaction, after the body is read, and answers a revoked or expired one
with the guard's 401 `{ error: "Authentication required", authRequired: true }`.
The namespace is the host's, shared by every principal that authenticates to
it; it is not partitioned per login.

**GET /api/drafts** returns `{ drafts: DraftSummary[] }`, every live draft,
newest change first. At most `maxDrafts` exist, so one response is the
complete list. **GET /api/drafts/:draftId** returns the `Draft`, its images'
decoded bytes base64-encoded in `bytes`.

**PUT /api/drafts/:draftId** takes `If-Match: <revision>` (`0` creates),
`Idempotency-Key` and the JSON body `{ sessionId: string | null, text,
attachmentIds: string[] }`, at most 512 KiB, and answers 200 `{ revision,
updatedAt }` only after the commit. A save cannot change `sessionId`; that
is a conflict. An empty draft is deleted, not saved (400). **POST
/api/drafts/:draftId/attachments** takes the raw image as the body, its type
as `Content-Type` (`image/jpeg`, `image/png`, `image/webp` or `image/gif`;
otherwise 415 `{ error: "unsupported_media_type" }`), an optional `name`
query parameter and `Idempotency-Key`, and answers 200 `{ attachmentId }`.
The bytes must carry the declared type's signature. A save lists the image
to attach it; an upload no save lists is removed an hour later.
**DELETE /api/drafts/:draftId** takes `If-Match` and answers 204, leaving a
tombstone; retrying the same delete answers 204 again. **POST
/api/drafts/:draftId/bind** takes `{ sessionId, requestId }` and answers 200
`{ revision }` only when the host accepted a first message carrying this
draft and that `requestId`, and it started that session.

Failures are `{ error: <code>, message, ... }`: 400 `DRAFT_INVALID`;
404 `DRAFT_NOT_FOUND`; 409 `DRAFT_CONFLICT` with `current` (the host's
`Draft`), `DRAFT_KEY_REUSED` or `DRAFT_NOT_ACCEPTED`; 410 `DRAFT_DELETED`
with `tombstoneRevision`; 413 `DRAFT_TOO_LARGE` and 507 `DRAFT_CAPACITY`,
each with `limit` and `bound`; 428 `DRAFT_PRECONDITION_REQUIRED` when
`If-Match` is missing. Bodies are counted as they stream, whatever
`Content-Length` says. A refused or failed request leaves the committed
draft unchanged.

## Session recovery (additive, #964)

**GET /api/sessions/:id/recovery** is protected and read-only: it never
selects a session, starts work, answers an interaction or grants anything.
It is mounted, and `server_hello.capabilities.sessionRecovery: true` is sent,
only by a host that records accepted work; a client must not read it
without the flag, and reads a missing route as a host too old to answer.
It answers 200 with the SDK's `SessionRecovery` for a session the catalog,
the live coordinator or any backend knows; the
[integration contract](integration-contract.md#session-recovery-additive-964)
holds the field semantics. Every response is `Cache-Control: no-store`. The
common authentication guard answers first; the handler re-checks the
principal after its one asynchronous step (looking the session up in the
backends when the catalog does not know it; the first backend that replays
any history settles it, and each gets three seconds) and answers a revoked or expired
one with the guard's 401 `{ error: "Authentication required", authRequired:
true }`, disclosing nothing about the session. An unknown session is 404
`{ error: "SESSION_NOT_FOUND", message }`. A storage failure, or a backend
that failed or timed out when none had the session, is 500 `{ error: "SESSION_RECOVERY_FAILED", message }`, never a successful
`unknown`.

## Imported track UI transport (#526)

The paired UI uses authenticated `POST /api/track-upload` multipart intake and
`GET /api/tracks?path=<staged reference>` to validate originals and resolve track
blocks. These are internal HTTP transports under the selection policy; published
SDK file-reference frames, `show_block` and kit props retain their ordinary
contracts. The [imported-track behavior](integration-contract.md#imported-track-files-in-chat-additive)
describes validation, limits, outcomes and static export. They do not file
knowledge-base content or narrow existing generic `/api/share` intake.

## Interactive HTML preview (additive, #1084)

`GET /api/files/html?path=…` is protected and serves an `.html`/`.htm` file
(extension matched case-insensitively, on the requested path and on the file
it resolves to) under the same path, auth and 10,485,760-byte rules as
`GET /api/files/content?raw=1`. Missing `path` is 400 `missing_path`; another
extension, or a symlink to a non-HTML file, is 400 `not_html`; path errors,
missing and oversized files answer as on the raw route. It is internal UI
transport, but its headers are a security property and are pinned by tests:

- `Content-Type: text/html; charset=utf-8`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`,
  `Cache-Control: private, max-age=0, must-revalidate`.
- `Content-Security-Policy: sandbox allow-scripts; default-src 'none';
  script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline';
  img-src data: blob:; font-src data:; media-src data: blob:;
  connect-src 'none'; form-action 'none'; frame-ancestors 'self'`.
- `X-Frame-Options: SAMEORIGIN` on a successful response only. Every other
  response, including this route's errors, keeps `DENY` and
  `frame-ancestors 'none'`.

The `sandbox` directive gives the document an opaque origin whether it is
framed or opened as a top-level tab, so its script cannot read the app's DOM,
cookies or storage. `connect-src 'none'` blocks fetch, XHR, WebSocket and
beacons in the browser, in every auth mode: the missing `SameSite=Strict`
cookie is a further barrier only in `AUTH_MODE=password`. Popups, form
submission, downloads and navigation of the embedding app are not granted.

Accepted residual risks (maintainer ruling on #1084): a document may navigate
itself to any URL, carrying what it can read (its own file and anything typed
into it), and a tab shows the untrusted content under the app's host. Channels
Chrome does not let a CSP govern, such as WebRTC and DNS prefetch, can carry the
same data. The
real-Chrome test `packages/ui-react/tests/html-preview-runtime.test.ts`
asserts the isolation and both accepted behaviours. In a split topology, where
the client is served from another origin, `frame-ancestors 'self'` refuses the
preview frame; the new-tab link is not subject to framing rules.

## Saved-audio transcription

The protected `GET /api/voice/capabilities` returns `VoiceCapabilitiesResponse`
(`{ providerId, capabilities }`) with `savedAudio` derived from the optional
provider method. It calls neither a provider nor `createSession`. Unavailable
selection gives the existing 500 `{ error }` response. Responses are `no-store`.

`GET`, `PUT` and `DELETE /api/voice/recordings/:recordingId/transcription`
require a recording UUID and a currently usable account principal. Owner
logins and admitted ambient accounts are allowed; agents/system principals
receive 403 `owner_required`. A different proxy account receives 404
`transcription_not_found` for a known id on every method; unauthenticated
requests receive 401. Authority is rechecked after the body and after provider
completion. The account identity is the same host/root key as `/api/vpn-check`,
never a browser-supplied key or the transient login id.

`GET` returns 200 `RecordingTranscription`, or 404 when no receipt exists.
`PUT` takes raw audio with `Content-Type` (`audio/webm`, `audio/ogg`, `audio/mp4`,
optionally `codecs=opus`) and lowercase 64-digit `Content-SHA256`. The server
computes SHA-256 itself. Empty bytes or an invalid/mismatching hash produce 400;
unsupported media gives 415. A streamed or declared body above **10,041,155
bytes** gives 413 even without an honest Content-Length. This is a ten-minute
byte budget, not a duration proof. The cap is `ceil(52783 / 3.154 * 600)`:
the highest byte rate from six additional V1 `track-ended` runs (three each,
Chromium 153/Firefox 155, pinned Playwright 1.63.0, 2026-10-08). Firefox's
highest run had 52,783 bytes over 3,154 decoded milliseconds. Other browser
boundaries remain unmeasured; this receipt is not physical-device coverage.

The [saved-audio integration contract](integration-contract.md#saved-audio-transcription-additive-1021)
specifies the receipt fields, errors, retry decision and permanent retention.
`PUT` responds 200 with the stored receipt, including provider failures; a
failed plain replay gives 409. `?retry=<failed attemptId>` is the only retry
request, with at most three user retries and no automatic provider calls.
Unsupported providers return 501 `saved_audio_unsupported`.
`DELETE ?disposition=accepted|discarded` returns 200 with a `consumed` receipt;
an invalid disposition gives 400. It removes text, retains the immutable id
and hash, and inserts a hashless tombstone if no upload has claimed yet.

## Human-started hygiene review (additive, #1027)

`GET /api/hygiene/review` reads durable review state and its pending Action.
`POST /api/hygiene/review` accepts `{ operation: "start" | "pause" | "resume" | "refresh" }`.
Refresh reads the current canonical finding through read-only targeted CLI selection.
A new fingerprint atomically replaces the card and retains a `superseded` receipt
on the terminal old card. Position/counters and Markdown remain unchanged; old
preview/confirmation requests refuse. Missing/changed findings remain pending
with stale evidence, and unavailable checks remain refused. An unchanged fingerprint
returns the same card. Refresh preserves Pause and cannot re-admit a cap-retired card;
use Resume. Full [refresh semantics](integration-contract.md#human-started-hygiene-review-additive-1027)
bind independent clients.

`POST /api/hygiene/review/preview` accepts a stored `itemId`, `optionId`,
`expectedVersion` and bounded handler `input`. Owner/ambient operation authority
is rechecked against the durable principal. These routes run only deterministic
CLI operations; confirmation uses the existing `inbox_resolve` WebSocket path.
See [the wire shapes and error codes](integration-contract.md#human-started-hygiene-review-additive-1027).

# Supported HTTP coverage

This matrix connects the [HTTP specification](http-api.md) to runtime evidence.
The inventory test observes the Hono instance assembled by `createApp`, including
all supported and internal method/path pairs. Disposable brain roots, SQLite,
fake backends and injected transports keep the checks keyless.

Each ordinary row runs the named `mounted supported handler: METHOD PATH` test
in [http-supported-mounts.test.ts](../packages/ui-server/tests/http-supported-mounts.test.ts)
(`mounted supported handler:`, `packages/ui-server/tests/http-supported-mounts.test.ts:74-107`).
That request carries a real owner cookie and checks the handler's response or
side effect. Public login verification also has a successful mounted login
check in A; successful passkey cryptographic verification uses the injected
verifier in P. The mounted passkey checks establish routing, challenge creation,
management and handler-specific rejection independently of that verifier.

W uses a real local Bun listener and observes `server_hello` after upgrading.
The four named positive tests are `real WebSocket admission: untrusted proxy
accepts a matching HTTPS Origin`, `real WebSocket admission: trusted proxy
accepts forwarded HTTPS`, `real WebSocket admission: trusted proxy maps WSS to
HTTPS` and `real WebSocket admission: trusted proxy maps WS to HTTP`
(`real WebSocket admission:`, `packages/ui-server/tests/http-websocket-admission.test.ts:44-53`).
An HTTP response other than 403 is insufficient evidence of admission.

The final column names detailed behavior checks below. Some existing checks
exercise a route factory or its underlying store/CLI; they complement each
row's real mounting check. They do not establish mounting by themselves.

| Supported operation | Mounted receipt | Detailed checks |
| --- | --- | --- |
| `GET /api/activity/rollups` | `mounted supported handler: GET /api/activity/rollups` | R |
| `GET /api/activity/runs` | `mounted supported handler: GET /api/activity/runs` | R |
| `GET /api/activity/runs/:runId` | `mounted supported handler: GET /api/activity/runs/:runId` | R |
| `GET /api/activity/stats` | `mounted supported handler: GET /api/activity/stats` | R |
| `POST /api/auth/login` | `mounted supported handler: POST /api/auth/login` | A, P, Z |
| `POST /api/auth/logout` | `mounted supported handler: POST /api/auth/logout` | A, P |
| `GET /api/auth/methods` | `mounted supported handler: GET /api/auth/methods` | P |
| `DELETE /api/auth/passkey/:id` | `mounted supported handler: DELETE /api/auth/passkey/:id` | P, O |
| `PUT /api/auth/passkey/:id` | `mounted supported handler: PUT /api/auth/passkey/:id` | P, O, Z |
| `GET /api/auth/passkey/list` | `mounted supported handler: GET /api/auth/passkey/list` | P, O |
| `POST /api/auth/passkey/login-options` | `mounted supported handler: POST /api/auth/passkey/login-options` | P |
| `POST /api/auth/passkey/login-verify` | `mounted supported handler: POST /api/auth/passkey/login-verify` | P |
| `POST /api/auth/passkey/register-options` | `mounted supported handler: POST /api/auth/passkey/register-options` | P, O |
| `POST /api/auth/passkey/register-verify` | `mounted supported handler: POST /api/auth/passkey/register-verify` | P, O, Z |
| `GET /api/auth/principals` | `mounted supported handler: GET /api/auth/principals` | D, O |
| `POST /api/auth/principals` | `mounted supported handler: POST /api/auth/principals` | D, O |
| `DELETE /api/auth/principals/:id` | `mounted supported handler: DELETE /api/auth/principals/:id` | D, O |
| `POST /api/brain/add` | `mounted supported handler: POST /api/brain/add` | B, C, Z |
| `GET /api/brain/briefing` | `mounted supported handler: GET /api/brain/briefing` | B |
| `POST /api/brain/index` | `mounted supported handler: POST /api/brain/index` | B, C |
| `GET /api/brain/list` | `mounted supported handler: GET /api/brain/list` | B |
| `GET /api/brain/search` | `mounted supported handler: GET /api/brain/search` | B, V |
| `GET /api/brain/stats` | `mounted supported handler: GET /api/brain/stats` | B |
| `GET /api/brain/stats/history` | `mounted supported handler: GET /api/brain/stats/history` | B |
| `POST /api/brain/sync` | `mounted supported handler: POST /api/brain/sync` | B, Y |
| `GET /api/files/content` | `mounted supported handler: GET /api/files/content` | F, V |
| `GET /api/geo/coastline` | `mounted supported handler: GET /api/geo/coastline` | G, V |
| `GET /api/health` | `mounted supported handler: GET /api/health` | H |
| `POST /api/internal/inbox/poke` | `mounted supported handler: POST /api/internal/inbox/poke` | I |
| `GET /api/models` | `mounted supported handler: GET /api/models` | M |
| `PUT /api/models/hidden` | `mounted supported handler: PUT /api/models/hidden` | M, V |
| `POST /api/models/refresh` | `mounted supported handler: POST /api/models/refresh` | M |
| `GET /api/providers` | `mounted supported handler: GET /api/providers` | M |
| `GET /api/push/public-key` | `mounted supported handler: GET /api/push/public-key` | U |
| `POST /api/push/subscribe` | `mounted supported handler: POST /api/push/subscribe` | U |
| `GET /api/push/subscriptions` | `mounted supported handler: GET /api/push/subscriptions` | U |
| `POST /api/push/unsubscribe` | `mounted supported handler: POST /api/push/unsubscribe` | U |
| `POST /api/render` | `mounted supported handler: POST /api/render` | E |
| `GET /api/sessions` | `mounted supported handler: GET /api/sessions` | S |
| `GET /api/sessions/:id` | `mounted supported handler: GET /api/sessions/:id` | S |
| `POST /api/queue` | `mounted supported handler: POST /api/queue` | Q |
| `GET /api/schedules` | `mounted supported handler: GET /api/schedules` | K |
| `POST /api/schedules` | `mounted supported handler: POST /api/schedules` | K |
| `POST /api/schedules/:id/cancel` | `mounted supported handler: POST /api/schedules/:id/cancel` | K |
| `GET /api/schedules/due` | `mounted supported handler: GET /api/schedules/due` | K |
| `POST /api/schedules/proposals` | `mounted supported handler: POST /api/schedules/proposals` | K |
| `POST /api/schedules/proposals/:id/approve` | `mounted supported handler: POST /api/schedules/proposals/:id/approve` | K |
| `POST /api/share` | `mounted supported handler: POST /api/share` | J, Q |
| `GET /api/status` | `mounted supported handler: GET /api/status` | T |
| `GET /api/voice/keyterms` | `mounted supported handler: GET /api/voice/keyterms` | N |
| `GET /api/voice/overrides` | `mounted supported handler: GET /api/voice/overrides` | N |
| `POST /api/voice/session` | `mounted supported handler: POST /api/voice/session` | N |
| `POST /api/voice/token` | `mounted supported handler: POST /api/voice/token` | N |
| `POST /share-target` | `mounted supported handler: POST /share-target` | L |
| `GET /ws` | Real upgrade and server_hello | W |

## Named behavior checks

**H — Liveness.**

- `/api/health is public and carries no version/SHA` ([source](../packages/ui-server/tests/app-wiring.test.ts)), (`/api/health is public and carries no version/SHA`, `packages/ui-server/tests/app-wiring.test.ts:78-84`)
- `a dead SQLite handle turns /api/health into 503 unhealthy` ([source](../packages/ui-server/tests/app-wiring.test.ts)), (`a dead SQLite handle turns /api/health into 503 unhealthy`, `packages/ui-server/tests/app-wiring.test.ts:685-700`)

**T — Operational status.**

- `mounted status reports the installed release and preserves the application commit` ([source](../packages/ui-server/tests/software-status.test.ts)), (`mounted status reports the installed release and preserves the application commit`, `packages/ui-server/tests/software-status.test.ts:5-16`)
- `has every field, and never the token` ([source](../packages/ui-server/tests/subscription-status.test.ts)), (`has every field, and never the token`, `packages/ui-server/tests/subscription-status.test.ts:290-310`)
- `a turn's runtime report and auth failure are kept for /api/status, on that turn's run` ([source](../packages/ui-server/tests/ws-runtime-status.test.ts)), (`a turn's runtime report and auth failure are kept for /api/status, on that turn's run`, `packages/ui-server/tests/ws-runtime-status.test.ts:32-87`)

**A — Password access and revocation.**

- `real app password login issues a usable owner cookie and logout revokes it` ([source](../packages/ui-server/tests/http-principal-boundaries.test.ts)), (`real app password login issues a usable owner cookie and logout revokes it`, `packages/ui-server/tests/http-principal-boundaries.test.ts:55-76`)
- `wrong password is rejected` ([source](../packages/ui-server/tests/auth.test.ts)), (`wrong password is rejected`, `packages/ui-server/tests/auth.test.ts:188-196`)
- `login is rate limited per client IP` ([source](../packages/ui-server/tests/auth.test.ts)), (`login is rate limited per client IP`, `packages/ui-server/tests/auth.test.ts:320-333`)
- `the live-principal cap returns 503 without creating a session` ([source](../packages/ui-server/tests/auth.test.ts)), (`the live-principal cap returns 503 without creating a session`, `packages/ui-server/tests/auth.test.ts:300-318`)

**P — Passkey ceremonies and metadata.**

- `reports passkey availability per RP` ([source](../packages/ui-server/tests/passkeys.test.ts)), (`reports passkey availability per RP`, `packages/ui-server/tests/passkeys.test.ts:292-301`)
- `valid assertion sets the session cookie and updates the credential` ([source](../packages/ui-server/tests/passkeys.test.ts)), (`valid assertion sets the session cookie and updates the credential`, `packages/ui-server/tests/passkeys.test.ts:439-480`)
- `register-verify stores the credential` ([source](../packages/ui-server/tests/passkeys.test.ts)), (`register-verify stores the credential`, `packages/ui-server/tests/passkeys.test.ts:960-985`)
- `list, rename, delete round-trip` ([source](../packages/ui-server/tests/passkeys.test.ts)), (`list, rename, delete round-trip`, `packages/ui-server/tests/passkeys.test.ts:987-1028`)
- `challenges are single-use, typed, and expire` ([source](../packages/ui-server/tests/passkeys.test.ts)), (`challenges are single-use, typed, and expire`, `packages/ui-server/tests/passkeys.test.ts:560-582`)
- `password login is refused once a passkey exists for the RP` ([source](../packages/ui-server/tests/passkeys.test.ts)), (`password login is refused once a passkey exists for the RP`, `packages/ui-server/tests/passkeys.test.ts:784-794`)

**O — Owner boundary with populated stores.**

- `real owner management rejects a live agent against populated principal and credential stores` ([source](../packages/ui-server/tests/http-principal-boundaries.test.ts)), (`real owner management rejects a live agent against populated principal and credential stores`, `packages/ui-server/tests/http-principal-boundaries.test.ts:19-53`)
- `non-password mode rejects every passkey route` ([source](../packages/ui-server/tests/passkeys.test.ts)), (`non-password mode rejects every passkey route`, `packages/ui-server/tests/passkeys.test.ts:257-288`)

**D — Delegated principal lifecycle.**

- `mint returns a one-time Hono cookie without replacing the owner's session` ([source](../packages/ui-server/tests/principal-routes.test.ts)), (`mint returns a one-time Hono cookie without replacing the owner's session`, `packages/ui-server/tests/principal-routes.test.ts:119-178`)
- `ttlDays validates its bounds and persists the default and maximum` ([source](../packages/ui-server/tests/principal-routes.test.ts)), (`ttlDays validates its bounds and persists the default and maximum`, `packages/ui-server/tests/principal-routes.test.ts:218-261`)
- `revocation rejects the cookie on the next request and leaves the owner live` ([source](../packages/ui-server/tests/principal-routes.test.ts)), (`revocation rejects the cookie on the next request and leaves the owner live`, `packages/ui-server/tests/principal-routes.test.ts:279-330`)
- `self-revocation is a logout and missing or already-revoked ids are 404` ([source](../packages/ui-server/tests/principal-routes.test.ts)), (`self-revocation is a logout and missing or already-revoked ids are 404`, `packages/ui-server/tests/principal-routes.test.ts:332-378`)
- `ambient modes return the same not-enabled response on all three routes` ([source](../packages/ui-server/tests/principal-routes.test.ts)), (`ambient modes return the same not-enabled response on all three routes`, `packages/ui-server/tests/principal-routes.test.ts:380-397`)

**B — Corpus transport and CLI errors.**

- `places flags before -- and a --prefixed search query after it` ([source](../packages/ui-server/tests/brain-client.test.ts)), (`places flags before -- and a --prefixed search query after it`, `packages/ui-server/tests/brain-client.test.ts:114-138`)
- `HTTP search deadlines return 504 and reap the stalled process` ([source](../packages/ui-server/tests/brain-client.test.ts)), (`HTTP search deadlines return 504 and reap the stalled process`, `packages/ui-server/tests/brain-client.test.ts:201-211`)
- `a stats embeddings count the CLI could not take reaches the HTTP body as null, not 0` ([source](../packages/ui-server/tests/brain-client.test.ts)), (`a stats embeddings count the CLI could not take reaches the HTTP body as null, not 0`, `packages/ui-server/tests/brain-client.test.ts:57-83`)
- ``stats history runs `brain stats --history` and the route passes its nulls through`` ([source](../packages/ui-server/tests/brain-client.test.ts)), (``stats history runs `brain stats --history` and the route passes its nulls through``, `packages/ui-server/tests/brain-client.test.ts:85-112`)
- `mounted corpus handlers preserve CLI failures and sync terminates with an unsuccessful SSE frame` ([source](../packages/ui-server/tests/http-cli-errors.test.ts)), (`mounted corpus handlers preserve CLI failures and sync terminates with an unsuccessful SSE frame`, `packages/ui-server/tests/http-cli-errors.test.ts:7-37`)

**C — Capture and index recovery.**

- `capture keeps partial success and retry runs only index through the actual CLI adapter` ([source](../packages/ui-server/tests/capture-outcome.test.ts)), (`capture keeps partial success and retry runs only index through the actual CLI adapter`, `packages/ui-server/tests/capture-outcome.test.ts:8-35`)
- `mounted capture rejects incorrect JSON media, oversized bytes and missing content without invoking add` ([source](../packages/ui-server/tests/http-validation.test.ts)), (`mounted capture rejects incorrect JSON media, oversized bytes and missing content without invoking add`, `packages/ui-server/tests/http-validation.test.ts:6-28`)

**Y — Sync reservation.**

- `reserves canonical roots across routes and disconnects, and releases after exit` ([source](../packages/ui-server/tests/sync-reservation.test.ts)), (`reserves canonical roots across routes and disconnects, and releases after exit`, `packages/ui-server/tests/sync-reservation.test.ts:18-61`)
- `startup failure releases the reservation for a retry` ([source](../packages/ui-server/tests/sync-reservation.test.ts)), (`startup failure releases the reservation for a retry`, `packages/ui-server/tests/sync-reservation.test.ts:63-75`)

**V — Mounted validation.**

- `mounted input validation returns route-specific errors for corpus, files, geometry and hidden models` ([source](../packages/ui-server/tests/http-validation.test.ts)), (`mounted input validation returns route-specific errors for corpus, files, geometry and hidden models`, `packages/ui-server/tests/http-validation.test.ts:30-46`)

**F — Content and byte ranges.**

- `an uncompressed, all-ASCII PDF is served as binary, not as its source` ([source](../packages/ui-server/tests/files-walker.test.ts)), (`an uncompressed, all-ASCII PDF is served as binary, not as its source`, `packages/ui-server/tests/files-walker.test.ts:204-210`)
- `rejects file_too_large` ([source](../packages/ui-server/tests/files-walker.test.ts)), (`rejects file_too_large`, `packages/ui-server/tests/files-walker.test.ts:229-234`)
- `rejects symlink escape` ([source](../packages/ui-server/tests/files-walker.test.ts)), (`rejects symlink escape`, `packages/ui-server/tests/files-walker.test.ts:96-98`)
- `a child of an existing file is not found without leaking its absolute path` ([source](../packages/ui-server/tests/files-walker.test.ts)), (`a child of an existing file is not found without leaking its absolute path`, `packages/ui-server/tests/files-walker.test.ts:240-253`)
- `Safari's two-byte probe gets a 206 with its length, and the frame headers` ([source](../packages/ui-server/tests/files-raw-range.test.ts)), (`Safari's two-byte probe gets a 206 with its length, and the frame headers`, `packages/ui-server/tests/files-raw-range.test.ts:222-231`)
- `a range that starts past the end is a 416 naming the size` ([source](../packages/ui-server/tests/files-raw-range.test.ts)), (`a range that starts past the end is a 416 naming the size`, `packages/ui-server/tests/files-raw-range.test.ts:87-92`)
- `a HEAD request ignores Range, which applies to GET only` ([source](../packages/ui-server/tests/files-raw-range.test.ts)), (`a HEAD request ignores Range, which applies to GET only`, `packages/ui-server/tests/files-raw-range.test.ts:102-107`)

**R — Activity reads and accounting.**

- `runs list splits live and history, newest first, with filters` ([source](../packages/ui-server/tests/routes-activity.test.ts)), (`runs list splits live and history, newest first, with filters`, `packages/ui-server/tests/routes-activity.test.ts:76-99`)
- `run detail omits tool payload events unless ?include=payloads asks` ([source](../packages/ui-server/tests/routes-activity.test.ts)), (`run detail omits tool payload events unless ?include=payloads asks`, `packages/ui-server/tests/routes-activity.test.ts:113-143`)
- `a pruned run resolves to its rollup; an unknown id 404s (R26)` ([source](../packages/ui-server/tests/routes-activity.test.ts)), (`a pruned run resolves to its rollup; an unknown id 404s (R26)`, `packages/ui-server/tests/routes-activity.test.ts:145-171`)
- `rollups aggregate per day/job/session from root accounting, in the configured zone` ([source](../packages/ui-server/tests/routes-activity.test.ts)), (`rollups aggregate per day/job/session from root accounting, in the configured zone`, `packages/ui-server/tests/routes-activity.test.ts:173-192`)
- `rollups route sums only priced runs and counts the NULLs at every group (AE3)` ([source](../packages/ui-server/tests/routes-activity.test.ts)), (`rollups route sums only priced runs and counts the NULLs at every group (AE3)`, `packages/ui-server/tests/routes-activity.test.ts:304-324`)
- `GET /activity/stats serves the figures; days defaults to 30 and is clamped to 1..90` ([source](../packages/ui-server/tests/activity-stats.test.ts)), (`GET /activity/stats serves the figures; days defaults to 30 and is clamped to 1..90`, `packages/ui-server/tests/activity-stats.test.ts:497-529`)

The six named `GROUP AXIS rounds the completed multi-run sum to four decimals`
cases cover days/jobs/sessions and costUsd/effectiveCostUsd separately
(`rounds the completed multi-run sum`, `packages/ui-server/tests/activity-rollup-rounding.test.ts:86-96`).
`storage, run detail and stats retain the same fixture's original precision`
checks that rounding remains at the response boundary
(`storage, run detail and stats retain the same fixture's original precision`,
`packages/ui-server/tests/activity-rollup-rounding.test.ts:98-122`).
`rounding preserves all counters and known-zero versus unknown effective costs`
checks both nonempty priced and mixed-knownness fixtures
(`rounding preserves all counters and known-zero versus unknown effective costs`,
`packages/ui-server/tests/activity-rollup-rounding.test.ts:124-164`).

**I — Local poke.**

- `separate server processes rotate boot authorization and recover the persisted lease` ([source](../packages/ui-server/tests/inbox-runtime.test.ts)), (`separate server processes rotate boot authorization and recover the persisted lease`, `packages/ui-server/tests/inbox-runtime.test.ts:247-266`)
- `unconfigured poke is unavailable and invalid runtime provisioning refuses boot` ([source](../packages/ui-server/tests/inbox-runtime.test.ts)), (`unconfigured poke is unavailable and invalid runtime provisioning refuses boot`, `packages/ui-server/tests/inbox-runtime.test.ts:325-331`)

**M — Model roster and discovery.**

- `PUT /models/hidden persists the set and drops it from the picker` ([source](../packages/ui-server/tests/models-routes.test.ts)), (`PUT /models/hidden persists the set and drops it from the picker`, `packages/ui-server/tests/models-routes.test.ts:92-114`)
- `a hidden profile still resolves for sessions pinned to it` ([source](../packages/ui-server/tests/models-routes.test.ts)), (`a hidden profile still resolves for sessions pinned to it`, `packages/ui-server/tests/models-routes.test.ts:116-127`)
- `PUT /models/hidden rejects a malformed body` ([source](../packages/ui-server/tests/models-routes.test.ts)), (`PUT /models/hidden rejects a malformed body`, `packages/ui-server/tests/models-routes.test.ts:148-158`)
- `POST /models/refresh answers 409 when the backend has no discovery` ([source](../packages/ui-server/tests/models-routes.test.ts)), (`POST /models/refresh answers 409 when the backend has no discovery`, `packages/ui-server/tests/models-routes.test.ts:160-165`)
- `mounted model refresh updates the roster and keeps the last nonempty roster on discovery failure` ([source](../packages/ui-server/tests/http-discovery-voice.test.ts)), (`mounted model refresh updates the roster and keeps the last nonempty roster on discovery failure`, `packages/ui-server/tests/http-discovery-voice.test.ts:10-59`)

**S — Session ownership and partial availability.**

- `GET /sessions unions, tags, and globally sorts backend sessions` ([source](../packages/ui-server/tests/session-routes-multi-backend.test.ts)), (`GET /sessions unions, tags, and globally sorts backend sessions`, `packages/ui-server/tests/session-routes-multi-backend.test.ts:37-77`)
- `keeps healthy histories when another backend throws, and recovers on retry` ([source](../packages/ui-server/tests/session-routes-multi-backend.test.ts)), (`keeps healthy histories when another backend throws, and recovers on retry`, `packages/ui-server/tests/session-routes-multi-backend.test.ts:79-91`)
- `bounds stalled backends and coalesces scans across concurrent requests` ([source](../packages/ui-server/tests/session-routes-multi-backend.test.ts)), (`bounds stalled backends and coalesces scans across concurrent requests`, `packages/ui-server/tests/session-routes-multi-backend.test.ts:93-110`)
- `GET /sessions/:id reads history from the persisted owner backend` ([source](../packages/ui-server/tests/session-routes-multi-backend.test.ts)), (`GET /sessions/:id reads history from the persisted owner backend`, `packages/ui-server/tests/session-routes-multi-backend.test.ts:112-144`)

**U — Push ownership and SDK renewal.**

- `SDK push renewal reaches the mounted subscribe handler and retains principal isolation` ([source](../packages/ui-server/tests/http-principal-boundaries.test.ts)), (`SDK push renewal reaches the mounted subscribe handler and retains principal isolation`, `packages/ui-server/tests/http-principal-boundaries.test.ts:78-133`)
- `the public key is served; the private key has no route anywhere` ([source](../packages/ui-server/tests/push.test.ts)), (`the public key is served; the private key has no route anywhere`, `packages/ui-server/tests/push.test.ts:312-321`)
- `a malformed subscription is a 400, not a crash` ([source](../packages/ui-server/tests/push.test.ts)), (`a malformed subscription is a 400, not a crash`, `packages/ui-server/tests/push.test.ts:323-332`)

**Q — Authenticated intake.**

- `real CLI queues trusted work, survives a lost response and rejects wrong, revoked or mismatched credentials` ([source](../packages/ui-server/tests/inbox-intake.test.ts)), (`real CLI queues trusted work, survives a lost response and rejects wrong, revoked or mismatched credentials`, `packages/ui-server/tests/inbox-intake.test.ts:206-267`)
- `authority overrides are rejected by both mounted endpoints` ([source](../packages/ui-server/tests/inbox-intake.test.ts)), (`authority overrides are rejected by both mounted endpoints`, `packages/ui-server/tests/inbox-intake.test.ts:157-165`)
- `revocation while the mounted route awaits its body prevents intake` ([source](../packages/ui-server/tests/inbox-intake.test.ts)), (`revocation while the mounted route awaits its body prevents intake`, `packages/ui-server/tests/inbox-intake.test.ts:177-195`)

**K — Scheduled tasks.**

- `the operator reviews and approves on a terminal; the host record and file agree; replay is idempotent` ([source](../packages/ui-server/tests/schedule-cli.test.ts)), (`the operator reviews and approves on a terminal; the host record and file agree; replay is idempotent`, `packages/ui-server/tests/schedule-cli.test.ts:94-112`)
- `no TTY or no affirmative answer means no grant` ([source](../packages/ui-server/tests/schedule-cli.test.ts)), (`no TTY or no affirmative answer means no grant`, `packages/ui-server/tests/schedule-cli.test.ts:114-122`)
- `a delegated credential proposes, cannot self-approve, and publishes after operator approval` ([source](../packages/ui-server/tests/schedule-cli.test.ts)), (`a delegated credential proposes, cannot self-approve, and publishes after operator approval`, `packages/ui-server/tests/schedule-cli.test.ts:124-141`)
- `cancel and due report exact envelopes and exit codes` ([source](../packages/ui-server/tests/schedule-cli.test.ts)), (`cancel and due report exact envelopes and exit codes`, `packages/ui-server/tests/schedule-cli.test.ts:143-160`)
- `unavailable, redirecting and malformed hosts exit 2 and never follow a redirect` ([source](../packages/ui-server/tests/schedule-cli.test.ts)), (`unavailable, redirecting and malformed hosts exit 2 and never follow a redirect`, `packages/ui-server/tests/schedule-cli.test.ts:185-202`)
- `matched receipts replay before clock checks; changed payloads conflict; expired proposals need a new key` ([source](../packages/ui-server/tests/schedule-service.test.ts)), (`matched receipts replay before clock checks; changed payloads conflict; expired proposals need a new key`, `packages/ui-server/tests/schedule-service.test.ts:73-93`)
- `the host refuses unsupported, broader or authority-bearing scope` ([source](../packages/ui-server/tests/schedule-service.test.ts)), (`the host refuses unsupported, broader or authority-bearing scope`, `packages/ui-server/tests/schedule-service.test.ts:117-151`)
- `list and due pages are bounded, ordered and use host-signed cursors bound to their query` ([source](../packages/ui-server/tests/schedule-service.test.ts)), (`list and due pages are bounded, ordered and use host-signed cursors bound to their query`, `packages/ui-server/tests/schedule-service.test.ts:260-288`)
- `interrupted publication fails closed, then reconciles to one published definition on retry or restart` ([source](../packages/ui-server/tests/schedule-service.test.ts)), (`interrupted publication fails closed, then reconciles to one published definition on retry or restart`, `packages/ui-server/tests/schedule-service.test.ts:290-310`)
- `edited, missing or symlinked definitions quarantine dispatch without rewriting the file` ([source](../packages/ui-server/tests/schedule-service.test.ts)), (`edited, missing or symlinked definitions quarantine dispatch without rewriting the file`, `packages/ui-server/tests/schedule-service.test.ts:329-356`)

**J — Confirmed share intake.**

- `mounted share replay creates one untrusted thread, triage item and staging area` ([source](../packages/ui-server/tests/inbox-intake.test.ts)), (`mounted share replay creates one untrusted thread, triage item and staging area`, `packages/ui-server/tests/inbox-intake.test.ts:40-60`)
- `stages files under the staging dir with their bytes intact` ([source](../packages/ui-server/tests/share-routes.test.ts)), (`stages files under the staging dir with their bytes intact`, `packages/ui-server/tests/share-routes.test.ts:78-96`)
- `a body with no content-length is still capped while streaming` ([source](../packages/ui-server/tests/share-routes.test.ts)), (`a body with no content-length is still capped while streaming`, `packages/ui-server/tests/share-routes.test.ts:193-221`)
- `too many files is refused with the limit` ([source](../packages/ui-server/tests/share-routes.test.ts)), (`too many files is refused with the limit`, `packages/ui-server/tests/share-routes.test.ts:164-177`)
- `counts overlapping uploads before their first body-read await` ([source](../packages/ui-server/tests/share-routes.test.ts)), (`counts overlapping uploads before their first body-read await`, `packages/ui-server/tests/share-routes.test.ts:265-332`)
- `staging followed by a database failure rolls back work and compensates files before retry` ([source](../packages/ui-server/tests/inbox-intake.test.ts)), (`staging followed by a database failure rolls back work and compensates files before retry`, `packages/ui-server/tests/inbox-intake.test.ts:120-136`)

**L — Share-target fallback and interception.**

- `share-target network fallback leaves the cross-site request body unread before authentication` ([source](../packages/ui-server/tests/http-principal-boundaries.test.ts)), (`share-target network fallback leaves the cross-site request body unread before authentication`, `packages/ui-server/tests/http-principal-boundaries.test.ts:135-145`)
- `stashes a text share and redirects with its id` ([source](../packages/ui-sdk/tests/share-target.test.ts)), (`stashes a text share and redirects with its id`, `packages/ui-sdk/tests/share-target.test.ts:57-79`)
- `respondWith is called synchronously with the event` ([source](../packages/ui-sdk/tests/share-target.test.ts)), (`respondWith is called synchronously with the event`, `packages/ui-sdk/tests/share-target.test.ts:372-392`)

**E — Rendering.**

- `mounted renderer validates input and returns configured PNG/PDF bytes with protected headers` ([source](../packages/ui-server/tests/http-validation.test.ts)), (`mounted renderer validates input and returns configured PNG/PDF bytes with protected headers`, `packages/ui-server/tests/http-validation.test.ts:48-77`)
- `rejects a multibyte body over 5 MB even when its UTF-16 length is under the cap` ([source](../packages/ui-server/tests/render-routes.test.ts)), (`rejects a multibyte body over 5 MB even when its UTF-16 length is under the cap`, `packages/ui-server/tests/render-routes.test.ts:7-41`)

**G — Geometry validation and degradation.**

- `rejects a bad bbox before reaching the network` ([source](../packages/ui-server/tests/geo-route.test.ts)), (`rejects a bad bbox before reaching the network`, `packages/ui-server/tests/geo-route.test.ts:141-147`)
- `fetches once, then serves from disk` ([source](../packages/ui-server/tests/geo-route.test.ts)), (`fetches once, then serves from disk`, `packages/ui-server/tests/geo-route.test.ts:149-164`)
- `an outage is not cached, so it does not become permanent` ([source](../packages/ui-server/tests/geo-route.test.ts)), (`an outage is not cached, so it does not become permanent`, `packages/ui-server/tests/geo-route.test.ts:188-203`)
- `every response carries the attribution, including the empty ones` ([source](../packages/ui-server/tests/geo-route.test.ts)), (`every response carries the attribution, including the empty ones`, `packages/ui-server/tests/geo-route.test.ts:228-236`)
- `a view can force a finer tier than its size suggests` ([source](../packages/ui-server/tests/geo-route.test.ts)), (`a view can force a finer tier than its size suggests`, `packages/ui-server/tests/geo-route.test.ts:263-270`)

**N — Speech grants.**

- `mounted voice session and legacy token use only short-lived injected grants and preserve failures` ([source](../packages/ui-server/tests/http-discovery-voice.test.ts)), (`mounted voice session and legacy token use only short-lived injected grants and preserve failures`, `packages/ui-server/tests/http-discovery-voice.test.ts:61-102`)

**W — WebSocket admission.**

- `real WebSocket admission rejects origin, authentication and capacity before upgrading` ([source](../packages/ui-server/tests/http-websocket-admission.test.ts)), (`real WebSocket admission rejects origin, authentication and capacity before upgrading`, `packages/ui-server/tests/http-websocket-admission.test.ts:56-87`)

**Z — Object-only validation and retained defaults.**

The following mounted checks each run for null, array, string, number and boolean
JSON, using successful owner login/capture and populated credential stores:

- `password login rejects NAME with a JSON client error`
  (`password login rejects`, `packages/ui-server/tests/http-object-bodies.test.ts:114-120`).
- `owner passkey registration rejects NAME before storing a credential`
  (`owner passkey registration rejects`, `packages/ui-server/tests/http-object-bodies.test.ts:122-130`).
- `owner passkey rename rejects NAME without clearing its label`
  (`owner passkey rename rejects`, `packages/ui-server/tests/http-object-bodies.test.ts:132-138`).
- `capture rejects NAME before CLI dispatch or content writes`
  (`capture rejects`, `packages/ui-server/tests/http-object-bodies.test.ts:140-153`).

`capture refuses %s before CLI dispatch` checks malformed JSON and invalid
content/type/title/tags with nonempty CLI and file observations
(`capture refuses`, `packages/ui-server/tests/http-object-bodies.test.ts:164-175`).
`valid rename objects retain normalization and omitted-label clearing`
preserves the management default
(`valid rename objects retain normalization and omitted-label clearing`,
`packages/ui-server/tests/http-object-bodies.test.ts:189-196`).
`valid capture fields reach the actual CLI adapter unchanged` and
`empty optional capture values retain CLI defaults` preserve valid inputs
(`valid capture fields reach the actual CLI adapter unchanged`,
`packages/ui-server/tests/http-object-bodies.test.ts:198-207`),
(`empty optional capture values retain CLI defaults`,
`packages/ui-server/tests/http-object-bodies.test.ts:209-216`).

The mounted voice keyterm and pronunciation reads assert nonempty cached
values in their individual receipt tests. Speech grant checks exercise both
successful short-lived tokens and provider refusal through an injected HTTP
transport; they never call a speech service.

## Inventory, middleware and internal paths

- `real app method/path inventory equals the complete classified HTTP specification` ([source](../packages/ui-server/tests/http-inventory.test.ts)), (`real app method/path inventory equals the complete classified HTTP specification`, `packages/ui-server/tests/http-inventory.test.ts:7-28`)
- `implicit HEAD preserves every ordinary GET handler's status and headers while suppressing its body` ([source](../packages/ui-server/tests/http-inventory.test.ts)), (`implicit HEAD preserves every ordinary GET handler's status and headers while suppressing its body`, `packages/ui-server/tests/http-inventory.test.ts:30-45`)
- `configured CORS preflight runs before authentication and refuses unapproved origins` ([source](../packages/ui-server/tests/http-inventory.test.ts)), (`configured CORS preflight runs before authentication and refuses unapproved origins`, `packages/ui-server/tests/http-inventory.test.ts:47-67`)
- `conditional SPA fallback serves deep links, preserves API precedence and reports a missing index` ([source](../packages/ui-server/tests/http-inventory.test.ts)), (`conditional SPA fallback serves deep links, preserves API precedence and reports a missing index`, `packages/ui-server/tests/http-inventory.test.ts:69-83`)
- `conditional static middleware serves existing assets before the SPA fallback` ([source](../packages/ui-server/tests/http-inventory.test.ts)), (`conditional static middleware serves existing assets before the SPA fallback`, `packages/ui-server/tests/http-inventory.test.ts:85-93`)

The classified table contains 97 declared endpoints (49 supported and 48
internal) and one conditional internal SPA fallback. Exact runtime equality
rejects an undocumented handler. Wildcard middleware is counted separately:
global security/observability, `/api` origin/CORS/authentication, owner guards,
poke method refusal and conditional static assets. HEAD dispatch suppresses
the body; configured OPTIONS preflight is tested before authentication, with
unconfigured and denied-origin controls.

The `mounted internal router: GET PATH` tests reach pi-auth, web-search,
tool-permissions, skills, graph and vpn-check through the real app and require
successful JSON responses (`mounted internal router:`,
`packages/ui-server/tests/http-internal-mounts.test.ts:8-17`). The inventory
accounts for every other internal method/path without making a raw payload
compatibility promise.


The module Settings router has a mounted real-CLI check in
[module-settings-http.test.ts](../packages/ui-server/tests/module-settings-http.test.ts).
It verifies live delegated-principal reads and saves, schema errors, revisions,
revocation, the saved-settings action and exact commit paths. Draft preview is
read-only; module state and migration remain separate transactions. These
editor routes are classified internal, while the module CLI and JSON source
formats retain their integration guarantees.

## Mutation evidence and limits

The baseline coverage [PR #803](https://github.com/schlessera/brain-kit/pull/803)
records handler removals across its 28 mounted router
and direct-handler families, plus unclassified-route, validation, owner,
static-middleware, SDK renewal, unread-body, discovery-failure, short-lived-token
and WebSocket scheme mutations. Each receipt identifies the runtime assertion
that failed and restores the source afterward. Status and WebSocket controls
also demonstrate that the previous guard-only/HTTP-status tests can remain
green with those handlers removed.

The separate gaps recorded in the specification remain authoritative:
[#702](https://github.com/schlessera/brain-kit/issues/702) covers nullable CLI
tags, and [#693](https://github.com/schlessera/brain-kit/issues/693) covers public
React health/sync helpers. The delivered #692 rounding and #694 object-validation
repairs are covered by R and Z. A nonempty 0.5 rollup fixture alone proves that
the mounted aggregate reads stored accounting; R's higher-precision fixtures
provide the distinct rounding evidence. This coverage does not redefine those
promises or claim implementation of the separately delivered repairs.

The imported-track internal transports have successful real-app mounting checks
in [http-internal-mounts.test.ts](../packages/ui-server/tests/http-internal-mounts.test.ts):
`mounted internal track handler: POST /api/track-upload` and
`mounted internal track handler: GET /api/tracks`. Both observe nonempty canonical
track measurements and unchanged original bytes; the composer transport creates
no inbox thread. Detailed parser/intake/containment checks live in
[track-intake.test.ts](../packages/ui-server/tests/track-intake.test.ts).

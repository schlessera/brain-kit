# Queue drain and internal poke

The UI server owns a concrete Queue lifecycle in its operational database,
alongside [the durable store](inbox-storage.md). A 60-second interval and the
server's close lifecycle own it; it needs no separate listener or daemon.
Markdown remains content authority and this runtime never opens `brain.db`.

## Recovery and claims

Boot and each drain pass reconcile reserved cost before releasing expired
leases into bounded retry backoff. Exhausted attempts remain `failed` and
produce one stable dead-letter Action. A persisted `inbox-drain` scheduler
heartbeat records the pass time and committed change cursor. Recovery does
not reset attempts, grant authority or create an Activity run. Due snoozes,
scheduled work, expiry and staging compensation use deterministic maintenance
from [the Action engine](inbox-actions.md).

A pass counts due, unexpired `ready` Queue items below their attempt limit.
An empty set creates zero model calls and zero Activity runs. Claims select
and transition under `BEGIN IMMEDIATE`; each receives a ten-minute lease.
Selection uses the store's current priority order. Work runs after the claim
transaction ends, and each pass is bounded by its initial eligible count.
The engine owns checkpointing, completion and accounting. Explicit dispatch
failure releases its claim into backoff and reconciles its reservation; a
killed process leaves a lease for recovery. Cleanup runs outside SQLite,
without a model reservation, and never silently marks unfinished work done.
Tick and poke share one in-flight guard, including synchronous reentry.
Close cancels the interval, aborts the internal dispatcher signal and waits
for the active pass before the app closes SQLite.

`createApp` installs no production model dispatcher. It updates heartbeats,
recovers leases and reconciles cleanup, while leaving nonempty model work
unclaimed. Internal
tests use a deterministic dispatcher to prove claims and lifecycle behavior.
Production execution requires the containment, budgets, admission and complete
system gates in [the async-collaboration decision](decisions/async-collaboration.md)
and its implementation issues. This runtime does not select a tool profile,
backend, credential or model, or make an inference call.

## Runtime token file

Set `BRAIN_UI_INBOX_POKE_TOKEN_FILE` to an absolute file path in a private
runtime directory dedicated to this app instance, conventionally
`/run/brain-ui/inbox-poke.token`. The generated host provisions that directory
and access for the server and its local cron caller. An absent value leaves
the poke unavailable; it does not disable the lifecycle interval or enable
dispatch. Relative paths or an unwritable destination refuse app boot before
opening its operational database.

Every configured app boot mints 32 random bytes, encoded as 64 lowercase hex
characters plus a newline. The server writes and syncs an exclusive temporary
file with mode `0600`, then atomically renames it over the destination.
Replacing an existing symlink replaces the link, without writing its target.
Failed publication removes the temporary file and refuses boot. The token is
never a response, a query parameter, a log value or a committed secret.

The caller reads the current file for each request and sends its trimmed
contents as the bearer token. Restart rotates the value; the previous value
is refused by the new app. Shutdown leaves the runtime file for the next boot
to replace; it does not make a closed app accept requests. Two live app
instances must use separate token files. Runtime-file provisioning and the
five-minute cron backstop belong to the public hosting template counterpart,
not a production installation described in this repository.

## Supported HTTP operation

`POST /api/internal/inbox/poke` is registered before general API authentication
on the existing listener. It requires both `Authorization: Bearer <token>`
and an actual loopback socket address. IPv4 loopback, IPv6 loopback and
IPv4-mapped loopback are accepted. Unavailable socket information fails closed.
`TRUST_PROXY`, `X-Forwarded-For` and `X-Real-IP` never affect this check. A valid
token alone cannot authorize a nonlocal socket. Origin policy and response
security headers still apply; no cookie or proxy identity is required in any
authentication mode. Ordinary APIs retain their existing authentication.

No body is required or consumed. Success is HTTP 200 with:

```json
{
  "ok": true,
  "rearmed": false,
  "busy": false,
  "claimed": 0,
  "recovered": 0,
  "dispatchEnabled": false
}
```

`rearmed` reports replacement of the interval when the persisted heartbeat is
missing or at least 180 seconds old. The same request runs one drain pass;
`busy: true` means a pass is already in flight and this request claims nothing.
`claimed` and `recovered` count this pass's transitions. `dispatchEnabled` is
false for the shipped app wiring. No counter describes a model run or grants
permission to start one.

Errors are JSON `{ "error": "<code>" }`: HTTP 403
`inbox_poke_forbidden` for missing, malformed, wrong or stale authorization,
or a nonlocal/unavailable socket; HTTP 503 `inbox_poke_unconfigured` without
runtime-file configuration; HTTP 503 `inbox_runtime_closed` after closure;
and HTTP 503 `inbox_drain_failed` when storage/recovery fails. Other methods
receive HTTP 405 `method_not_allowed` and `Allow: POST`. Existing origin
rejections remain HTTP 403 `cross_origin_rejected`. Clients tolerate unknown
success fields under the [HTTP contract](http-api.md).

A poke can repair a stopped interval in a live process. It cannot reach a dead
process or blocked event loop: supervisor health and restart are the generated
host's responsibility. Socket tests exercise the real mounted success path in
all four auth modes, actual non-loopback refusals with forged forwarding
headers, boot rotation and persisted lease recovery. Two processes exercise
one-winner claims and heartbeat contention under the existing five-second
SQLite busy timeout; the database transaction covers no model/filesystem work.

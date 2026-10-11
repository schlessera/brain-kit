# Queue drain and internal poke

The UI server owns a concrete Queue lifecycle in its operational database,
alongside [the durable store](inbox-storage.md). A 60-second interval and the
server's close lifecycle own it; it needs no separate listener or daemon.
Markdown remains content authority and this runtime never opens `brain.db`.

## Recovery and claims

A pending [operational restore](inbox-recovery.md) refuses app boot and drain
startup. Restore completes staging and reconciles the lost workers' reservations
and claims atomically before allowing normal lifecycle work.

Boot and each drain pass reconcile reserved cost before releasing expired
leases into bounded retry backoff. Exhausted attempts remain `failed` and
produce one stable dead-letter Action. A persisted `inbox-drain` scheduler
heartbeat records the pass time and committed change cursor. Recovery does
not reset attempts, grant authority or create an Activity run. Due snoozes,
scheduled work, expiry and staging compensation use deterministic maintenance
from [the Action engine](inbox-actions.md).

An expired lease remains claimed while its backend actually runs. Each acquired
attempt holds a kernel SQLite lock in a disposable file under the operational
database's sibling `<database>.inbox-live/` directory. These locks span backend
unwind without holding the operational database's write transaction. Process
death releases ownership even when an open Activity root or old lock file
remains, allowing conservative accounting and bounded lease recovery. Normal
completion and staging compensation reap disposable files; operational backups
do not copy a source worker's ownership.

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
unclaimed. No configuration key, environment variable or default changes
that. Production execution requires the containment, budgets, admission and
complete system gates in [the async-collaboration decision](decisions/async-collaboration.md),
the generated host's glue and the reserved verification on #689. This runtime
itself does not select a tool profile, backend, credential or model.

## The production dispatcher (gated)

The dispatcher (`createInboxDispatcher`, `packages/ui-server/src/inbox/dispatcher.ts`)
composes the shipped engines into one lifecycle and adds no seam. Each drain
pass first routes ready, unrouted arrivals through [bounded triage](inbox-triage.md),
grouped by each arrival's authenticated intake principal. It then claims, in
priority order, triage items routed `rule` or `needs_agent` and validated
follow-ups. Scheduled work is left to its own admission. A server-selected
backend, profile and admission bound apply to the pass; without one, nothing
is claimed.

Every claimed attempt runs one restricted autonomous turn (#676). The roster
is the backend's read tools plus the hosted application tools; the
application route auto-allows nothing. An agent-tier turn's proposal of an
exact Markdown change becomes a [durable decision](inbox-actions.md): the
checkpoint, an Action whose `apply` option carries that exact operation (with
`dismiss` beside it, the one-commit shape the Actions card renders), and the
blocked item commit together, and nothing is written. Questions become
choice options; any other out-of-roster call becomes a decision that can only
be cancelled. A follow-up minted from a resolution runs with its read tools
and the one approved tool. It may apply exactly the approved tool, input and
target once. Any other proposal, including a second application of the same
change, escalates as a new decision and writes nothing.

The operation envelope is server code (`inboxOperationAllowed`,
`packages/ui-server/src/inbox/envelope.ts`): one non-destructive single-file
application (`write`, `edit`, `add` or `update` without archiving), a schema-valid
input of at most 64 KiB, and a `.md` target named by that input outside
`context/policies/` and every dot directory. It is checked when the decision
is created, at resolution and again before the follow-up runs. A principal that
is no longer usable, a missing selection or an operation outside the envelope
fails the claim into backoff before any runtime starts. Success completes the
item and journals staging cleanup; a failure releases it into bounded retry.

Only the repository's fixture host activates the dispatcher in `createApp`,
through a symbol that no package entry point exports. Its tests drive the
supported interfaces the generated host will use: authenticated intake, the
token-file poke below, WebSocket resolution and process restart. The recovery
proof runs the app as a supervised process and SIGKILLs it after a claim,
after an escalation checkpoint, after an approved write and between staging
removal and its acknowledgement. Each restart keeps
the attempt's charge, keeps the pending decision exactly once, and refuses
replay of the applied write through its changed base. Restoring the daily
`brain-ui-inbox export` into an empty installation returns the pending decision
with its spend and trust, and it resolves to one effect. Staging lost after a restore
blocks its arrival behind a visible review decision; no agent turn runs. A fixture clock stands
in for elapsed lease and backoff time; production uses the system clock.

`tests/autonomous-app.test.ts` runs the same app with each installed
first-party runtime in its restricted envelope, offline. A share arrives
through the share target. The cron poke routes it, the agent tier runs behind
the inference relay, two WebSocket devices resolve the decision, and the
follow-up applies once. A hostile share drives the model to read host secrets,
write the crew policy and run a shell payload that calls home. No secret
reaches a model request, the policy bytes and host listener are untouched, and
each attempt ends as a cancel-only decision.
`packages/ui-react/tests/browser/dispatch-actions.layout.tsx` drives the same
decision from two real Chromium pages rendering the Actions page over the
app's WebSocket: one resolution, one follow-up, an exact receipt on each
device, and one applied write.

`packages/ui-server/tests/inbox-dispatch-ae.test.ts` composes the design's
acceptance examples through the dispatcher: AE1–AE5, AE7–AE9 and AE11–AE15.
AE6 and AE10 are deferred to v2. An arrival that T1 cannot route, for
example without a classification key, stays queued until it expires; the
agent tier never runs unrouted work. Intake assigns stakes 1 and no deadline,
which stays below the push cutoff of 12. Under the 2026-10-11 ruling on #1553,
the dispatcher marks decisions that block autonomous work as push-eligible
regardless of score. They use the existing fixed window, quiet hours and
aggregate payload; ordinary unmarked decisions remain digest-only below 12.

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
SQLite busy timeout; the database transaction covers no model call or staging removal.

## Enablement evidence — checked 2026-10-11, sources only

This records the provider facts that enablement depends on, as published on
2026-10-11. No paid or real-provider call was made. Re-check every entry when
enabling; none of it is a measurement, and the historical eval results stay
historical.

- **T1 classification.** The [TypeSafe model list](https://docs.typesafe.ai/models)
  lists `jev-1.13.0` under current models (`jev-latest` and `jev-preview`
  alias it): text input only, 64k tokens per request with 32k for `state` plus
  the longest question, $0.042 per million input tokens and free output. It
  documents no effort setting. The bundled price snapshot carries the same
  input rate. The pin, bounds and the [classifier decision](decisions/triage-classifier.md)
  are unchanged.
- **Historical T1 candidates.** The design's earlier generative candidates
  stay evidence only. `gpt-5.6-luna` is listed by [OpenAI](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
  with reasoning effort `none` to `max` (default `medium`; the recorded `high`
  setting exists) at $0.20 / $1.20 per million input/output tokens.
  `claude-sonnet-4-6` is a legacy Claude model, still active, with retirement
  not sooner than February 17, 2027. It supports `low` effort (the recorded
  setting) and costs $3 / $15 per million input/output tokens
  ([models](https://platform.claude.com/docs/en/about-claude/models/overview),
  [deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations),
  [effort](https://platform.claude.com/docs/en/build-with-claude/effort),
  [pricing](https://platform.claude.com/docs/en/about-claude/pricing)).
  `claude-sonnet-5`, the original planned default, failed the gate and is not
  restored. None of these has passed the gate on current evidence; enabling
  one needs a separately authorized run of the U18 harness.
- **Agent tier.** The dispatcher uses whatever Claude or pi profile the server
  selects. The current Claude API lineup is `claude-fable-5-1` ($10 / $50),
  `claude-opus-5-5` ($4 / $20, default effort `medium`), `claude-sonnet-5-5`
  ($2 / $10) and `claude-haiku-5-5` (from $0.10 / $0.50), all active. The
  [bundled price snapshot](../packages/ui-server/data/README.md) includes these
  models and `claude-sonnet-4-6` at provider base rates checked on 2026-10-11.
  Before a remote catalog is cached, those rates resolve as offline estimates.
  Haiku 5.5's base tier covers prompts up to 100,000 tokens; longer-context
  tiers are outside v1 price resolution. An unresolved model still uses the
  pessimistic unpriced rate and raises one suppressed pricing Action.
  Subscription billing counts turns and no dollars.
- **Cache.** Prompt-cache savings remain unclaimed (see the
  [prompt cache guide](hosting/autonomous-prompt-cache.md)).

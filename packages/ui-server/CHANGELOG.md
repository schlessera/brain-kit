# @schlessera/brain-ui-server

## 0.23.0

### Minor Changes

- 472a2d0: Sign in to pi model providers from Settings — no shell on the host needed.

  - `@schlessera/brain-backend-pi` exports `createPiAuth()`: a headless OAuth
    service over pi's `ModelRuntime.login` that answers the method prompt with
    the device-code flow (the browser flow would bind a callback port on the
    server), captures the user code from the auth event stream, and exposes a
    start/poll/cancel/logout surface. Credentials persist through pi's own
    locked store (`~/.pi/agent/auth.json`, `PI_CODING_AGENT_DIR` aware), so a
    login is immediately visible to the chat backend.
  - ui-server mounts `/api/pi-auth/*` behind the auth guard, lazily loading the
    optional pi package; provider ids are validated against the configured
    roster's vendors, and the endpoints report an empty provider list when pi
    is not in play.
  - Settings → Models grows an **Accounts** section (hidden on Claude-only
    deployments): Connect shows the device code and verification link, polls to
    completion, and Disconnect removes the stored credential. This is the
    intended path for connecting OpenAI (ChatGPT Plus/Pro) for the
    `openai-codex` gpt profiles.

### Patch Changes

- @schlessera/brain-ui-sdk@0.23.0
- @schlessera/brain-render-template@0.23.0

## 0.22.0

### Minor Changes

- 2a1c6c5: Run the pi backend alongside Claude, with declared model profiles — the path
  to OpenAI models under a ChatGPT subscription.

  - New `BRAIN_UI_PI_PROFILES` env var (JSON array of
    `{id,label,vendor,model,thinkingLevel?}`): when set with the default
    `AGENT_BACKEND=claude`, the pi backend joins the registry and its profiles
    join the picker. pi-ai's built-in `openai-codex` vendor authenticates only
    via ChatGPT Plus/Pro OAuth (`pi login`, device-code capable), so e.g.
    `{"id":"gpt-sol","label":"GPT-5.6 Sol","vendor":"openai-codex","model":"gpt-5.6-sol","thinkingLevel":"xhigh"}`
    runs on the subscription, not API tokens.
  - Fail-loud everywhere a wrong-but-plausible default could hide: malformed
    profiles JSON, duplicate/reserved ids (`default`, `claude`, `claude-*`),
    and invalid thinking levels refuse at boot; a missing pi package with the
    variable set refuses at boot; a declared vendor/model absent from pi's
    catalog rejects the turn instead of letting pi pick a provider; a resume
    whose saved model is unavailable rejects instead of silently substituting.
  - Billing classification keys on the profile vendor: `openai-codex` →
    subscription, other pi vendors (ambient API keys) → api. Claude
    classification is unchanged.
  - `PiProfile` gains `thinkingLevel` (passed to new sessions; pi clamps to the
    model's capability).

### Patch Changes

- d4261bb: Complete the per-backend tool-call rendering abstraction.

  The renderer registry was already backend-scoped, but the timeline hardcoded
  `backend: "claude"`, three code paths bypassed the registry (header label,
  touched-file summary, subagent-row gating), and risk advisories keyed on
  Claude tool names — so pi tool calls fell to the generic tier and risky pi
  `bash`/`write_file` inputs raised no approval-card advisories.

  - `session_info` now carries `backendId` (rev 3, additive); backends stamp
    their own, the host stamps stored sessions on resume/reattach. The client
    records it per session and scopes renderer resolution with it.
  - `ToolRenderer` grows `label`, `touchedFile`, `subagentRows`, and a
    backend-neutral `semantics` contract (`command`/`writePath`/`unsandboxed`);
    the timeline consumes only the renderer, no more name switches.
  - Risk rules now test semantics instead of Claude tool names, with a
    shape-sniffing fallback for renderers that declare none — the same rm -rf /
    force-push / curl|sh / writes-outside-repo advisories fire for every
    backend.
  - New pi renderer pack: `bash`, `read_file`, `write_file`, `edit_file`,
    `grep`, `brain_search`, `brain_context`, `brain_add` render with the same
    dedicated views (diff, file write, command, grep rows) as the Claude pack;
    pi's bare `ask_user` is recognized by the ask-user card grouping.

- 6f16547: Add `eval:triage` and `eval:triage:validate` scripts for the background-triage
  model gate.

  The eval itself lives in `evals/` and is not published — it is excluded from the
  package's `files` list, sits outside the test glob, and refuses to run without
  `BRAIN_UI_LIVE_EVALS=1` because it calls paid provider APIs. Only the two script
  entries are user-visible.

- Updated dependencies [d4261bb]
  - @schlessera/brain-ui-sdk@0.22.0
  - @schlessera/brain-render-template@0.22.0

## 0.21.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.21.0
- @schlessera/brain-render-template@0.21.0

## 0.20.0

### Minor Changes

- d97dbd0: Cost tracking: dynamic pricing and effective spend, plus activity-detail quality-of-life.

  - **Dynamic model pricing** (ui-server): a TTL-cached pricing service merging
    LiteLLM's community price table with OpenRouter's live catalog, cached at
    `$BRAIN_PATH/.brain-ui/model-pricing.json` with a bundled offline snapshot;
    `BRAIN_UI_PRICING_DISCOVERY` / `BRAIN_UI_PRICING_TTL_HOURS` control it.
  - **Effective cost** (ui-server, migration 010): every run's rollup gains
    `effective_cost_usd` + `billing_mode` + `pricing_estimate`, computed inside
    the rollup transaction and frozen at first computation. Subscription-billed
    runs (ambient OAuth) are $0 out of pocket; API-key/OpenRouter runs are
    priced from per-model token usage. Unknown stays NULL — never $0.
  - **Billing classification** (ui-server): resolved per inference profile at
    run start (declared-credential profiles → api; ambient → subscription iff
    the OAuth token is the credential), overridable per profile from
    Settings → Models (`PUT /api/models/billing`).
  - **Dual-cost surfaces**: Activity spend cards, day/job/session rollups, the
    daily digest, and `query_activity` all carry effective cost plus an
    explicit unpriced-run count ("≥ $X · N unpriced"); run rows render
    three-state cost (unknown / free / priced, "~" for estimates); a staleness
    indicator appears when pricing refresh is failing (`GET /api/models/pricing`).
  - **Detail retention window** (ui-server): span trees survive at least
    `activity.retention.detailDays` (default 7) instead of dying at the next
    morning digest — nightly cron runs stay drillable.
  - **Tool I/O capture**: tool calls record clipped input/output payloads as
    span events, expandable in the Activity drill-in (subagent view and run
    detail); pre-capture runs state that no payload was recorded.

### Patch Changes

- 00565d5: Activity-layer review follow-ups (the items deferred from the 0.19.0 review):

  - **Watchdog** (ui-server): a per-job stuck-threshold override below the
    default now actually fires — the scan uses the smallest effective
    threshold, the per-span check still applies each job's own.
  - **Push retry** (ui-server): `send_failed` intents are retried with a
    3-attempt budget and 5-minute backoff (migration 009 adds
    `send_attempts`) — a transient push-service failure no longer forfeits
    push delivery for that notification.
  - **Restart notification** (ui-server): turns interrupted by a server
    restart now produce a failure intent — the boot orphan sweep runs after
    the notifier exists, so its terminal writes are seen by the first tick.
  - **Digest** (ui-server): generation is one immediate transaction and the
    covered-until write is monotonic — a manual run racing the cron job can
    no longer double-count a window or regress the retention floor.
  - **Prune index** (ui-server): migration 009 adds the partial index the
    hourly prune's candidate query needed and drops the unused
    `idx_activity_spans_session`.
  - **PushToggle** (ui-react): now performs the server-disagreement check —
    a subscription bound to a stale VAPID key is dropped (surfacing the
    re-enable button) and a server-side pruned row is healed by re-asserting
    the subscription.
  - **Span naming** (ui-sdk): the `execute_tool <name>`/`invoke_agent`
    convention is now exported protocol constants
    (`SPAN_OP_EXECUTE_TOOL`, `SPAN_OP_INVOKE_AGENT`, `SPAN_TOOL_NAME_PREFIX`)
    instead of three independent restatements.
  - **pi usage** (backend-pi): the turn-usage accumulator narrows the SDK's
    typed `message_end` variant instead of a hand-rolled double cast.

- Updated dependencies [d97dbd0]
- Updated dependencies [00565d5]
  - @schlessera/brain-ui-sdk@0.20.0
  - @schlessera/brain-render-template@0.20.0

## 0.19.0

### Minor Changes

- b15b5f0: Agent observability: a full activity layer across the stack.

  - **Activity record** (ui-server): an OTel-GenAI-aligned span store in the
    server SQLite records every turn, tool call, subagent run and cron run as
    a tree — written at start, closed write-once with a six-outcome taxonomy
    (`denied` and `interrupted` are first-class), with boot/staleness sweepers
    (heartbeat-keyed), a stuck-run watchdog, per-run rollups that survive
    pruning forever, and a digest-floor + hard-ceiling retention policy.
  - **Wire protocol** (ui-sdk, rev 3 additive): view-scoped
    `activity_subscribe`/`activity_snapshot`/`activity_delta` frames with a
    seq-discard ordering contract, a `usage` block (per-model token/cost
    breakdown) on `result`, and subagent linkage (`parentToolUseId`) on tool
    frames. `server_hello` advertises `capabilities.activity`.
  - **Backends**: the Claude adapter stops flattening subagent activity
    (task lifecycle, per-subagent usage, forwarded transcripts to the new
    bridge side channel; `forwardSubagentText` on; SDK floor 0.3.241) and
    reports full `modelUsage`; the pi backend reports per-turn token usage
    from its event stream. The new read-only `mcp__brain-ui__query_activity`
    tool lets the agent answer "what ran / what is running?" from the record.
  - **UI** (ui-react): live subagent rows with a stacked drill-in view
    (observation-shaped; approvals actionable there and in the chat), one
    server clock for live and reloaded duration badges, and a first-class
    Activity surface — live runs, history, rollup cards, failure inbox with
    nav badges, a while-you-were-away digest card, and a three-state web-push
    toggle. Activity takes the mobile tab-bar slot; Graph moves to More.
  - **Notifications** (ui-server): persisted intents (at-least-once, storm-
    capped, watched-suppressed) with an in-app inbox as the guaranteed tier
    and web push (generated VAPID keys in a secret-classified table,
    per-device subscriptions, minimized payloads, 404/410 pruning) on top.
  - `getCronStatus` now lists every recorded job name, closing the gap that
    hid module jobs from `/api/status`; the sessions listing merges stored
    cost accounting over backend zeros.

### Patch Changes

- Updated dependencies [b15b5f0]
  - @schlessera/brain-ui-sdk@0.19.0
  - @schlessera/brain-render-template@0.19.0

## 0.18.0

### Minor Changes

- a29b287: Harden the agent turn lifecycle against the failure modes found in the
  2026-08-23 fan-out incident (23 background subagents killed, tool aborts
  misread as user denials, one long Bash freezing every session's writes).

  - **Configurable turn timeout.** `BRAIN_UI_TURN_TIMEOUT_MS` now feeds
    `createApp()` (explicit option still wins); the host passes the live budget
    to backends as `StartTurnRequest.turnBudgetMs`, and the Claude backend puts
    the real number in the system prompt so the model sizes work to the cap.
  - **Keyed write locks replace the global mutex** (`createKeyedLock` in
    brain-ui-sdk; the old `createWriteLock` remains for the pi backend). The
    Claude backend now serializes per target file for Write/Edit/NotebookEdit,
    repo-wide only for git staging/history commands (and `brain sync|import`),
    and on one shared key for the brain document tools. Everything else — curl,
    builds, tests — takes no lock. Lock waits are bounded (`lockWaitMs`,
    default 30s, under the CLI's 60s hook timeout) and expire into a DENY with
    an explicit "retry" reason instead of stalling into the CLI's misleading
    "hook did not respond" refusal.
  - **Agent calls are rewritten to run in the foreground.** The SDK's Agent
    tool backgrounds subagents BY DEFAULT, and a background subagent dies with
    the per-turn subprocess. A PreToolUse hook rewrites
    `run_in_background` to `false` (and denies `isolation: "remote"`, whose
    results nothing could collect), telling the model why via
    `additionalContext`.
  - **Turn-lifecycle brief in the system prompt append**: per-turn subprocess
    semantics, the hard budget, incremental-write guidance, and how to read
    "the user doesn't want to take this action" / lock-busy errors (usually a
    cancelled turn or contention, not a human refusal).
  - **Approvals and ask-user cards survive disconnects.** A phone dropping its
    socket at screen lock no longer silently denies pending approvals; they are
    held (bounded by the turn timeout), re-delivered on reconnect, and an
    approval raised with no client attached logs a warning instead of parking
    invisibly. Location and mask requests keep their fail-fast behavior.

### Patch Changes

- Updated dependencies [a29b287]
  - @schlessera/brain-ui-sdk@0.18.0
  - @schlessera/brain-render-template@0.18.0

## 0.17.0

### Minor Changes

- fb4e218: Confirm destructive Bash commands, and stop implying approvals are containment.

  `Bash` is auto-allowed and the Agent SDK never consults `canUseTool` for an
  allow-listed tool, so `brain archive x.md` typed into Bash ran with no prompt
  while the identical operation through the `brain_archive` MCP tool raised an
  approval card. The brain repo's own CLAUDE.md documents the CLI form, so the
  gated path was the one an agent is least likely to take — the confirmation sat
  on the road nobody drives.

  A Bash command matching a configured pattern now raises the normal approval
  card, from the `PreToolUse` hook. That hook is the right place for the same
  reason the write lock lives there: it fires before every tool execution
  regardless of how the tool was permitted. The prompt happens BEFORE the write
  lock is taken, so a user deliberating does not block every other session.

  The pattern list is configuration, not code: `BRAIN_UI_CONFIRM_BASH` takes a
  JSON array of regex sources. Unset uses the shipped defaults (`brain archive`,
  recursive `rm`, `git push --force`, `git reset --hard`, `git clean -f`,
  `git checkout --`). An explicit `[]` disables confirmation and is honoured as
  given. A malformed value falls back to the defaults rather than throwing — a
  typo must not stop the server booting, and the safe direction to fail is more
  confirmation, not less.

  `brain archive` is on the list because archiving is a VISIBILITY change, not
  because it is hard to undo. An archived document drops out of search, briefings
  and context assembly, so a silent archive surfaces later as holes in output
  nobody can account for.

  SECURITY.md previously claimed "write-capable tools sit behind your agent's
  permission gating". That was not true and is now corrected, with a section
  stating plainly what approvals are: a seatbelt against a destructive command
  you did not intend, not a control that stops an agent working around it. The
  real boundary is auth.

### Patch Changes

- 210446f: Unify boolean environment parsing across all packages: every boolean variable
  now accepts 1/true/on/yes and 0/false/off/no (case-insensitive, trimmed), and
  an unset, empty, or unrecognised value falls back to the variable's documented
  default instead of being misread. Defaults and directions are unchanged;
  previously `"1"`-only flags (the Chrome sandbox switches, `TRUST_PROXY`,
  `BRAIN_UI_DANGEROUSLY_DISABLE_AUTH`, `BRAIN_UI_ALLOW_PASSWORD`,
  `BRAIN_UI_ALLOW_LOOPBACK_ORIGIN`) accept the full truthy set, and the disable
  set for `BRAIN_UI_REVERSE_GEOCODE` / `BRAIN_UI_MODEL_DISCOVERY` gains `no`.
  `NO_COLOR` keeps its presence-based contract. Published descriptor types
  (`ENV_VARS` shapes) are unchanged.
- b84e70f: Finish wiring the observability layer through the server: report what already failed silently.

  The layer itself was sound — OpenTelemetry API on the producing side, our own
  console/recording/in-memory consumers on the other — but adoption stopped at
  two instruments, so most failures still answered the browser and left no
  server-side trace.

  - Turn lifecycle: every turn now emits "turn started" / "turn completed"
    (INFO, with `session.id` / `turn.id` / `profile` and duration), and every
    turn-failure path that previously only sent an error frame — SESSION_BUSY,
    BACKEND_REQUEST_ERROR, BACKEND_ERROR, FOLLOWUP_FAILED, SESSION_LOAD_ERROR —
    also logs (WARN for busy, ERROR otherwise) and feeds a `turns.failed`
    counter keyed by the bounded error code. `turns.started` / `turns.completed`
    counters and the turn-timeout WARN's correlation ids come with it.
  - Auth: password logins are observable — WARN on a failed password and on the
    rate limit, INFO on success, and a distinct ERROR when `Bun.password.verify`
    throws (a corrupt BRAIN_UI_PASSWORD_HASH is no longer reported as a wrong
    password). Failures land on the same `auth.failures` counter passkeys use.
  - Request logging now runs through the observability layer (method, path,
    status, duration; no query strings or bodies) instead of hono's raw-console
    `logger()`, so BRAIN_UI_LOG_LEVEL governs it; `/api/health` is skipped.
  - `/api/health` performs a SELECT 1 liveness probe of the app database and
    answers 503 `{"status":"unhealthy"}` when it fails — the Docker healthcheck
    no longer reports healthy over a wedged SQLite handle.
  - The dead `log?` seams (graph/files/share/render/models routes, settings,
    keyterm builder, share staging, the backend registry) actually receive a
    logger from `createApp`, and session-catalog write failures WARN with the
    session id instead of being swallowed.
  - New `recordCronRun(db, jobName)` export lets an external scheduler (the
    container crontab in the shipped deployment) record runs into `cron_runs`,
    so `/api/status`'s `cronJobs` reflects what actually ran.
  - WebSocket: the upgrade handlers gained `onError` (WARN + `ws.errors`
    counter), and broadcast send failures count on `ws.frames.dropped` with
    reason `broadcast_send_failed`, direction `outbound`.
  - Backends take an optional minimal `log` callback (no OTel dependency):
    the Claude backend routes its unparseable-confirmBashPatterns warning
    through it (console.warn only when standalone), and the pi backend's
    resource-loader fallback — which silently dropped the chat-surface
    system-prompt append — now says so.

- 6e1fd43: Fix per-connection protocol state never reaching the WS dispatcher (declared
  protocolRev was dropped, so the rev-3 turnId-echo requirement was never
  enforced), extract the tool-view diff engine into `lib/diff.ts`, and clean up
  dead imports/variables surfaced by the new oxlint gate.
- a714ee1: Per-package `test` scripts now pass `--timeout 30000`, so `bun run test` inside a package no longer flakes on bun's 5s default when suites spawn the CLI.
- ef519d1: Harden the publish surface: what a consumer installs now matches what the
  declarations, bundler and runtime actually reach for.

  - `@schlessera/brain-backend-pi` declares `@earendil-works/pi-agent-core`
    (exact-pinned, like its sibling pi pins) instead of borrowing it from
    hoisting — its public `history.d.ts` types reference the package, so a
    strict installer (pnpm, npm with isolated modes) could not typecheck it.
  - `@schlessera/brain-ui-react` sets `sideEffects` to `["**/*.css"]` — the
    blanket `false` licensed bundlers to tree-shake a direct
    `import "@schlessera/brain-ui-react/styles.css"` away entirely.
  - `./theme.css` now resolves from `dist/` (copied verbatim at build) like
    `./styles.css` already did, so both stylesheets survive a dist-only tarball
    and the export map is uniform. The import specifier is unchanged.
  - `@schlessera/brain-module-finance`, `-images` and `-speaking` declare the
    same optional `@types/bun` peer that `-jobs` already carried: their module
    declaration graphs reach `bun:sqlite` types through `@schlessera/brain`.
  - Every package exports `"./package.json"` — tooling like Vite, Tailwind and
    Jest stats it, and the export map previously made that unreachable.
  - `engines.bun` is aligned with reality: bun-runtime packages require
    `>=1.3.5` (the CVE-2026-24910 floor `brain doctor` warns below), and
    packages that import cleanly under plain Node carry no bun engines field.
    Scrape keeps its (bumped) engines despite importing node-clean: its proxy
    fetch path shells out through `Bun.spawn`, so the runtime constraint is
    real even though the import is not.
  - Backend loading in `@schlessera/brain-ui-server` uses `await import()`
    instead of CJS `require()`, and only "the backend package itself is not
    installed" maps to the install-hint error. An installed-but-broken backend
    (missing transitive dep, syntax error, `ERR_REQUIRE_ESM`) now surfaces its
    real error instead of a misleading "not installed".

- Updated dependencies [a714ee1]
- Updated dependencies [ef519d1]
  - @schlessera/brain-ui-sdk@0.17.0
  - @schlessera/brain-render-template@0.17.0

## 0.16.0

### Minor Changes

- a7362e1: Move the client half of the wire protocol into the SDK, and validate both
  directions.

  `ui-sdk` described itself as owning the protocol while its `./client` subpath
  held only two registries: the actual transport was `ui-react`'s
  `ws-client.ts`, which cast every inbound frame, and dispatch handled 15 of the
  16 server frame types inside a React hook. Any non-React consumer — a CLI, a
  mobile shell, an integration test — reimplemented reconnection, framing and
  validation from scratch.

  - **`parseServerMessage`** validates server→client frames, with one schema per
    member bound to its interface by `satisfies` so the two cannot drift. The
    receiving policy is softer than the server's on purpose: a frame that fails
    is DROPPED and reported, never thrown, because the protocol is additive and a
    client that hard-fails an unrecognised frame turns every additive server
    change into a breaking one. Unknown keys survive the boundary.
  - **`BrainUiClient`** (`@schlessera/brain-ui-sdk/client`) is the transport:
    the same backoff and `reconnectNow` as before, plus validation,
    `server_hello` capture — so `protocolRev` and capabilities are readable
    rather than advisory — and `turnId` echo on turn-scoped replies, which finally
    gives the host's echo verification something to verify. A `socketFactory`
    option makes it testable with no network.
  - **`ui-react`** keeps every store write and becomes a handler set.
    `ws-client.ts` is deleted; `handleServerMessage` and `runStateForFrame` keep
    their signatures.
  - **`error` frames are no longer dropped outside a turn.** The old handler only
    appended to a streaming transcript, so an error between turns went nowhere —
    no console, no store, no UI. `useConnectionStore` gained `lastError`, and
    protocol-level drops land there too.
  - **A real-socket integration test** drives `BrainUiClient` against a real
    `createApp()`, closing the ROADMAP item about the auth boot refusal never
    being exercised through a socket. It is also the first test that would catch
    a client/server protocol drift, since both shipped implementations are on
    opposite ends of it.

  The frame parsers no longer use Node's `Buffer` — they accept
  `string | ArrayBufferView | ArrayBuffer` and measure UTF-8 length with
  `TextEncoder`. Both parsers now run on both ends of the socket, and the client
  end is a browser bundle; the build caught this the moment `ui-react` imported
  the SDK client.

  `turnId` is still not REQUIRED — that is a protocol-rev change with a
  deprecation window, deliberately out of scope.

- 3bfae80: Add swappable observability consumers, and instrument the WebSocket frame path.

  The producing side is the standard OpenTelemetry API — `logger.emit()`,
  `counter.add()` — so instrumentation is written once and stays portable. The
  consuming side is ours: a console consumer for production, a recording
  consumer for tests, an in-memory meter that `/api/status` reads. Choosing where
  reports go is an argument, never a change to instrumentation.

  `createApp({ observability })` and `new WsHost({ observability })` take one by
  injection, defaulting to the console consumer (WsHost defaults to silence, so
  an embedder gets no surprise stream on stdout). Nothing requires the
  OpenTelemetry globals; `installGlobally()` exists for code that cannot be
  handed an argument and returns a restore function, so a test cannot strand a
  sink for the next one. Two apps in one process report separately.

  `createRecordingObservability()` is the test surface: `logs.find({ scope,
severity, body, attributes })`, `metrics.value(name, attributes)`,
  `metrics.total(name)`, `metrics.snapshot()`. It is the same in-memory meter
  production uses, so an assertion is about the real recorder rather than a
  double. `createWsHandlers(host)` was split out of `createWsUpgrade` so a test
  drives the actual frame path without an HTTP server.

  Three holes are now instrumented. A `parseClientMessage` rejection was answered
  to the client and never logged — the inbound validation already shipped had no
  observability at all. A handler that threw sent `INTERNAL_ERROR` and discarded
  the cause. Both now emit, and dropped frames land on a `ws.frames.dropped`
  counter split by reason, exposed on `/api/status` next to `cronJobs`. Reported
  detail is always a bounded token, never the frame body, which is
  caller-supplied and capped at 12 MB.

  `@opentelemetry/api` is caretted (stable 1.x, zero dependencies).
  `@opentelemetry/api-logs` is pinned EXACT: the logs API is 0.x. That was
  measured rather than assumed — the producing surface is unchanged across
  0.57 → 0.221 and the global handshake is keyed on a compatibility constant that
  has stayed at 1, so mixed copies interoperate. The churn is in
  `@opentelemetry/sdk-logs`, which is precisely the package these consumers
  replace and which is not a dependency.

- 794c54c: Report through the observability layer instead of `console`, and make the
  threshold configurable.

  All 31 `console.*` sites in this package now emit through the injected
  `Observability`: structured, severity-filtered, assertable in a test, and
  routable somewhere else later without touching a call site. A test enforces
  it — AST-based, so the shell command inside an auth error message that
  contains the literal text `console.log` does not trip it. The console consumer
  itself is the one exemption, and the test asserts that exemption is still real
  so the list cannot rot.

  `BRAIN_UI_LOG_LEVEL` (default `INFO`) sets the console consumer's threshold. An
  unrecognised value falls back rather than throwing: a typo in a log level must
  not be why a server refuses to boot, and silently emitting nothing would be
  worse than emitting too much. The two security-critical boot messages —
  unknown `AUTH_MODE`, and `AUTH_MODE=none` deliberately permitted on a
  non-loopback host — emit at ERROR so a log threshold can never be the reason
  nobody saw them.

  Failed passkey ceremonies now increment an `auth.failures` counter split by
  reason and ceremony, alongside the log. A rate of those is what distinguishes
  one fumbled login from someone working through a list, and it was not
  recoverable from a log line nobody tails.

  Observability is constructed first in `createApp` — before the auth validation
  that can refuse to boot and before the migration runner — so nothing that can
  report is built before somewhere to report exists.

- 7ea32f7: Meter inbound WebSocket frames, and make `turnId` enforceable via a rev-3
  handshake.

  **Rate limiting.** Frames were size-, cardinality- and depth-bounded but not
  metered, so a flood of individually valid frames was unbounded behind the auth
  guard. Each connection now gets a token bucket — `BRAIN_UI_WS_RATE` (default 20
  frames/sec) and `BRAIN_UI_WS_BURST` (default 60), with `0` disabling it. A
  bucket rather than a fixed window because the real traffic is bursty: opening
  the app fires several frames at once and an approval storm is a dozen in a
  second, both legitimate. The bucket lives on the socket, not in a map keyed by
  something a peer controls — that map is itself the memory-exhaustion bug a rate
  limiter is supposed to prevent. Metering runs BEFORE parsing, since parsing is
  most of the work being bounded, and refusals land on the existing
  `ws.frames.dropped` counter under `reason: rate_limited`.

  **Protocol rev 3.** `turnId` could not be made mandatory because there was no
  client→server handshake: a host could not tell a current client from a
  two-year-old one, so enforcing would have broken every tool approval in older
  UIs. `client_hello` fixes that — a client declares its revision, and a host
  applies rev-3 rules only to connections that declared rev 3. Clients that send
  no hello are treated as rev 2 and keep today's tolerance indefinitely. This is
  therefore additive: no existing client changes behaviour.

  **A bug in the previous release's turnId echo is fixed here.** `BrainUiClient`
  tracked "the most recent turn id seen", which is correct with one session and
  wrong with two: a delta from session B arriving between session A's approval
  request and the user answering it made the reply carry B's id, the host refused
  the mismatch, and A's turn waited for an approval that could never be accepted
  — invisible until the ten-minute timeout. Turn ids are now tracked per request
  id and consumed when the reply goes out.

- 0fc9c44: Fix the five rough edges carried over from the extraction review.

  They were ported verbatim and never re-verified. All five were still real, and
  every one fails silently — which is why they survived: nothing errored, data
  just went missing or appeared in the wrong place.

  - **A follow-up sent mid-stream dropped every delta that followed it.**
    `mutateLastAssistant` indexed the END of the buffer, so once the user's
    second message was appended the still-streaming assistant message was no
    longer last, `role === "assistant"` failed, and each write was discarded. The
    turn kept running and its output stopped appearing. It now finds the last
    ASSISTANT message.
  - **Draft adoption could bind to another turn's session.** A client starting a
    conversation has no session id, so it adopted the first `session_info` or
    `result` for an unknown session — possibly an older background turn's, or
    another client's. `chat_message` gains an optional client-minted `draftId`,
    echoed on `session_info`, and adoption requires a match. Additive: a server
    that does not echo it falls back to the previous behaviour rather than
    leaving the draft unbound.
  - **The file store showed one file's content under another's name.** Two rapid
    clicks raced and the SLOWER fetch won. Both the success and error paths now
    drop a response for a path the user has already navigated away from.
  - **`whatsup` could deadlock.** stderr was only drained after
    `await proc.exited`, so a child that filled the pipe buffer blocked on write
    and never exited. It is drained concurrently with stdout now.
  - **The SPA fallback 404ed deep links from an absolute static root.**
    `serveStatic({ path })` resolves against the process cwd, so
    `join(staticRoot, "index.html")` only worked when `staticRoot` was itself
    cwd-relative — true of the shipped layout, not of an embedder passing an
    absolute directory. The fallback serves the file directly now.

### Patch Changes

- Updated dependencies [a7362e1]
- Updated dependencies [7ea32f7]
- Updated dependencies [0fc9c44]
  - @schlessera/brain-ui-sdk@0.16.0
  - @schlessera/brain-render-template@0.16.0

## 0.15.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.15.0
- @schlessera/brain-render-template@0.15.0

## 0.14.0

### Minor Changes

- 59de559: - Added: every package reads the environment in one chokepoint that declares
  each variable, exports the contract (`ENV_VARS`, `resolveEnv`, `readEnvVar`)
  from the package entry, and generates its README env table from it.
  - Added: `ui-server` exports a resolved `ServerConfig` and returns an app handle
    (`config`, `db`, `wsHost`, `isTurnActive`, `cancelActiveTurns`, `close`), so
    two differently-configured apps coexist in one process.
  - Added: `openBrainDb`/`withBrainDb` gate every `brain.db` read on
    `schema_version`; `assertBackendResolvable` refuses to boot when the selected
    agent backend is not installed.
  - Changed: `@schlessera/brain-backend-claude` is an optional peer of
    `ui-server`, not a dependency — a deployment declares the backend it uses.
  - Changed: the module contract carries the config generic through
    `CommandContext`, `HygieneContext` and `CommandModule`, so a module author no
    longer casts a value the loader already validated.
  - Changed: the Gemini providers no longer delete and restore `GOOGLE_API_KEY`
    around client construction.
  - Removed: `configureDb`, `getDb`, `closeDb`, `configureWsHost`,
    `defaultWsHost`, `cancelActiveTurn`, `isTurnActive`, the `brainClient`
    namespace and the `getBackends`/`getBackendsInfo` module functions — their
    replacements live on the app handle.

### Patch Changes

- @schlessera/brain-ui-sdk@0.14.0
- @schlessera/brain-render-template@0.14.0

## 0.13.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.13.1
- @schlessera/brain-backend-claude@0.13.1
- @schlessera/brain-render-template@0.13.1

## 0.13.0

### Minor Changes

- e7e0092: Bound a session's follow-up queue by bytes instead of by message count

  `MAX_SESSION_QUEUE = 5` was a placeholder with no reasoning behind it, and it
  measured the wrong thing: a queue of five sentences and a queue of five
  four-image messages differ by roughly 50 MB, and only the second is a problem.
  Every queued entry is held in the host process (attachments still base64) until
  its turn runs.

  - **20 MiB warns, 50 MiB refuses.** Past the warn mark the message is still
    accepted and the `queued` status carries a `detail` note saying how much is
    parked; the server logs it too. Past the hard cap it is refused with
    `SESSION_QUEUE_FULL`, naming both the parked total and what the rejected
    message needed — an explicit error frame, never a silent drop.
  - **`MAX_SESSION_QUEUE` survives as a depth backstop, raised to 50.** Bytes do
    not bound count, and each entry becomes its own turn: ~500k one-line messages
    fit inside 50 MiB and would run a session for days.
  - `queuedFollowUpBytes` / `queuedBytes` (ui-server `ws/turns`) do the
    accounting, measuring the payload as it arrived on the wire.
  - The client stores the note per session (`queueNotes`) and the session drawer's
    Queued pill turns red and shows it on hover.

  Only affects backends without native follow-up — with `capabilities.followUp`
  (pi) messages go into the running turn and no host queue exists. The default
  Claude backend is the one that queues.

- 2be49b8: Stage an incoming system share on the server

  First phase of making the chat UI a share target on Android: `POST /api/share`
  accepts a multipart share (title, text, url, and up to ten files) and writes it
  to `<brain root>/.brain-ui/inbox/<id>/` alongside a `meta.json` manifest, so the
  agent can read, file and process it as an ordinary chat turn. Nothing enters the
  content repo until the agent decides where it belongs.

  Everything a share carries is attacker-influenced — file names come from
  whichever app invoked the share sheet — and the consumer is an agent with file
  and shell tools, which sets the bar for "sanitized": a name is not safe merely
  because the filesystem accepts it. The staging directory's name is minted
  server-side and no part of the payload is ever treated as a path. Names go
  through an ALLOWLIST — Unicode letters, digits, marks and `._-` — rather than a
  list of characters someone thought to forbid, because `photo$(curl evil).jpg`
  survives any such list and correct quoting by the agent is not a boundary.
  Format characters go too: bidi overrides, zero-width spaces and the Unicode tag
  block, from the text fields as well as the names, since all of them are quoted
  into a prompt and all of them are invisible to the human reading it. Names are
  bounded, given an extension from their media type when they have none, and
  de-duplicated rather than overwritten;
  `meta.json` is reserved — case-insensitively, since on macOS and Windows
  `META.JSON` and `meta.json` are one file — and the length bound counts UTF-8
  bytes rather than characters, because a filesystem component limit is a byte
  limit and a hundred CJK characters are three hundred bytes.

  Caps (`SHARE_MAX_FILES`, `SHARE_MAX_FILE_BYTES`, `SHARE_MAX_TOTAL_BYTES`,
  `SHARE_MAX_TEXT_BYTES`) are counted off the request stream rather than trusted
  from `content-length`, which HTTP/2 and chunked encoding omit entirely, then
  again against each part's claimed size and once more against the decoded bytes.
  A share is staged into `.<id>.partial` and renamed into place only once
  `meta.json` is written, so the agent cannot observe a half-written share even if
  the process is killed mid-write — which `try`/`catch` cleanup cannot cover. One
  unwritable file is recorded as `skipped` rather than losing the other four.

  Two fields that reach the agent are now validated rather than passed through: a
  `url` that is not http(s) is demoted to plain text, because the filing skill
  dereferences that field and `javascript:`, `data:` and `file:///etc/shadow` all
  arrive as plausible strings; and a media type that is not a media type becomes
  `application/octet-stream` instead of being quoted back into the prompt at
  whatever length the sender chose.

  `POST /api/share` also refuses a cross-site request. Every other state-changing
  route here reads JSON, which forces a preflight and is CSRF-safe by accident; a
  multipart POST is CORS-simple and gets no preflight, and under
  `AUTH_MODE=tailscale` the credential is the source IP, so no SameSite flag
  applies either. Concurrent intakes are capped, the inbox is capped at
  `SHARE_MAX_STAGED` shares, and the prune sweep is debounced instead of running
  on every upload. A failure mid-write removes the partial directory. Staged shares older than `SHARE_STAGING_TTL_MS`
  (7 days) are pruned opportunistically on each intake, and `pruneShareStaging()`
  is exported so a deployment can also sweep at boot.

  `template/.gitignore` now ignores `.brain-ui/`, which it never did — so a
  generated brain repo would have staged a share (and the keyterm and model
  caches) into git on the next `git add -A`.

  The route is mounted behind the auth guard, which is the whole defense for
  something that writes into the brain root — a wiring test now asserts it.

  A second, public route answers `POST /share-target` when no service worker was
  there to intercept it (evicted, storage cleared, or installed before the worker
  activated) with a redirect into the app instead of a bare 404 — the SPA fallback
  is GET-only, so without it the user gets a raw error page inside the app window.
  It reads no body and must stay outside the guard: a share navigation is
  cross-site, so the SameSite=Strict cookie is absent by construction.

  The service-worker share-target handler, the client intake, and the manifest
  entry in the deployment shell follow in later phases.

### Patch Changes

- Updated dependencies [2be49b8]
- Updated dependencies [2be49b8]
  - @schlessera/brain-ui-sdk@0.13.0
  - @schlessera/brain-backend-claude@0.13.0
  - @schlessera/brain-render-template@0.13.0

## 0.12.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.12.1
- @schlessera/brain-backend-claude@0.12.1
- @schlessera/brain-render-template@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [4281c59]
  - @schlessera/brain-ui-sdk@0.12.0
  - @schlessera/brain-backend-claude@0.12.0
  - @schlessera/brain-render-template@0.12.0

## 0.11.0

### Minor Changes

- 604abbc: Add a mask bridge: the reader paints the region an image edit applies to

  Masked inpainting needs someone to point at part of a picture, and there is no
  server-side substitute for that. This mirrors the existing location bridge: the
  agent calls `mcp__brain-ui__request_image_mask`, the browser opens a canvas over
  the image, and the painted PNG comes back over the socket.

  - **ui-sdk** — `mask_request` / `mask_response` / `mask_error` frames, validated
    at the boundary with the same decoded-byte budget as a chat image, plus
    `BackendBridge.requestMask`.
  - **ui-server** — pending-mask state on the turn coordinator, the bridge method,
    and inbound routing. Cancels reject the promise like every other pending
    interactive request, so a disconnect mid-paint fails the tool instead of
    hanging the turn.
  - **ui-react** — a `MaskEditor` modal: paint with a sized brush, undo, clear.
    Strokes are drawn on a capped working canvas and rescaled to the source
    image's true pixel dimensions on export, so a mask drawn on a phone lines up
    with a 4K original. Painted pixels export as fully transparent, which is the
    convention the edit endpoint reads.
  - **ui-backend-claude** — the tool, auto-allowed like the other bridge tools
    (the editor itself is the approval), and a system-prompt line telling the
    agent to ask rather than guess coordinates.

  The mask is written next to its image and the path returned, because what
  consumes it is `brain image --mask <path>`.

- cdfa039: Raise the preview, upload and share size limits to match the frame budget

  The socket already accepts ~12MB inbound (brain-ui sets `maxPayloadLength` to
  `MAX_CLIENT_FRAME_BYTES + 64KB`), but the limits layered above it were never
  lifted to use that headroom. Worst case today was 6MB decoded — about 8MB once
  base64 inflates it — against a 12MB frame.

  - `MAX_IMAGE_BYTES` 2MB → 4MB. This mostly governs GIFs: everything else is
    downscaled to 1568px and re-encoded to JPEG client-side, landing far below
    either number, while a GIF passes through untouched so its animation
    survives.
  - `MAX_TOTAL_IMAGE_BYTES` 6MB → 8MB, which is ~10.7MB base64 and still leaves
    the JSON envelope room inside the 12MB frame.
  - `FILE_SIZE_CAP_BYTES` 5MB → 10MB for the JSON preview path. Raw bytes
    (`?raw=1`) stream from disk and were never bounded by it, so this only ever
    affected text previews.
  - Render/share content 512KB → 4MB. That bound predated inlined assets: a
    shared document carries `data:` image URIs and pre-rendered mermaid SVGs,
    which pass 512KB without the prose being long. It is an HTTP body, not a
    socket frame.

  Left alone: `MAX_WS_MESSAGE_BYTES` (512KB, server → client). That one bounds
  what the browser renders and what reverse proxies will pass, which is a
  different risk than what the user can send.

### Patch Changes

- Updated dependencies [604abbc]
- Updated dependencies [cdfa039]
  - @schlessera/brain-ui-sdk@0.11.0
  - @schlessera/brain-backend-claude@0.11.0
  - @schlessera/brain-render-template@0.11.0

## 0.10.0

### Minor Changes

- 50f6ec7: Add `brain render` — documents to PDF, PNG, or standalone HTML from the CLI

  PDF generation existed in brain-kit already, but only over HTTP: the UI posted
  content to `/api/render`, which wrapped it in a document template and drove the
  headless Chrome in `@schlessera/brain-render-puppeteer`. Nothing on the command
  line could reach it, so agents and skills that wanted a shareable file shelled
  out to a browser themselves and re-invented the layout each time.

  - **New package `@schlessera/brain-render-template`** holds the markdown/HTML →
    print-ready document shell (marked plus the stylesheet), extracted from
    ui-server. Both callers now share it, so a page shared from the app and a PDF
    produced on the command line are byte-identical for identical input.
  - **New command `brain render <path|->`** with `--format pdf|png|html`. It
    strips frontmatter, takes the title from it, defaults the output path to the
    input with the format's extension, and refuses to write outside the brain
    root. `--format html` needs no browser at all.
  - **Remote images** stay blocked by default — the rendered page resolves no
    hostname, so a remote `<img>` becomes a visible `[alt — not embedded]`
    placeholder. The new repeatable `--allow-host` opens specific image hosts,
    passing the same allowlist to both the placeholdering and the renderer.
  - **New core skill `generate-pdf`** drives the command. It declares no `requires:`
    beyond `brain` itself.
  - `@schlessera/brain-render-puppeteer` becomes an optional peer of core, resolved
    dynamically like `@google/genai`: a missing renderer produces install
    instructions rather than a module-resolution stack trace.

  Also fixes a latent bug in the image placeholdering that ui-server shipped: the
  `<img>` match used `[^>]*` for attributes, so a `>` inside an earlier quoted
  attribute (`alt="<b>x</b>"`) truncated the match and let the remote image
  through unplaceholdered, to render as a broken-image box.

### Patch Changes

- Updated dependencies [50f6ec7]
  - @schlessera/brain-render-template@0.10.0
  - @schlessera/brain-ui-sdk@0.10.0
  - @schlessera/brain-backend-claude@0.10.0

## 0.9.0

### Minor Changes

- 1f7e6a3: Added: mermaid diagrams get their own share menu (PNG / PDF / SVG / source) and a
  full-screen pan-and-zoom viewer, opened by tapping the diagram.
  Added: a chat-surface brief appended to the agent's system prompt —
  `buildSystemPromptAppend({ client, tools })` — covering diagrams, `<share>`
  blocks, wikilinks, raw-HTML and tool-narration rules, the ask-user and location
  tools, and what the reader's device can do. Each backend declares its own tool
  names (pi has no location tool), and both take a `systemPromptAppend` option to
  override the whole brief.
  Added: `chat_message` frames carry an optional `client` field
  (`ClientEnvironment`: form factor, touch, standalone, camera, microphone,
  geolocation, share sheet, viewport, locale, timezone), feature-detected in the
  browser and validated strictly at the boundary. The Claude backend rebuilds its
  system-prompt append per turn from it.
  Changed: diagrams render in a theme built from the app's own tokens instead of
  mermaid's stock dark/neutral themes; exports use the matching light theme.
  Changed: `MermaidTheme` is now `"dark" | "light"` (was `"dark" | "neutral"`),
  `ShareMenu`'s `renderTrigger` also receives `status` and `icon`, and the
  server-internal `handleChatMessage` takes an options object.

### Patch Changes

- Updated dependencies [1f7e6a3]
  - @schlessera/brain-ui-sdk@0.9.0
  - @schlessera/brain-backend-claude@0.9.0

## 0.8.0

### Minor Changes

- 2868ba6: Mermaid diagram support across all render surfaces.

  - ` ```mermaid ` (and ` ```mmd `) fences render as diagrams in chat messages,
    the markdown file previewer, `<share>` block previews, Write-tool previews,
    and the "What's up" briefing — one hook in `BrainMarkdown`, so every surface
    gets it.
  - Streaming-safe: while a fence is still arriving the raw source shows as an
    ordinary code block; debounced parses (with a 400ms throttle floor) upgrade
    it to a diagram as soon as the source parses, and a failed parse keeps the
    last good SVG instead of flashing an error. Renders are cached, so per-token
    re-renders of a streaming message cost a lookup.
  - Mermaid (~2MB) loads lazily on first diagram; `securityLevel: "strict"` and
    `suppressErrorRendering` are set.
  - Share as PNG/PDF pre-renders fences to inline SVG on the client
    (`inlineMermaidDiagrams`, light "neutral" theme) before `POST /api/render`,
    since the render page runs without JavaScript or network. ui-server's share
    template gained matching `.mermaid-figure` styles.
  - Standalone `.mmd` / `.mermaid` files get a diagram preview (with the usual
    preview/raw toggle) in the file viewer.
  - `BrainMarkdown`'s component overrides are now identity-stable across
    renders, so streaming deltas no longer unmount/remount every code block.

### Patch Changes

- @schlessera/brain-ui-sdk@0.8.0
- @schlessera/brain-backend-claude@0.8.0

## 0.7.2

### Patch Changes

- @schlessera/brain-ui-sdk@0.7.2
- @schlessera/brain-backend-claude@0.7.2

## 0.7.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.7.1
- @schlessera/brain-backend-claude@0.7.1

## 0.7.0

### Minor Changes

- b8cbf72: Knowledge-graph view: `brain graph` command and schema-v8 derived tables
  (metrics, communities, root distances, precomputed ForceAtlas2 layout) built
  at index time; `/api/graph/*` REST endpoints served from read-only brain.db
  access; a full-screen GraphPage with Clusters, Discovery, Local, and
  Maintenance modes rendered via a lazy-loaded sigma.js WebGL canvas.

### Patch Changes

- Updated dependencies [b8cbf72]
  - @schlessera/brain-ui-sdk@0.7.0
  - @schlessera/brain-backend-claude@0.7.0

## 0.6.3

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.3
- @schlessera/brain-backend-claude@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies [eb0a6ba]
  - @schlessera/brain-backend-claude@0.6.2
  - @schlessera/brain-ui-sdk@0.6.2

## 0.6.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.1
- @schlessera/brain-backend-claude@0.6.1

## 0.6.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.0
- @schlessera/brain-backend-claude@0.6.0

## 0.5.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.5.1
- @schlessera/brain-backend-claude@0.5.1

## 0.5.0

### Minor Changes

- 2904074: - Added: the model picker is discovered from the Anthropic Models API, so a new
  model appears without an env edit or a redeploy.
  - Added: a Settings screen (Models | Security) to hide models from the picker
    and refresh the list on demand.
  - Added: `BRAIN_UI_MODEL_DISCOVERY` and `BRAIN_UI_MODEL_TTL_HOURS`.
  - Changed: `BRAIN_UI_CLAUDE_PROFILES` is now only for non-Anthropic endpoints
    and for overriding a discovered model.
  - Changed: `useUIStore`'s `securityPanelOpen` / `toggleSecurityPanel` /
    `setSecurityPanelOpen` are now `settingsPanelOpen` / `toggleSettingsPanel` /
    `setSettingsPanelOpen`.

### Patch Changes

- Updated dependencies [2904074]
  - @schlessera/brain-backend-claude@0.5.0
  - @schlessera/brain-ui-sdk@0.5.0

## 0.4.0

### Minor Changes

- 2c42696: Extract the brain-ui deployment into two reusable packages.

  - **New `@schlessera/brain-ui-server`**: Hono app factory (`createApp`) with
    auth (password/passkeys/tailscale/proxy), the WebSocket turn coordinator
    (decomposed into explicit host objects: `WsHost`, `TurnCoordinator`,
    `SessionCatalog`), session catalog with bundled SQLite migrations, brain/
    files/voice routes, and injected seams for the static client build and the
    PNG/PDF renderer.
  - **New `@schlessera/brain-ui-react`**: the chat/files/voice React components,
    stores, and WS transport. The chat store now keeps a transcript buffer per
    session (plus a draft buffer), so background sessions accumulate instead of
    being discarded. Ships prebuilt JS + d.ts, a precompiled `styles.css`, and a
    `theme.css` source entry for Tailwind v4 consumers. Branding copy is
    configurable via `configureBrainUi()`.
  - **ui-sdk**: add `PasskeySummary` to the protocol (REST payload of the
    passkey management routes, previously local to brain-ui).

### Patch Changes

- Updated dependencies [2c42696]
  - @schlessera/brain-ui-sdk@1.0.0
  - @schlessera/brain-backend-claude@1.0.0
  - @schlessera/brain-backend-pi@1.0.0

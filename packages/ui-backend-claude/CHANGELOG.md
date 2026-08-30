# @schlessera/brain-backend-claude

## 0.29.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.29.0

## 0.28.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.28.1

## 0.28.0

### Minor Changes

- d4fcf65: "Always allow" per tool.

  - Approval cards gain an **Always allow** button: the host remembers the
    tool (server `settings` table) and answers its future requests without a
    card — for both backends and any extension/MCP tool, since the grant is
    applied host-side in the ws bridge before a card is ever emitted.
  - Permission requests now carry a `kind`: `"tool"` (grantable) vs
    `"command"` (a destructive-bash confirm-pattern confirmation). Kind
    "command" can neither be remembered nor auto-answered — the client hides
    the button and the host refuses a tampered `always` flag — so the
    destructive-command seatbelt stays per-use.
  - Settings → Models gains an **Always-allowed tools** list with per-tool
    revoke (`GET/DELETE /api/tool-permissions`).
  - Wire protocol: additive `always?: boolean` on `tool_approval`, additive
    `kind?` on `tool_approval_request` (re-delivered cards included).

### Patch Changes

- Updated dependencies [d4fcf65]
  - @schlessera/brain-ui-sdk@0.28.0

## 0.27.0

### Minor Changes

- afbe784: pi backend parallelism.

  - **Keyed locks replace the pi backend's global write mutex**: file writes
    lock per path, brain document tools share one key, and bash locks the
    repo-git key only for git-staging/history and brain-CLI write commands
    (`bashLockKey`, shared with the Claude backend via ui-sdk). Builds, greps
    and other read-shaped bash run lock-free, so pi's parallel sibling tool
    calls and parallel sessions actually execute in parallel. Injecting the
    legacy `writeLock` option restores whole-lock serialization.
  - **`subagent` fan-out**: the `pi-subagents` extension's tool joins the
    default allowlist (parity with Claude's auto-allowed Agent tool), and the
    system-prompt brief names it when the package is installed.
  - **Backend-honest execution brief**: `buildSystemPromptAppend` gains an
    `execution` option (subagent tool name, per-turn-process semantics,
    parallel tool calls). The Claude backend's text is unchanged; pi's brief
    now tells the model to batch independent tool calls (they run
    concurrently) and no longer references subagents it doesn't have.

### Patch Changes

- Updated dependencies [afbe784]
  - @schlessera/brain-ui-sdk@0.27.0

## 0.26.0

### Minor Changes

- 8b41fc3: pi backend parity with the Claude backend.

  - **Approvals**: mutations no longer each raise a card. A single `tool_call`
    permission gate (inline extension, fires before every tool — curated and
    extension-registered) implements the Claude posture: allowlisted tools run
    free, destructive bash shapes confirm (shared
    `DEFAULT_CONFIRM_BASH_PATTERNS`, moved to `brain-ui-sdk/server`),
    non-allowlisted tools ask. `brain_archive` keeps its card.
  - **Context**: both `AGENTS.md` AND `CLAUDE.md` load when the brain repo has
    both (pi previously took AGENTS.md alone — the Claude backend reads
    CLAUDE.md, so the two backends saw different instructions). The
    system-prompt append is now built per session from the opening turn's
    client environment and turn budget, like the Claude backend's per-turn
    brief.
  - **Tools**: curated surface extended to the full brain MCP set
    (`brain_read`, `brain_list`, `brain_graph`, `brain_update`,
    `brain_archive`) plus bridge-backed `get_current_location` (reverse
    geocoding shared via `brain-ui-sdk/server`), `query_activity`, and
    `request_image_mask`, each registered per host capability.
  - **Extensions**: `loadExtensions` now defaults to true — the gate covers
    extension tools. Recommended: `pi-web-access` (web search/fetch,
    auto-allowed like Claude's WebSearch/WebFetch) and `pi-mcp-adapter` (MCP
    servers from `.mcp.json`, prompted like non-allowlisted MCP tools).
  - **rtk**: when the `rtk` binary is on PATH, both backends route bash
    commands through rtk's rewrite oracle (`git status` → `rtk git status`,
    60-90% less output for the model to read). Applied after gating, so
    confirm patterns see the original command; absent rtk changes nothing.
  - **Upstream bump**: pi SDK 0.80.10 → 0.84.4 (`pi-coding-agent`,
    `pi-agent-core`, `pi-ai`). Verified: event mapping already delta-based
    (0.84's `message_update` change), auth already on the `ModelRuntime` API,
    extension install + load re-tested on 0.84.4.
  - **Web search settings**: new Settings → Models → "Web search" card (pi
    deployments only). Provider select defaults to Auto — Exa's free keyless
    tier — with per-provider API keys (Exa, OpenAI, Brave, Tavily, Perplexity,
    Firecrawl, Jina, Kagi, Gemini) stored server-side in the pi config dir's
    `web-search.json`, the file pi-web-access reads. Key values never travel to
    the client; hand-edited config fields beside the managed ones survive; a
    save clears pi's extension cache so new conversations pick the change up.

### Patch Changes

- Updated dependencies [8b41fc3]
  - @schlessera/brain-ui-sdk@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [02552ed]
  - @schlessera/brain-ui-sdk@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [88c03d9]
  - @schlessera/brain-ui-sdk@0.24.0

## 0.23.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.23.0

## 0.22.0

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

- Updated dependencies [d4261bb]
  - @schlessera/brain-ui-sdk@0.22.0

## 0.21.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.21.0

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

- Updated dependencies [d97dbd0]
- Updated dependencies [00565d5]
  - @schlessera/brain-ui-sdk@0.20.0

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

## 0.16.0

### Patch Changes

- Updated dependencies [a7362e1]
- Updated dependencies [7ea32f7]
- Updated dependencies [0fc9c44]
  - @schlessera/brain-ui-sdk@0.16.0

## 0.15.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.15.0

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

## 0.13.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [2be49b8]
- Updated dependencies [2be49b8]
  - @schlessera/brain-ui-sdk@0.13.0

## 0.12.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [4281c59]
  - @schlessera/brain-ui-sdk@0.12.0

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

### Patch Changes

- Updated dependencies [604abbc]
- Updated dependencies [cdfa039]
  - @schlessera/brain-ui-sdk@0.11.0

## 0.10.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.10.0

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

## 0.8.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.8.0

## 0.7.2

### Patch Changes

- @schlessera/brain-ui-sdk@0.7.2

## 0.7.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [b8cbf72]
  - @schlessera/brain-ui-sdk@0.7.0

## 0.6.3

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.3

## 0.6.2

### Patch Changes

- eb0a6ba: Auto-allow the brain's own MCP document tools in the Claude backend

  `DEFAULT_ALLOWED_TOOLS` now covers `mcp__brain__brain_{search,context,read,list,graph,add,update}`.
  Since the brain repo started registering the CLI's MCP server project-scoped in
  `.mcp.json`, those tools reached the model but were absent from the allowlist,
  so every `brain_read` raised an approval card. `Write` and `Edit` were already
  auto-allowed, so withholding `brain_add`/`brain_update` only pushed the model
  onto the raw-file path, which skips frontmatter and the reindex.

  `brain_archive` stays behind an approval card — it moves files between
  directories.

  Also fixes a latent write-serialization gap: all three brain writers are now in
  `MUTATING_TOOLS`, so they take the cross-session write lock like `Edit` and
  `Write`. Previously two parallel sessions could reindex the repo concurrently.

  - @schlessera/brain-ui-sdk@0.6.2

## 0.6.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.1

## 0.6.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.0

## 0.5.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.5.1

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
  - @schlessera/brain-ui-sdk@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [2c42696]
  - @schlessera/brain-ui-sdk@1.0.0

## 0.3.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.3.0

## 0.2.1

### Patch Changes

- Republish with correct internal dependency pins. The 0.2.0 manifests pinned
  cross-dependencies to 0.1.0, a version that was never published, making five
  of the eight packages uninstallable.
- Updated dependencies
  - @schlessera/brain-ui-sdk@0.2.1

## 0.2.0

### Minor Changes

- rename brainform to brain-kit

### Patch Changes

- Updated dependencies
  - @schlessera/brain-ui-sdk@0.2.0

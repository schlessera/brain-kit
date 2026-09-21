# @schlessera/brain-ui-sdk

## 0.36.0

### Minor Changes

- 9827a47: `message_blocks` (protocol rev 4, additive) and the classification module
  (D42). A host may classify a finished turn's assistant markdown into the
  kit's answer blocks and send one `message_blocks` frame after the turn's
  `result`; replayed history carries the same objects on `blocks`. The SDK
  holds the deterministic half — `detectCandidates` walks a text part's
  markdown for tables, ordered lists, timed lists, blockquotes and
  key-value runs with exact character spans — and the catalogue that
  generates one classifier request from the candidates and turns the answers
  back into D41's `Block` union, re-validated against the block schema. No
  network here: the transport is the server's.

  Code spans and emphasis inside a candidate flatten to their text; only
  links, images and raw HTML keep a candidate as markdown, since those are
  the inline forms whose meaning a plain cell would lose.

- bbc90ab: Map geometry for anywhere, not just the five fixture locations.

  `MapView` draws whatever `[lon, lat]` paths it is handed and fetches nothing —
  that is D13 and it stays that way. What was missing was the other half: a
  server that can produce those paths for an arbitrary place. Without it the kit
  had real coastline for five Mediterranean islands and a bare graticule
  everywhere else, which is a demo rather than a feature.

  `@schlessera/brain-ui-sdk/server` gains `fetchCoastline` and the pure geometry
  behind it — `clipLine` (Liang-Barsky), `simplify` (Douglas-Peucker),
  `toleranceMetres` and `prepare`. The build-time fixture pipeline shells out to
  mapshaper, which is 15 MB and 31 dependencies for exactly two operations;
  pulling that into a server to run per request would be the wrong trade. What
  must NOT be hand-rolled is polygon ring closure, which D25 measured getting
  three of five locations wrong — that is fill, and this does not attempt it.

  Validated against the tool it replaces rather than assumed: the same Overpass
  response through both pipelines gives **identical extents to four decimal
  places**, with 16% more vertices and more separate polylines because mapshaper
  joins contiguous ways.

  `@schlessera/brain-ui-server` gains `GET /api/geo/coastline?bbox=w,s,e,n`,
  fetched once and cached on disk forever. The cache is not an optimisation, it
  is what makes using a free shared service defensible: Overpass's usage policy
  is written for light interactive use, and one request per place ever is that.
  Coastlines do not move, so there is deliberately no TTL. Keys are quantised to
  ~110 m and bucketed by render width so near-identical views share an entry, and
  concurrent requests for one place collapse to a single fetch.

  It cannot return a 500. Every failure path is empty geometry with a 200,
  because a map without coastline is still a correct locator and a 500 is a chat
  message that will not render. An empty result is never cached, so an outage
  does not become permanent.

  Four new environment variables, all optional: `BRAIN_UI_COASTLINE`,
  `OVERPASS_URL`, `OVERPASS_USER_AGENT`, `COASTLINE_CACHE_DIR`.

- 6b57843: Add UI roots and a React provider with independent stores, persistence, request
  caches, renderer/ASR registries and WebSocket lifetimes. Store hooks select from
  the nearest provider; connection handlers close over that same root. Multiple
  consumers share one socket within a root, and disposing it releases its resources.

  Add an ASR registry factory to the SDK. The default application entry points
  remain available. Component API/config migration is still in progress, so this
  does not yet make the entire application safe for separate backends in one page.

- b3a3ffd: Map geometry picks its detail from how much ground fits on screen.

  A coastline is the right answer for a region and the wrong one for a street: at
  a kilometre across, a shoreline is one curve at the edge and the map is empty
  except for its own pins. `fetchCoastline` now chooses between three tiers —
  shape only, the road network, every street — and the caller does not ask, so it
  cannot get it wrong.

  The thresholds are the same one-pixel reasoning the simplification tolerance
  uses, applied to the SPACING of a feature class rather than to its detail.
  Major roads sit roughly a kilometre apart and read as a network below ~40 m/px;
  minor streets sit roughly a hundred metres apart and need ~8 m/px before they
  are twelve pixels apart. `detailFor(bbox, widthPx)` is the rule, and `detail`
  on the request forces a finer tier for the one case a size rule cannot see — a
  single shoreline curve at a span the rule calls coastline-sized.

  Each tier's query now degrades on its own. The street tier is three sequential
  requests and a free service under load refuses them individually; all-or-nothing
  threw away a perfectly good coastline because the minor streets timed out. The
  result reports `partial` when that happens, and the server route declines to
  cache a partial — the cache has no TTL, so a bad afternoon would otherwise
  become a street map that never gets its streets.

  `GET /api/geo/coastline` takes `detail=` and keys its cache by tier: the same
  box at the same width can legitimately be asked for at two levels, and serving
  the coarse one for the fine request draws an empty map.

- 2c9e5d3: MapView: a subtle land fill, and a projection that no longer stretches.

  **Land.** A coastline stroke says where the edge is and not which side of it is
  water, which is the first thing a reader needs. `MapView` gains a `land` prop —
  separate from `paths`, because a route is a line somebody travelled and land is
  the ground it was travelled over — drawn as one `<path>` with `fill-rule:
evenodd` so a lagoon inside an island comes out as a hole. `--bk-map-land` is 6%
  white; 3.5% was tried first and was genuinely invisible.

  Islands only, and that is a measured decision rather than a limitation accepted
  by default. An island's coastline stitches head-to-tail into a closed loop and
  is land beyond argument; a mainland shore has to be closed against the viewport,
  which D25 measured getting three of five locations wrong. Verified before
  building that OSM's land-on-the-left winding holds — 486 of 486 closed rings
  counter-clockwise — so the mainland case is now a contained second step rather
  than a research problem.

  `@schlessera/brain-ui-sdk/server` gains `closedRings` and `prepareLand`. Ring
  simplification splits at the two most distant vertices so the loop cannot be
  opened, and land is built from RAW ways: clipping and simplifying both move
  endpoints, and a way whose endpoint moved no longer meets its neighbour.

  **The projection.** It mapped longitude across the full width and latitude
  across the full height independently, so a degree of each stopped being the same
  distance on screen — an island got wider as the window did and the scale bar was
  only true east-west. The projection is now built for the width the card actually
  is, and the bbox is expanded on its short axis until one pixel is the same
  distance both ways. Expanded, never cropped: a wider card shows more ground at
  the same scale rather than the same ground stretched.

  `spanKm` consequently means the span across the WIDTH. Applied to both axes it
  made a card captioned "18 km" draw forty, because with one scale a minimum on
  the short axis lets the long one show roughly twice it.

- edb547b: `show_block`: the kit's answer blocks reach the model through one tool (D41).

  A new tool component contract, `SHOW_BLOCK_CONTRACT`, whose argument is a
  discriminated union of eleven data-only blocks — `comparison`, `stats`,
  `trend`, `table`, `bars`, `receipt`, `steps`, `timeline`, `schedule`, `quote`
  and `contact` — each mirroring the props of the kit component that draws it.
  The tool has no side effect: `handleShowBlock` validates and echoes, so the
  payload is the input and it needs no bridge. It joins `BRIDGE_TOOL_CONTRACTS`
  and the auto-allow posture, `SurfaceTools` gains `block`, and the generated
  prompt paragraph carries a brief that says when a block beats prose while the
  description carries the shape rules. The schema's tone lists are exported as
  runtime constants so a consumer can assert them against the kit's unions.

  The brief leads with the one rule the model most often breaks — never a
  markdown table, call the tool — and the description opens with the same
  redirect, because a table the model would have typed is a `comparison` or
  a `table` block that was not drawn.

- f5512f7: Tool component contracts: one declaration per tool, read by both halves.

  A tool that renders as a component was previously described in four places at
  once — a name constant, a description constant, an input schema, a payload
  interface the handler happened to return, and a hand-written paragraph in the
  system prompt. Nothing tied them together, so a tool could be schema'd and
  never described to the model, and a renderer could be typed for a payload the
  handler had stopped sending.

  `@schlessera/brain-ui-sdk/tool-contracts` is now the single declaration:
  `{ name, description, input, brief }`, plus `payload` for a tool whose result
  is meant to be drawn rather than read. It is React-free and free of node
  built-ins, so the server builds its tool definitions and prompt brief from the
  same object the browser parses payloads with. The four bridge tools —
  `ask_user`, `get_current_location`, `request_image_mask`, `query_activity` —
  are declared there; the handlers stay in `/server` and both barrels re-export
  the contracts, so backend import sites are unchanged.

  What this closes:

  - The prompt's tool paragraph is GENERATED from the contract list. Adding a
    contract without deciding how a backend declares its tool is a `tsc` error.
  - Payload schemas are bound to their interfaces in both directions by a
    compile-time equality test, so a schema that drifts from what the handler
    returns fails the typecheck rather than a renderer at runtime.
  - `pi`'s `request_image_mask` now serialises its payload into `output` like
    every other payload tool, instead of reporting a sentence. That is a
    deliberate change to what the model sees, and it carries the `note` field pi
    used to drop.
  - Both backends convert input schemas through one helper, so the same tool
    advertises the same JSON Schema on either adapter.

## 0.35.0

### Minor Changes

- f89897b: Attribute activity spans, append-only approval decisions, and durable run rollups to principals, with historical label and kind snapshots that survive retention pruning.

## 0.34.1

### Patch Changes

- aade466: Show when the server refuses the live connection, including a specific connection-limit message and a retry action, instead of leaving the composer on “Connecting...” forever.

## 0.34.0

### Minor Changes

- 4adb327: Added the published backend contract harness and moved both first-party backends onto it.
- 17706aa: Add the shared permission-decision core and split backend factories into focused turn, usage, and runtime modules.
- c6d9a30: Add self-describing backend modules and make the server registry iterate their profile, settings, billing, credential, and discovery hooks.

  Preserve descriptor resolution hooks and model discovery when a third-party backend is passed by value through the static registry, and validate active backend-owned profile rules before startup completes without requiring or strictly parsing inactive backend packages.

  Change session routing to reject an unknown non-empty stored backend id instead of silently substituting the default; null and empty legacy ids still use the default.

### Patch Changes

- a41e81a: - Define the four browser bridge tools once in the UI SDK while preserving Claude's names, descriptions, schemas, and result envelopes.
  - Reject NUL, absolute, traversal-escape, and symlink-escape paths before either backend writes an image mask.
  - Give pi's `ask_user` the full shared description, 1–4 question and 2–4 option bounds, a 12-character header bound, and optional option previews.
  - Require pi's `ask_user.multiSelect` instead of defaulting it to `false`.
  - Return pi's shared `ask_user` payload (echoed questions, answers, and annotations) to the model while keeping the full `AskUserResult` in details.
  - Advertise and validate pi's `query_activity.scope` as the shared enum.

## 0.33.1

### Patch Changes

- 5b7fb32: Restrict repo-owned subprocess environments by audience, preserve first-party CLI and module capability settings, and add an operator allowlist escape hatch. Pi extensions (`pi.exec()` through `execCommand()`) and pi's package-manager helpers still inherit the full server environment because pi 0.84.4 exposes no supported environment option; 0.35.0 moves the pi runtime under the `agent` uid to close that in-SDK residual.

## 0.33.0

### Minor Changes

- 07d63eb: Add the injected service-worker policy and shared hash-routing and update-safe reload hooks.

### Patch Changes

- 95a180c: Guard protocol schemas with exact type-level parity checks and align existing server-frame validators.

## 0.32.0

### Minor Changes

- ec340d2: Add the experimental audience-tagged subprocess environment descriptor and strip server-only credentials from brain CLI and agent subprocesses while retaining agent authentication, git credentials, and unknown operator variables.

## 0.31.0

## 0.30.1

## 0.30.0

### Minor Changes

- eac9b98: feat: web search providers are toggles, and the agent knows which are live

  Settings → Models → Web search replaces its single provider dropdown with
  per-provider toggles (Exa, DuckDuckGo, Brave, Jina, Perplexity, Tavily,
  OpenAI, Gemini, Firecrawl, Kagi), each with its own API-key field, cost note
  and description.

  Enabled providers are written to `web-search.json` as an ordered
  `searchRouting.providers` chain sorted cheapest-first, with every failure kind
  in `fallbackOn`. An ordinary search is answered by a free provider; a paid one
  like Perplexity is only reached when the cheap ones fail, or when the agent
  asks for it by name.

  The pi backend's system prompt now names the providers that are actually
  reachable. This matters because `pi-web-access` hard-codes ~28 provider names
  into its own tool description regardless of configuration — a model reading
  only that will ask for a provider with no key and get an error. The brief also
  carries the cost gradient, so the agent knows to leave `provider` off unless a
  question warrants a specific one.

  Two hazards are now handled explicitly:

  - A `provider`/`searchProvider` key in `web-search.json` overrides
    `searchRouting` entirely, and pi's own `/curator` command writes one back.
    Writes here delete both keys, and the settings UI reports a stray one as an
    override rather than showing a chain that is not running.
  - A provider with no credential is skipped at search time, so enabling one is
    refused up front. Credentials are detected from the config file _or_ the
    environment, so a key supplied as `PERPLEXITY_API_KEY` counts.

  The provider catalog, path resolution and override rules now live in
  `@schlessera/brain-ui-sdk/server` (`WEB_SEARCH_PROVIDERS`, `webSearchBrief`,
  `resolveWebSearchConfigPath`), replacing three hand-maintained copies.

## 0.29.0

## 0.28.1

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

## 0.25.0

### Minor Changes

- 02552ed: Per-model reasoning effort, editable in Settings → Models.

  - Effort-capable rows (the pi backend's profiles — Claude rows have no effort
    knob) get a tri-state effort select next to billing: "Default (<level>)"
    shows the configured level, an explicit pick is stored server-side
    (`PUT /api/models/thinking`, full record like hidden/billing) and applies
    to the NEXT new session — no env edit, no redeploy. Resumed sessions stay
    pinned.
  - `ProviderInfo.thinkingLevel` (additive) carries the effective level, and
    its presence marks a profile as effort-capable; `ModelCatalogEntry` gains
    `thinkingOverride`. `ThinkingLevel`/`THINKING_LEVELS`/`isThinkingLevel`
    join the sdk protocol.
  - `CreatePiBackendOptions.profiles` also accepts a function, re-read on every
    roster listing and model resolution, which is how the host applies settings
    overrides live.

## 0.24.0

### Minor Changes

- 88c03d9: Configurable default model, user-managed OpenRouter models, auto-collapsing
  thinking.

  - **Default model** (Settings → Models): the profile used when a turn names
    none — a fresh device's first conversation, a share filed into the brain,
    host-initiated actions. Stored server-side; "Auto" prefers a CONNECTED
    subscription account (pi's `openai-codex` — probed via the new
    `hasStoredCredential()` export, a cheap read of pi's auth store) and falls
    back to the built-in default. The resolved default also leads
    `/api/providers`, so a fresh picker lands on it.
  - **OpenRouter models** (Settings → Models): add or remove models by id
    (e.g. `z.ai/glm-5.3-flash`) with no env edit or redeploy. Stored ids join
    the Claude roster as declared OpenRouter profiles (api-billed via
    `OPENROUTER_API_KEY`); removing the model behind the stored default resets
    the default to auto.
  - **Thinking sections auto-collapse** when their streaming completes,
    leaving the "Thought for ~N tokens" affordance to reopen them.

## 0.23.0

## 0.22.0

### Minor Changes

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

## 0.21.0

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

## 0.17.0

### Patch Changes

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

## 0.15.0

## 0.14.0

## 0.13.1

## 0.13.0

### Minor Changes

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

- 2be49b8: Answer a system share in the service worker

  Second phase of the Android share target: `@schlessera/brain-ui-sdk/share-target`
  is a new export holding the service-worker half — `registerShareTarget()`,
  `handleShareTargetRequest()`, and an IndexedDB store that parks the payload
  until the app can upload it.

  A POST share target is a cross-site POST _navigation_, and it has to be answered
  locally rather than by a server route, for two independent reasons. The session
  cookie is `SameSite=Strict`, which is exactly the case such a navigation does not
  carry — a server route would see an unauthenticated request with the payload
  already consumed and unrecoverable. And answering locally keeps the payload on
  the device until the app is authenticated and online, so a share made offline or
  logged out is queued rather than lost. The handler therefore stashes the payload
  and redirects to the app with `?share=<id>`.

  It never rejects and never hangs: a browser mid-navigation has to land
  somewhere, so a body that will not parse (what Chrome produces when the
  manifest's `accept` lists an extension without its MIME type), an empty share, a
  share past the caps, or a store that refuses — or takes longer than five seconds
  to accept — the write each redirect with `?share_error=` for the app to explain.
  The timeout matters because `indexedDB.open()` can hang with no event at all on
  a corrupted backing store, and an unsettled response promise is a blank tab.

  The caps the server enforces are enforced here too, before anything touches the
  device: an oversized body is refused on `content-length` before `formData()`
  buffers it whole in the worker, and file count, per-file size, total size and
  text length are checked after parsing. Otherwise a share is written to the
  user's own phone first and only refused minutes later, on upload.

  `ShareStore.take()` reads and deletes in one transaction. The shell reloads
  itself when a new worker takes over and a reload keeps the query string, so
  `?share=<id>` can be read twice; the atomic claim is what stops one share being
  filed into the knowledge base twice.

  Anything reachable by the share sheet is also reachable by any website — a page
  that auto-submits a cross-site form to the action URL is indistinguishable from
  a real share, and `Sec-Fetch-Site` cannot tell them apart from inside a worker.
  A stashed share is therefore untrusted input, and the client intake that follows
  shows it on a confirmation card rather than acting on it.

  The stash is bounded: after each successful stash the handler prunes records
  older than `SHARE_STASH_TTL_MS` (24h), so a share abandoned behind a login
  prompt does not sit on the device holding whole files forever.

  No Workbox dependency — a plain `fetch` listener works with or without a router,
  and Workbox's own routes are GET-only by default, so nothing competes for the
  POST. It is a separate export subpath so a service worker can import it without
  dragging in the renderer and ASR registries that `./client` holds. Persistence
  stays concrete — the swap and in-memory implementations are named `*ForTests`
  and are not part of the package's public exports, so this is a test hook and
  not a storage seam.

  `@schlessera/brain-ui-react` gains a dev-only `ShareHarness` component: it posts
  the same multipart body to the same path from inside the page, through exactly
  the same handler, stash and redirect. Everything except the manifest
  registration itself can be verified without reinstalling the PWA — which on
  Android means waiting for a WebAPK update.

## 0.12.1

## 0.12.0

### Patch Changes

- 4281c59: Fix three things a real session on a phone turned up

  - **Images written into the brain did not display in chat.** The markdown
    renderer overrode headings, code and links but not `img`, so
    `![](assets/images/x.png)` resolved against the app origin and 404'd — the
    bytes are served by the files API. Repo-relative sources are now rewritten to
    that endpoint; `data:` URIs and absolute URLs pass through untouched.
  - **Scratch files had nowhere to go.** `brain render` and `brain image` refused
    any path outside the repo, which pushed intermediates — an HTML file that
    exists to be rendered two seconds later — into a knowledge base as git noise.
    Both now also accept paths under the system temp directory, report them
    absolute, and say that a file written there is not viewable in a UI. Anywhere
    else is still refused: this is scratch space, not free rein.
  - **The generate-pdf skill refused documents over 400 KB**, citing a file-viewer
    download limit that does not exist. The real ceiling is the file server's
    (10 MB, both the preview and raw paths); below that, size is a judgement call
    about the reader's connection. The skill no longer refuses to produce a
    document for being over an invented figure.

  Also corrects a comment on `FILE_SIZE_CAP_BYTES` claiming the `?raw=1` path was
  unbounded. It is not — `resolveForRaw` enforces the same cap, which is why
  raising it to 10 MB mattered for images and PDFs in the viewer too.

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

## 0.10.0

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

## 0.8.0

## 0.7.2

## 0.7.1

## 0.7.0

### Minor Changes

- b8cbf72: Knowledge-graph view: `brain graph` command and schema-v8 derived tables
  (metrics, communities, root distances, precomputed ForceAtlas2 layout) built
  at index time; `/api/graph/*` REST endpoints served from read-only brain.db
  access; a full-screen GraphPage with Clusters, Discovery, Local, and
  Maintenance modes rendered via a lazy-loaded sigma.js WebGL canvas.

## 0.6.3

## 0.6.2

## 0.6.1

## 0.6.0

## 0.5.1

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

## 0.3.0

## 0.2.1

### Patch Changes

- Republish with correct internal dependency pins. The 0.2.0 manifests pinned
  cross-dependencies to 0.1.0, a version that was never published, making five
  of the eight packages uninstallable.

## 0.2.0

### Minor Changes

- rename brainform to brain-kit

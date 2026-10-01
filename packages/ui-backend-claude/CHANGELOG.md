# @schlessera/brain-backend-claude

## 0.39.0

### Minor Changes

- f5a8f81: The model can offer up to two follow-ups under its answer (#40). `show_block` gains a thirteenth kind, `suggestions`: `label?` and `items[1..2]{label, icon?}`, each label one line of 4-80 characters. That is the data of the kit's `SuggestionChips` without `tone`, and a type test holds the two together in both directions. Both backends offer it through the tool description; the per-turn brief is unchanged.

  `@schlessera/brain-ui-react` draws the turn's last valid call as the answer's closing row, a row of chips after the text and share menu, never where the call was made. A chip puts its words in the composer, below any draft, and never sends: no message, no answer to a pending question, no approval. The row is gone once the reader sends anything. It is not drawn while the turn runs, while a question in the turn is unanswered, when the answer ends in a question, while voice holds the composer, or on a turn spoken in a voice conversation. The client also drops duplicates, a restatement of the reader's own question, and generic filler. The decision reads only the transcript and current state, so a replayed session draws what the live one did. Shares and prints leave suggestions out, and the welcome chips are unchanged.

### Patch Changes

- Updated dependencies [f5a8f81]
- Updated dependencies [ba23fcc]
- Updated dependencies [cf94a81]
- Updated dependencies [e5d3cc0]
- Updated dependencies [b8c355d]
- Updated dependencies [9342cd2]
  - @schlessera/brain-ui-sdk@0.39.0

## 0.38.0

### Patch Changes

- aec3dd8: The container privilege record moved to brain-hosting-template, which builds the container. The exec wrapper's cancellation error message and the comments that cite the record now point there.
- 4224247: Source comments, the `BRAIN_UI_CHROME_NO_SANDBOX` description, and the `generate-pdf` and `image-gen` skills no longer describe one particular deployment. They say what a deployment may or may not have instead.
- Updated dependencies [8c1daaa]
- Updated dependencies [aec3dd8]
- Updated dependencies [a9094fb]
- Updated dependencies [1d29fcd]
- Updated dependencies [94fd8c9]
- Updated dependencies [70a5502]
- Updated dependencies [2d985ba]
- Updated dependencies [d350daa]
- Updated dependencies [e4b5251]
- Updated dependencies [4224247]
  - @schlessera/brain-ui-sdk@0.38.0

## 0.37.0

### Minor Changes

- 907e8bc: Archiving a document through `brain_update` now raises an approval card.

  Archiving is confirmed because it is a visibility change: an archived document
  drops out of search, briefings and context assembly, so a silent archive shows
  up later as holes in output nobody can account for. Two paths to it stopped for
  approval — `brain_archive` is off the default allowlist, `brain archive` matches
  a confirm pattern — and a third did not. `brain_update` takes the same `status`
  field and is auto-allowed, so `status: "archived"` made a document invisible to
  every later search with no card, no confirmation and no record.

  `decideToolPermission` now raises a per-use confirmation for a document update
  that sets `status: "archived"`, and both backends pass it their spelling of the
  tool (`updateToolName`). It is deliberately a per-use confirmation, never a
  grantable tool approval: a remembered "always allow" would reopen the hole for
  good.

  Nothing else changes. An update with no `status`, or with `"active"` or
  `"draft"`, runs unprompted exactly as before — this is not a card on every
  document edit. `brain_update`'s MCP input schema, output shape and name are
  untouched.

- 2efd725: The Claude backend's bridge tools — `show_block`, `ask_user`,
  `get_current_location`, `request_image_mask` and `query_activity` — are now in
  the model's context on every turn instead of behind a tool search it had to
  decide to run. The Agent SDK defers an MCP server's tools by default, so until
  now a bridge tool was only reachable once the model went looking for it, and
  the one thing that sent it looking was a line of prompt text naming the tool.
  Measured over 108 live turns, `show_block` fired on 56% of turns that way
  against 78% with the tools loaded, and on none at all when that prompt line was
  removed. Turns cost about 6% more and start no slower.
- 6ae12e7: A destructive-command approval card now says what the command will do.

  - Added: each default confirm pattern carries an `effect` phrase ("delete a directory and everything inside it"). A `command` approval's reason is that phrase, and both approval cards show it.
  - Changed: `DEFAULT_CONFIRM_BASH_PATTERNS` entries are `{ pattern, effect }`. `confirmBashPatterns` and `compileConfirmPatterns` accept that form or a bare regex source; a bare source keeps the old generic sentence.
  - Changed: `BRAIN_UI_CONFIRM_BASH` accepts the object form too. A non-empty list with no entry of a usable shape now means the defaults rather than "no confirmation". A list whose patterns are all invalid regexes still compiles to none (#251).

- 4ed02fb: An approval that comes back with an edited input is re-checked before it runs, on both backends.

  - Added: `checkEditedApproval` in `@schlessera/brain-ui-sdk/server`.
  - Changed (pi): an edit that needs a confirmation the card did not show (another confirm pattern, another archived document) is refused instead of applied.
  - Changed (Claude): an edited confirmation that passes the re-check is applied instead of refused, as `updatedInput` with no `permissionDecision`. `canUseTool` re-checks edits too, and the rtk rewrite leaves a confirmed command alone.

- 7b6b2b0: An approval that edits a confirmed shell command into a different command that still needs confirmation is now refused.

  - Changed: `checkEditedApproval` identifies a shell confirmation by the command text as well as the pattern. `brain archive a.md` can no longer be approved as `brain archive b.md`, and a narrower command (`rm -rf notes` → `rm -rf notes/old`) must be re-issued and confirmed as it is. An edit that needs no confirmation of its own is still applied.
  - Changed: an edited input carrying an own `__proto__` key is refused on both backends, instead of being merged into the tool arguments.
  - Changed: `requestToolPermission` hands back an approval's edited input as one plain JSON snapshot, so what is checked is what runs; an edit that is not a plain object or will not serialize is denied.

- ecc93b9: A turn can declare `enforceAllowedTools`, and a tool its allowlist leaves out
  is then no longer re-admitted without a decision.

  Several things used to re-admit it, which is the point rather than the number.
  The Claude backend's input-rewrite hooks answered `permissionDecision: "allow"`
  so their `updatedInput` would apply, which makes the runtime skip `canUseTool`
  entirely — an rtk-rewritten shell command ran in a turn whose allowlist had no
  `Bash` in it, with no card and no record. The ws host answered from its
  remembered "always allow" grants before any card existed, so a grant given
  under a wide posture was honoured under a narrow one. And the runtime admits
  some calls on its own before the callback is reached at all — by the shape of a
  shell command, by the tool being a built-in, or because a hook declared in the
  project settings said so.

  Under the declaration the rewrites still rewrite — `updatedInput` applies
  without a decision attached, so the rewrite was never what the grant was for —
  a PreToolUse hook answers "ask" for every off-list tool, which overrides the
  runtime's own auto-approval, and the host neither answers from nor adds to its
  grant store for a tool outside the turn's allowlist. Backends mark such
  requests `outsideEnforcedAllowlist` so the host does not have to guess, and it
  records both halves of the refusal — a grant it declines to apply, and an
  "always allow" it declines to keep. A turn
  that declares nothing is unchanged, and existing grants keep working on the
  postures that can honour them.

- d33492e: The server now knows which Claude Code ran.

  - **At boot**, `createApp()` probes the binary a turn would spawn: the one the Agent SDK selects, run through the exec wrapper with a turn's environment. It refuses to start when that binary is missing or will not answer `--version`, instead of failing the first turn. It warns, naming both pairs, when the runtime is not the Claude Code / Agent SDK pair the backend was measured against (`MEASURED_RUNTIME`).
  - **Per turn**, each run's root span records the Claude Code version that ran and the SDK version. It also records the credential the CLI selected and the billing mode that credential implies. That mode is checked against the profile's policy: a profile without its own credential requires the subscription, and a run that contradicts it is flagged, with a WARN log.
  - **Auth failures** (`authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, and a turn the subscription check refused) are recorded as their own failure class.
  - **Model discovery** now reports a refused credential as an auth failure instead of returning an empty roster.
  - **`/api/status`** (behind the auth guard) gains `runtime`: what boot found, what the last turn ran on, and the last auth failure.

  `BackendActivityEvent` gains `runtime_observed` and `auth_failure`. `BackendModule` gains the optional `probeRuntime`.

  **Host impact:** a host whose `CLAUDE_CODE_PATH` (default `/usr/local/bin/claude`) names no working binary now fails at boot rather than on the first turn.

- 54eea05: `BRAIN_UI_EXEC_WRAPPER`: an absolute path to an executable that agent and brain
  CLI subprocesses are launched through, as `<wrapper> <program> <args…>`. It lets
  a host run those children as another user without the packages knowing how. The
  wrapper is an argv[0], never a command line — no shell parses it, so a value
  full of metacharacters is a filename rather than a command. A wrapped child
  leads its own process group and an abort signals the group, because a uid drop
  otherwise makes `kill(2)` fail with EPERM and leaves an aborted turn running.

  Every brain CLI launch is covered too, not only the agent's tool spawns — and
  scheduled cron jobs with them: the CLI imports the repository's
  `brain.config.ts`, so a search executes repository code exactly as a tool call
  does. When a wrapper is configured the program is resolved to an absolute path,
  because a wrapper execs its target directly and because `PATH` must not get to
  choose which `bash` runs.

  `BRAIN_UI_EXEC_KILLER` is the companion seam. `kill(2)` matches uids and group
  membership grants no exception, so once a wrapper has dropped privileges the
  server can signal nothing at all; a host that drops uid supplies an authorised
  helper, invoked as `<killer> <pgid> <TERM|KILL|INT>`. With neither configured,
  and with a wrapper that has not changed uid, the group signal is used directly.
  A cancellation that fails entirely is reported rather than swallowed.

  Unset — which is every existing deployment — every spawn is exactly what it was.

- e08a3ba: `MEASURED_RUNTIME` is now exported: the Claude Code / Agent SDK pair the
  backend's permission design was last measured against. A keyless test fails
  when the installed SDK is not that pair, and
  `scripts/measure-claude-runtime.ts` in the repository re-measures every
  behaviour the backend relies on, against a scripted loopback model, before the
  constant moves.
- 97837c1: A turn that declares `noGrantSurface` without `enforceAllowedTools` is now refused.

  - Added: `assertTurnPosture(req)` in `@schlessera/brain-ui-sdk/server`.
  - Changed: both backends' `startTurn` reject that request with a `BackendRequestError` before anything is emitted. A turn declaring both, `enforceAllowedTools` alone, or neither is unchanged.

- 1de4d6c: A turn can declare `noGrantSurface`, and a permission request it cannot put to
  anyone is then denied instead of parked. `enforceAllowedTools` removed the ways
  a tool got admitted without a decision; what it left was the decision itself —
  an off-posture tool raises an approval card, and in a turn nobody is looking at
  (a spoken one, an unattended one) that is a card nobody can answer, held until
  the turn budget expires.

  Under the declaration both backends refuse the request where it is raised, with
  a message that names the tool and is written to be read aloud, and report it on
  the activity side channel so the record shows a denied span rather than a call
  that errored. Both request kinds are covered, including the confirm-pattern
  `command` request a destructive shell command raises for an allowlisted `Bash`
  — on the Claude backend that one never reaches `canUseTool` at all. The mask
  editor, which opens a window and then blocks on a region someone has to paint,
  is withheld from such a turn rather than offered and blocked on.

  The `ask` the Claude backend's enforcement hook answers is unchanged: it is
  what beats the runtime's own shortcuts, and this changes the decision it
  forces, not the ask. A turn that declares nothing is unchanged, and so is one
  that declares only `enforceAllowedTools`.

- 4d409c0: A run's effective cost is now priced by the route its inference actually took,
  not by model id alone. The two pricing catalogs carry some of the same ids at
  different rates — OpenRouter resells models their vendors also sell directly —
  so a run that went straight to the vendor was being priced at OpenRouter's
  resale rate whenever both catalogs listed its model. On
  `deepseek/deepseek-chat`, live today, that overstates output cost by 2.1x.

  Backends now classify a profile's route (`classifyRoute`, beside
  `classifyBilling`); it is resolved once at run start, rides the root span like
  the billing mode, and selects the catalog inside the rollup. Nothing became
  async: `resolve()` is still synchronous and still never touches the network.

  Coverage does not narrow. A run whose route is unknown — everything recorded
  before this change, or a profile behind a proxy no backend recognises — prices
  exactly as it did before rather than going unpriced. A rate borrowed from the
  catalog a run did not go through still prices the run, flagged as an estimate.
  Unknown cost remains unknown and never renders as `$0`.

- 09d9f4e: The Claude subscription token is minted off the host and rotated by redeploy. The procedure is in `docs/hosting/README.md`, "Claude subscription login". The server's side of it:

  - `BRAIN_UI_CLAUDE_TOKEN_MINTED_AT` records the date the token was minted. It is server-only and set next to the token. From 30 days before the one-year expiry, the server logs a WARN at boot and at most once a day. A token without the date gets one WARN at boot saying the server cannot warn. A date the server cannot read refuses the boot.
  - `/api/status` gains a `subscription` object: `tokenSet` (never the token itself), `mintedAt`, `expiresAt`, and `lastProvenAt` / `provenBy`. The last proof is either the latest successful turn on the subscription, read from the activity store, or a successful model-discovery call with the token. The object also carries `lastAuthFailure` with an `action`.
  - Every auth failure on the subscription logs one WARN with the instruction for it. `relogin` covers a rejected token or a 401 from model discovery. `check_account` covers `oauth_org_not_allowed`, `account_on_hold` and `billing_error`, which a new token will not fix. `check_config` covers `subscription_required`, a turn the backend refused before sending it. `runtime.lastAuthFailure` carries the same `action`. A failure on a profile with its own credential gets no action, and its WARN points at that profile. Credential-shaped text in a runtime message is redacted.
  - `@schlessera/brain-ui-sdk` exports `subscriptionAuthAction`, `SUBSCRIPTION_AUTH_INSTRUCTIONS` and `SUBSCRIPTION_RELOGIN_PROCEDURE`. `BackendModelSourceState` gains `subscriptionProvenAt` and `subscriptionRefused`.
  - The server README's `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` rows now say what those variables do.

- af2affb: A Claude turn on a profile without its own credential now runs on the
  subscription or not at all. Claude Code prefers an `ANTHROPIC_API_KEY` over
  `CLAUDE_CODE_OAUTH_TOKEN`, silently, when both are in its environment; it also
  takes a key from an `apiKeyHelper` or a stored Console login. So such a turn now
  runs with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` cleared and any
  `apiKeyHelper` switched off. The CLI's account is checked before the prompt is
  sent, and a turn with no subscription login ends with a `CLAUDE_AUTH` error
  instead of billing a key. The core CLI's `claude` agent runner (what `brain
sync` uses) follows the same rule. Model discovery prefers the subscription
  token too.

  What a host may need to change:

  - **Billing an API key for chat on purpose?** Declare a profile that names it,
    e.g. `BRAIN_UI_CLAUDE_PROFILES='[{"id":"claude-api","label":"Claude (API)","apiKeyEnv":"ANTHROPIC_API_KEY"}]'`.
    Credential-free profiles no longer use the ambient key, and are now always
    classified as subscription-billed.
  - **`brain sync` under cron ran on an API key?** It now needs a subscription
    login (`CLAUDE_CODE_OAUTH_TOKEN`).
  - **`anthropic-haiku` completions inside chat turns?** Name the key separately:
    `completions: { provider: "anthropic-haiku", apiKeyEnv: "BRAIN_ANTHROPIC_COMPLETIONS_KEY" }`,
    and admit that name to the agent with `BRAIN_UI_SUBPROCESS_ENV_EXTRA`.
    `completions.apiKeyEnv` and `completions.fallbackApiKeyEnv` are new.

- 6615623: - Added: `VOICE_ALLOWED_TOOLS`, the named tool set a spoken turn runs under (docs/decisions/voice-permission.md). Selected as a turn's allowlist together with `enforceAllowedTools` and `noGrantSurface`, it denies `Bash` without raising a card and keeps `brain_add` and `brain_update`.

### Patch Changes

- 58a2fed: No behaviour change. A comment in `permission-hooks.ts` pointed at
  `sdk-options.ts:92` for the project settings this backend loads; the line moved
  to 96 and the pointer had come to name `forwardSubagentText` instead. It now
  names `settingSources` alongside the line, so the next insertion above it is
  recoverable rather than silent.
- Updated dependencies [7fe9bc0]
- Updated dependencies [907e8bc]
- Updated dependencies [e77ab6f]
- Updated dependencies [6ae12e7]
- Updated dependencies [d9d4061]
- Updated dependencies [4ed02fb]
- Updated dependencies [7b6b2b0]
- Updated dependencies [ecc93b9]
- Updated dependencies [d33492e]
- Updated dependencies [54eea05]
- Updated dependencies [97837c1]
- Updated dependencies [1de4d6c]
- Updated dependencies [fa09aaa]
- Updated dependencies [08d4ed2]
- Updated dependencies [4d409c0]
- Updated dependencies [146d5a9]
- Updated dependencies [92a599d]
- Updated dependencies [09d9f4e]
- Updated dependencies [f489482]
- Updated dependencies [f7b46d3]
- Updated dependencies [1bf00b8]
  - @schlessera/brain-ui-sdk@0.37.0

## 0.36.0

### Minor Changes

- edb547b: Both backends register `show_block` and auto-allow it. It needs nothing from
  the host bridge, so it is always present: the Claude backend's `brain-ui` MCP
  server now exists on every turn (as `mcp__brain-ui__show_block`), and pi's
  bridge tool list carries it unconditionally, classed `read` in the risk table
  because it touches nothing. The system-prompt brief names it on both.

### Patch Changes

- Updated dependencies [9827a47]
- Updated dependencies [bbc90ab]
- Updated dependencies [6b57843]
- Updated dependencies [b3a3ffd]
- Updated dependencies [2c9e5d3]
- Updated dependencies [edb547b]
- Updated dependencies [f5512f7]
  - @schlessera/brain-ui-sdk@0.36.0

## 0.35.0

### Patch Changes

- Updated dependencies [f89897b]
  - @schlessera/brain-ui-sdk@0.35.0

## 0.34.1

### Patch Changes

- Updated dependencies [aade466]
  - @schlessera/brain-ui-sdk@0.34.1

## 0.34.0

### Patch Changes

- 4adb327: Added the published backend contract harness and moved both first-party backends onto it.
- 17706aa: Add the shared permission-decision core and split backend factories into focused turn, usage, and runtime modules.
- c6d9a30: Add self-describing backend modules and make the server registry iterate their profile, settings, billing, credential, and discovery hooks.

  Preserve descriptor resolution hooks and model discovery when a third-party backend is passed by value through the static registry, and validate active backend-owned profile rules before startup completes without requiring or strictly parsing inactive backend packages.

  Change session routing to reject an unknown non-empty stored backend id instead of silently substituting the default; null and empty legacy ids still use the default.

- e326368: Add characterization coverage for backend permissions, streaming, usage, and history.
- a41e81a: - Define the four browser bridge tools once in the UI SDK while preserving Claude's names, descriptions, schemas, and result envelopes.
  - Reject NUL, absolute, traversal-escape, and symlink-escape paths before either backend writes an image mask.
  - Give pi's `ask_user` the full shared description, 1–4 question and 2–4 option bounds, a 12-character header bound, and optional option previews.
  - Require pi's `ask_user.multiSelect` instead of defaulting it to `false`.
  - Return pi's shared `ask_user` payload (echoed questions, answers, and annotations) to the model while keeping the full `AskUserResult` in details.
  - Advertise and validate pi's `query_activity.scope` as the shared enum.
- Updated dependencies [4adb327]
- Updated dependencies [17706aa]
- Updated dependencies [c6d9a30]
- Updated dependencies [a41e81a]
  - @schlessera/brain-ui-sdk@0.34.0

## 0.33.1

### Patch Changes

- 5b7fb32: Restrict repo-owned subprocess environments by audience, preserve first-party CLI and module capability settings, and add an operator allowlist escape hatch. Pi extensions (`pi.exec()` through `execCommand()`) and pi's package-manager helpers still inherit the full server environment because pi 0.84.4 exposes no supported environment option; 0.35.0 moves the pi runtime under the `agent` uid to close that in-SDK residual.
- Updated dependencies [5b7fb32]
  - @schlessera/brain-ui-sdk@0.33.1

## 0.33.0

### Patch Changes

- Updated dependencies [95a180c]
- Updated dependencies [07d63eb]
  - @schlessera/brain-ui-sdk@0.33.0

## 0.32.0

### Minor Changes

- ec340d2: Add the experimental audience-tagged subprocess environment descriptor and strip server-only credentials from brain CLI and agent subprocesses while retaining agent authentication, git credentials, and unknown operator variables.

### Patch Changes

- Updated dependencies [ec340d2]
  - @schlessera/brain-ui-sdk@0.32.0

## 0.31.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.31.0

## 0.30.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [eac9b98]
  - @schlessera/brain-ui-sdk@0.30.0

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

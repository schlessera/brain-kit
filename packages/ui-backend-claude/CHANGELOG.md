# @schlessera/brain-backend-claude

## 0.44.0

### Minor Changes

- c60f956: A hosted turn now sees the provider folders its governance policy allows for the provider that actually receives its inference (#2695). Until now every turn under a `providers` rule had those folders masked. The recipient is named only from the exact origin the turn's host inference relay forwards to, which runs for governed and strict Claude and pi turns on managed native storage. Built-in vendor origins name their vendor, for example `https://api.anthropic.com` is `anthropic` and pi's `openai-codex` is `openai`. The new server variable `BRAIN_UI_PROVIDER_RECIPIENT_ORIGINS` (`name=origin[,origin];...`) names a trusted gateway. Any other origin is unknown and sees no provider folder. That includes a custom base URL, an origin listed only in `BRAIN_UI_CLAUDE_OAUTH_ORIGINS` or `BRAIN_UI_PI_CREDENTIAL_ORIGINS`, routers, and Bedrock or Vertex.

  A turn allowed every provider folder sees them, `.git` and the real search index. A turn allowed some of them gets masks for the rest and a private index without their documents. The turn's relay then refuses any other origin.

  A conversation that showed folders to one recipient refuses a later turn, or a handoff, whose recipient may not see them, with `ProviderRecipientRefusedError`. That covers a pin that fell back to another profile, a changed route or a pi model change. A handoff summary is not drafted for such a conversation; write it by hand.

  `AgentBackend` gains optional `inferenceOrigin({ profileId, sessionId })`, which the Claude and pi backends implement. A backend without it keeps every provider folder masked.

- bd4eba3: Governed and strict Claude turns on an API-billed profile now run on the turn egress proxy and the host inference relay too, on hosts with managed native storage. The relay sends the profile's `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` to the profile's own route; the worker holds only a placeholder, and neither the variable the profile names nor a host `CLAUDE_CODE_OAUTH_TOKEN` reaches it. Billing is unchanged. The `brain` CLI inside such a worker no longer sees that key either, until its own providers are relayed (#1673). Only the credential the profile declares is sent: an ambient `ANTHROPIC_AUTH_TOKEN` no longer rides along to the profile's route. Project or managed settings that move the route, set a credential variable or configure an `apiKeyHelper` refuse the turn before its prompt is sent, as a transport failure. A host Claude login file linked into the brain refuses relayed turns. `runtime.workerHost.governed.egress` no longer lists API-key profiles as unrouted.
- bddd0a4: Apply governance policy provider folders to autonomous turns (#2691). A restricted autonomous turn under a provider rule now reads each masked folder as empty and searches a private index built from the masked view, removed when the turn ends; its server-side brain tools refuse masked paths. Autonomous admission reads the same last-valid policy as hosted turns, translates path and type selectors onto folders the same way, and refuses every other selector by name.
- 3bdaa03: A hosted turn whose governance policy masks a provider folder no longer receives the brain's saved Claude auto-memory and saves no note to it (#2726). It continues an existing conversation, or a handoff from one, only when the server recorded that the conversation was born with those folders masked and kept them masked on every turn since. A conversation from before the provider rule, from a route that could see the folder, or without that record is refused before its history is copied or sent, with an actionable request to start a new conversation, and drafting its handoff summary is refused. Saved memory and transcripts are never changed. Expect existing conversations to need a fresh start the first time you add a provider rule.
- 603a754: Complete interactive share filing through session-bound authoritative receipts and verified original-file dispositions, with durable replay and recoverable cleanup.
- 4349af3: Retain successfully persisted external Claude auto-memory as attributed steering history with raw versions, taint evidence, authenticated review/revert and conflict-safe Undo. Interrupted or refused persistence remains explicitly incomplete.

  Keep expanded journal details within the viewport when long retained paths or unavailable-reason text is reviewed at 200% zoom.

- d2bb3b3: A hosted application (`brain_add`, `brain_update`, `brain_archive`, `write_file`, `edit_file`, `apply_staged_changes`) returns as soon as its Markdown is committed, instead of re-indexing the brain first (#2835). On a 2,000-note brain that wait was about 4 s per write. Breaking before 1.0, ruled on #2835: a successful result now reports `indexed: false` with the new `indexStatus: "pending"` while its index update is queued, and `indexed: true` only after an update completed. The Markdown write, its durability and its refusals are unchanged.

  The changed paths are batched and indexed in one targeted update, in the same isolated maintenance worker, at the next read that needs the index or at the end of the turn. Every such read waits for it: the brain's MCP tools, pi's `brain_search`, `brain_context`, `brain_read`, `brain_list` and `brain_graph`, the shell, `brain_add` planning, and the server's `/api/brain/search`, `/list`, `/stats`, `/briefing` and `/api/graph/*` routes. When the update fails, the read is refused with the committed paths and the error instead of returning stale results, `brain_add` refuses with `index_stale`, `/api/*` answers `503` with `code: "index_stale"`, and the paths stay queued for the next try. Activity records each outcome as a `brain_application_index` event after the application it follows.

  `BackendBridge` gains optional `awaitIndex(toolName)`, which the Claude and pi backends await before admitting every tool. `indexAll` in `@schlessera/brain/internal` accepts `paths` for a targeted run that leaves the index as a fresh build would. The standalone `brain add --json` keeps its synchronous `indexed`.

- aeaaf77: Pass each app's resolved exec wrapper through backend construction, runtime
  probes, Claude SDK workers and Pi tools. Explicit empty host configuration
  disables the optional wrapper; standalone callers omitting it retain the
  ambient fallback at the existing turn and tool-spawn boundaries.
  Pi workers see each configured helper file, and only that file, in ordinary and
  restricted views; a wrapper or killer that is not a regular file is refused
  before any relay or worker starts, as is a nonregular wrapper for an ordinary
  Claude worker.
- 1135899: Agents on both backends can read shared reference source and use managed worktrees. Two new bridge tools, `reference_source` and `reference_worktree` (`request`, `access`, `renew`, `release`, `list`), share one strict contract in `@schlessera/brain-ui-sdk/tool-contracts` and stay in every interactive session's fixed roster; a turn without a host handler refuses the call. The host binds principal, turn and worker generation itself, and a result reports a path only where this turn's workers can reach it. Governed and strict turns now bind the public and principal's private source views read-only under `/tmp/brain-reference/`; before each bind, every source whose validation lapsed is validated again, and one that fails is withheld until a request validates it, and the app enables worktree generations whenever a reference pool exists. The native manager gains `poolView`, which opens a view's directory before its first publication.
- 3f68a36: Propagate configured and runtime main-model identity into interactive and voice journal/governance attribution, preserving earlier unknown-model event snapshots and rejecting stale active-turn bindings.
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
- fb80840: Restore approval-free governed native writes and keep strict/voice native tools registered with enforced call-time refusals.
- 790d593: Retain literal provider-policy folder topology in newly admitted governed workers and in native host publication. Shared writers inherit active peer folder plans across policy removal. Existing roots and ancestors resist rename or replacement while contents and permitted siblings stay writable. These primitives do not activate inference routing or establish complete protected-data isolation.
- 8f7430c: A session that ingests untrusted content now runs under tighter rules for the rest of the session. WebFetch/WebSearch and pi web results, reads under `.brain-ui/inbox/` or `workspaces/`, results from any MCP server other than brain-kit's own, and fetching or unclassified Bash calls record the session's first `taint` governance event. While tainted, every outward action asks for approval even when `outward.allow` matches, and its `outward_action` event says `tainted: true`. On the turn egress proxy, any connection other than the inference relay also taints the session, and a tainted session's new connections reach only `taint.egress.allow` and hosts the session already contacted; refusals are `egress_denial` events with reason `taint_allowlist`. Turns without the proxy keep their network, and the capabilities note says tainted egress is not enforced there.
- 8822aed: Keep interactive tool schemas stable across posture, strict fallback and temporary host capability changes. Refuse unavailable calls before privileged handlers or approval cards, preserving voice and sandbox authority.
- 79bab30: A strict, voice or autonomous turn now sees its own applications in the same turn (#2848). Its worker reads a turn data tree at `/tmp/brain-worker-data`: the documents as the turn started plus every change the turn's host applications committed, with a search index the server brings up to date before the next search. `brain` commands in either shell, Claude's `brain` MCP server and pi's brain tools, `read_file`, `grep`, `brain_read` and shell use it as their data root, while `brain.config.ts`, modules and module settings still load from the frozen view at the brain path. A peer's change made during the turn does not enter it. Admission copies the startup documents into the tree and seeds its index (about 0.1-0.4 s on 2,000 notes).

  Claude's `Read`, `Grep` and `Glob`, and shell commands that name the brain path, still see the turn-start bytes. A Claude `Read` of a file the turn changed is refused and names `mcp__brain__brain_read`, which reads the current version.

  A provider-restricted turn's own applications now reach its private search index too (#2846), and no masked document does: a change enters only if its path is outside the masked folders, neither its result nor its base declares a type the recipient may not see, and its base is what the turn could already see, never a peer's. Such a turn's `brain_add` plans on its own data tree and index, in a masked worker. The private index is now read-only to the agent: `brain index` and `brain` CLI captures inside a masked turn fail, and the server keeps it current instead.

  Core maps a worker's `BRAIN_WORKER_CONFIG_ROOT` back to its `BRAIN_WORKER_DATA_ROOT` during root discovery, and readers there retry `SQLITE_READONLY_RECOVERY` and `SQLITE_BUSY_RECOVERY` a bounded number of times. `@schlessera/brain/module` exports `configurationRoot(root)`; jobs scoring reads `settings/jobs.json` and its criteria document through it. `BackendBridge.awaitIndex` takes the tool's input as an optional second argument.

- 086db5b: On hosts with managed native storage, run governed and strict Claude turns on their own turn egress proxy and the host inference relay by default. Every connection becomes a governance event, policy limits apply, and a connection to an outward host waits for approval unless the tool call in progress was classified as a read or an approved outward action to that host. The capabilities note states recorded egress only for a worker actually routed through the proxy. Elsewhere those turns keep their current network, and `runtime.workerHost.governed.egress` on `GET /api/status` says which applies.

  The relay forwards to the server-selected route (a profile's `baseUrl`, else `ANTHROPIC_BASE_URL`). A custom origin may receive the host's Claude login only when `BRAIN_UI_CLAUDE_OAUTH_ORIGINS` lists it exactly. **Migration:** if a subscription profile or `ANTHROPIC_BASE_URL` points Claude at a custom origin on a host with managed native storage, add that origin to `BRAIN_UI_CLAUDE_OAUTH_ORIGINS`, or those turns are refused before their prompt is sent.

  A model-discovery cache entry in the brain no longer supplies a profile's `baseUrl`, credential variable names, model aliases or tools; only the fields discovery itself writes are read back.

- 7d1a31d: Run qualified workers under a distinct host identity with authenticated supervision, retained bounded mounts and cancellable private-file recovery.

### Patch Changes

- 2d21e91: A separate-UID worker's identity broker is now also closed off the event loop after an asynchronous launch has returned: when a turn releases the worker's last runtime-state or turn-temp handle, when the worker exits holding none, and after a failed supervision. The hosted server no longer stalls `/api/health` and WebSocket pings at the end of such a turn. Both backends await the close before they release the turn's storage reservation. A close the supervisor cannot confirm keeps the reservation charged and can be retried, and a worker's exit holding no handle now reports that refusal instead of dropping it. The synchronous launch is unchanged.
- 2fe4005: Keep the hosted server answering while a worker's pipes are created and while a Claude turn prepares its own sandbox. The asynchronous worker probe, agent launch and maintenance launch and run now await `mkfifo` for their stdio and status channels instead of blocking on it, and a Claude turn whose host supplies no worker sandbox awaits its scratch area's git check before building its options. The synchronous forms, the FIFO modes, the unlink-before-launch boundary, the resolved sandbox and every refusal are unchanged.
- e75f9af: Preserve accepted host cancellation when Claude releases a delayed SDK result. Cancelled terminals retain reported usage, clear error-only details, and wait for worker cleanup before emission.
- f33358e: Restore the Claude package's Node import by loading Bun FFI only when its native inference guard is selected, while retaining fail-closed native input checks.
- cf70a33: Retain Claude-generated session titles while attributing measured title-helper usage separately from main-conversation and cache diagnostics. Reconcile supported OTLP receipts within the existing cumulative accounting transaction so helper spend appears once, preserve unmatched usage as unattributed, and respect configured operator telemetry and opt-outs.
- 3b3485e: A Claude turn now settles only after its session's native file observation saves have. A new session's first save is still queued without blocking the stream, but the turn's cleanup waits for it, so nothing is still writing host observation storage once the turn has returned. `NativeFileVersions` on the internal entry gains `settled()`.
- f178a59: Report Claude subscription usage-limit stops as rate-limit failures in live turns and history replay.
- b63276f: Non-envelope Claude workers no longer import operator shell startup configuration (#2984). Their HOME is a fresh, empty, read-only mount, separate from the writable runtime-state tmpfs at CLAUDE_CONFIG_DIR. This covers successful shell snapshots and the CLI's login-shell fallback. Writes to `~/.npm`, `~/go`, `~/.cargo` and other HOME paths still fail with EROFS; they cannot consume transcript/credential storage or be misreported as runtime-state exhaustion. Credentials and config are resolved from the original environment before the HOME override and retain their existing preparation and persistence. The original host home stays read-only at its original path with the same profile masks; per-turn XDG storage and restricted-envelope behavior are unchanged.

  Rc-file masking was measured first with the real CLI. It preserves implicit Git config reads for fixed existing files, but a read-only bind remains a live view: a previously absent profile created by the host after enumeration leaks into both the snapshot and login fallback. Binding over the absent path up front fails with EROFS, and a startup symlink can redirect the mask onto another config file. The maintainer's empty-HOME fallback is therefore retained. Image-owned system startup files remain out of scope.

  Commands that found operator configuration through `~`, including `~/.gitconfig`, `~/.npmrc` and `~/.netrc`, must use an explicit path where the profile exposes it. Core's default `~/.local/bin` and geo's default cache/admission paths now resolve under the empty read-only HOME. Existing operator-home geo caches are no longer found implicitly; a geo cache miss refuses before any request, and no private per-worker admission state is created. Use the existing explicit configuration/environment facilities for other home-derived paths.

  Non-envelope launches also discard `BASH_ENV`, `ENV`, `ZDOTDIR`, `SHELLOPTS`, `BASHOPTS` and exported `BASH_FUNC_*%%` functions, including explicitly admitted values. Tools and variables previously supplied by a shell profile must come from the server's configured PATH and admitted environment. RTK continues to exclude the original host home when runtime HOME differs. The sandbox note describes Claude's empty read-only HOME, pi's original read-only HOME and the real host home's profile masks.

- 933286d: Refuse background Bash tasks that cannot outlive a turn's worker, with foreground retry guidance. Hide native runtime task notifications from user-message history while preserving genuine user text and image attachments.
- fab1c37: A Claude turn's own abort, such as an autonomous turn yielding at its checkpoint, again reaches a running worker only through the Agent SDK's close, which gives the runtime its grace period to finish its last request. Since the worker's probe and launch moved behind the deferred spawn, that abort had killed the worker at once, so a held continuation request could go unaccounted.
- 9a3af9b: Resolve inference credentials per dispatch and serialize host OAuth access with credentialed maintenance through a crash-safe kernel lock.
- c06dbb4: Preserve Bash commands when optional RTK availability cannot be established in the actual Claude worker, and avoid sharing availability probes across worker environments.
- 1794e72: Keep the hosted server answering while native file observations and the Claude transcript archive's daily scan marker are written to a loaded disk. Saving and restoring a session's native file observations, including creating their storage directory, now waits on the file system off the event loop. Saves land in call order, and each native read or write still waits for its observation to be durable before it proceeds. The archive's scan marker is written the same way, and concurrent sweeps in one process still scan once. File and directory fsync, atomic replacement, the private modes, the redirect and alias refusals and the refusal of a write whose observation cannot be saved are unchanged. `NativeFileVersions` on the internal entry now returns promises from `restore` and its recording methods.
- a9602c8: Prepare a bounded host-only Claude stored-login OAuth resolver with atomic credential refresh and offline compatibility guards. Ordinary worker authentication remains unchanged pending complete relay qualification.
- 066107c: Put the brain's installed CLI first on governed and strict interactive workers' PATH, matching maintenance workers, and explain installation in the sandbox note when it is missing. Restricted autonomous environments retain their fixed PATH.
- 4e0fbb6: Allow the ordinary Claude spawn adapter to consume a host-prepared inference transport without copying the native credential store into worker state.
- a90490e: Carry an explicitly prepared host inference transport through ordinary Claude SDK turn assembly while preserving subscription and per-use permission checks.
- 0125555: Preserve runtime-written provider transcript entries across turns. Store promoted
  answer-link display mappings and authoritative Pi application receipts in host-owned
  replay metadata so history retains promoted links and receipts without changing
  prior model text or tool results. Recover only missing results for runtime-written
  Pi calls after the worker exits; direct server applications create no provider entry.
- 775cd1b: Retain native file observations in host-private session storage so resumed Claude and Pi turns refuse stale writes after a backend restart. Interrupted reads and missing legacy observation records require a genuine reread before writing; fully tracked sessions retain the existing never-read behavior.
- 9506026: Keep interactive Claude request prefixes stable when the brain repository changes by disabling built-in git status and commit/PR instructions for both API and subscription turns. Project CLAUDE.md guidance remains available.
- 3cc0a60: Suppress RTK's missing-hook installation warning in Claude workers and Pi bash children, where the host already rewrites shell commands. Preserve command errors and exit status.
- 965578d: Use completed response receipts for resumed Claude turns instead of the runtime's session-cumulative cost and model usage. Retain newly observed unstreamed usage separately and once in Activity and session totals, with explicit unknown attribution and partial coverage after missing history or counter rollback. Model identifiers retain their own counters across response snapshots and persisted reconciliation, including names that match inherited JavaScript properties.
- 25899b1: Remove the unused child-only exec-wrapper spawn adapter. Ordinary turns continue to use the isolated worker launcher, including optional exec wrappers and worker-owned cancellation.
- 88012cf: A Claude or pi agent turn, a pi worker whose initialization or start callback was refused, and a streaming maintenance launch now finish only once every descriptor on their worker's stdio FIFOs is closed in the server, or after the 5 second bound of the worker's `released()` (#2863). Bun closes its own duplicates of those descriptors later, on its thread pool, so on a busy host a finished turn could report itself done with them still open. A streaming launch keeps its output slot and writer gate until then, but reports the worker's exit as before: a caller that reads the streams only after the exit is not held up. A scheduled job run through the host boundary ends only once its launch has settled, so the writer gate is free before the job's host closes its database. The worker's stdin is now closed once it has exited.
- 8d06beb: Share inference relay admission, byte limits and audit with the turn egress proxy, and require exact host authorization for Claude OAuth inference recipients.
- b192ca0: Changed: the hosted server commits turn-journal, Activity and native-lease SQLite writes on a write worker thread at `synchronous=FULL`, in submission order; the event loop awaits each commit instead of blocking in its fsync (#2814).
  Changed (breaking for direct `TurnJournal` callers): journal writes that callers wait on (`bindSession`, `writeOperation`, Claude memory persistence, revert reservation, retained-version leases and retained streams) are asynchronous; `writeOperation` takes statements, and the journal exposes `ready` for its startup recovery.
  Added: `StartTurnRequest.persistClaudeMemory` may return a promise; the Claude backend awaits it before persisting the next note or ending the turn.
- 55dbf1c: Retain session-stable prompt appends and deliver changed host facts in owned new tail context, preserving user history and unknown device capabilities.
- c452cf1: Keep the hosted server answering while the remaining worker checks run. A Claude turn now claims its session at once and then awaits its worker host probe, and a Claude worker's probe and bubblewrap launch are awaited behind the deferred spawn instead of inside the SDK's synchronous callback. A separate-UID worker's exit is polled without blocking, and so are the separate-UID maintenance launch and the scratch mask's git ignore check. The checks, their order and their refusals are unchanged: a refused probe still rejects the turn and leaves no turn behind, and a worker that does not start still names the turn's failure with its own error.
- 1faf79c: Governed and strict turn workers no longer receive the `brain` CLI's provider keys (#1666). A worker keeps only its own inference credential where the host does not relay it, plus any name an operator admits through `BRAIN_UI_SUBPROCESS_ENV_EXTRA`. `GEMINI_API_KEY`, `OPENAI_API_KEY`, `TYPESAFE_API_KEY` and the other provider credentials stay on the host. The brain's `.env*` files were already unreadable in these workers, and now there is a test for that.

  A `brain` command that needs a withheld key names the provider and the key, and falls back where it can. `brain search` returns keyword results, `brain index --embeddings` builds a keyword index, and an enabled `jev` reranker keeps lifecycle order. `brain process`, `brain image` and `brain video watch` refuse, because the built-in providers' own missing-key errors name a withheld key too. Each notice ends in a `[provider_unavailable …]` token. The worker learns which keys it lacks from the new `BRAIN_WITHHELD_KEYS` variable, which holds names only. The server records each token in a tool's result as a `provider_unavailable` governance event, at most 20 per turn. The capabilities note now says that secrets are hidden and names the keys a worker keeps.

  To keep the old behaviour for a key until the metered relays land (#1673), admit it explicitly with `BRAIN_UI_SUBPROCESS_ENV_EXTRA`. Outside a worker, a brain without keys behaves as before.

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

## 0.43.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.43.1
- @schlessera/brain-common@0.43.1

## 0.43.0

### Minor Changes

- 4af7b2f: Replace repeated whole-brain journal and worker input copies with managed Btrfs checkpoints and changed-only retained history. Hosted apps now require a qualified native storage service and explicit finite volume capacity; unsupported storage refuses with setup guidance instead of a copy fallback. The retained history limit remains 10 GiB and staged worker outputs keep their existing allowance.

### Patch Changes

- Updated dependencies [4af7b2f]
  - @schlessera/brain-ui-sdk@0.43.0
  - @schlessera/brain-common@0.43.0

## 0.42.1

### Patch Changes

- Updated dependencies [b6f9060]
  - @schlessera/brain-ui-sdk@0.42.1
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
- 966bed8: Bound maintenance temporary storage separately from agent turn temp and output staging. Add validated command and aggregate limits, cross-process admission and maintenance-only nested-usernamespace enforcement while preserving the separate Git transport boundary.
- 2151826: Show a dismissible saved-state warning at the existing 75% threshold using the
  backend's actual admission measurement. Preserve its age, dismissal across
  reloads, changed-allowance invalidation, quiet history, voice and focus behavior,
  and the existing reviewed continuation. Add optional result/history observations
  and provider allowance metadata without changing capacity or admission.
- 857ab01: Enforce admitted turn, conversation and UTC-day list-price inference budgets using completed response receipts, retained Activity usage and unknown-price token fallback. Share measured limits and once-only warnings with the existing turn disclosure; preserve partial work and reviewed conversation handoff on a named budget stop.
- 857ab01: Refuse native file writes when a file's bytes changed since that live session read it. Preserve actual read-version truth, including Claude's cached unchanged-read responses, and keep Pi's observations across ordinary per-turn worker launches. Paths never read by the session remain writable. Read observations are held by the running backend and are not restored after a backend restart.
- f5433b3: Require existing per-use approval for visible outward commands in interactive turns, preserve force-push and voice refusals, and retain irreversible admission receipts in the turn journal. Explicitly disclose opaque HTTPS-script and unavailable outward MCP descriptor coverage.
- f5433b3: Add validated hosted policy proposals with explicit exact-base approval, retained same-request receipts and read-only policy settings. Voice and autonomous tools and worker policy-write restrictions remain unchanged.
- c41f173: Each Claude worker now gets its own private, size-limited tmpfs for its runtime state (#1625), so parallel sessions no longer share, and run out of, the host's `/dev/shm`. The allowance is 64 MiB per worker by default (`BRAIN_UI_WORKER_STATE_BYTES`). Before a worker launches, its whole allowance is reserved against a server budget, which defaults to the allowance times `MAX_CONCURRENT_SESSIONS` and can be set with `BRAIN_UI_WORKER_STATE_BUDGET_BYTES`. Invalid values stop the boot with the variable's name. The server copies the conversation in before the runtime starts and copies validated transcripts and memory out after the worker's namespace is gone. Nothing is left behind if the server dies.

  Two new first-party failure classes, both registered in `FIRST_PARTY_FAILURE_CLASSES`, get their own cards. `worker_state_busy`: the budget is held by running conversations; the turn is refused before launch, nothing is sent, and Retry runs it. `worker_state_exceeded`: the turn filled its allowance; it ends as this failure even if the runtime finished its answer, because the rest was not saved. A conversation whose saved state does not fit the allowance stays `session_too_large`; the old 128 MiB bound is gone. Claude workers need bubblewrap 0.7 or later.

  Agent memory written during a turn is now kept (#1626): new or changed `memory/*.md` notes are persisted with the same alias, size and concurrent-change checks as transcripts. A note another conversation changed meanwhile is refused alone and named, and nothing is deleted.

- 02d4eb0: **Breaking (MCP contract):** an unranged `brain_read_base` on a document too large for one tool result (over 40,000 JSON-escaped characters) no longer returns `content`. It returns the base hash, the size and the first page of lines with a paging hint, so the Claude Agent SDK no longer spills the result to a file where the hash cannot be reached. To get the whole text, read the pages in turn with `offset` (and `column`). Documents within the budget still return `content`.

  `brain_read_base` now puts `expectedBaseHash` first and adds `bytes` and `lines`. It also accepts optional `offset`/`limit`/`column` to page through a document; `limit: 0` returns only the hash and size. Every result carries the hash of the whole document, so the write tools' base guard is unchanged.

- 6377291: A file the agent links in turn temp (`$BRAIN_WORKER_SCRATCH`, `/tmp` or a write under `$HOME`) no longer becomes a dead link when the turn ends (#1655). Once the worker has exited, the backend copies each linked file into `.brain/scratch/turns/<turnId>/` and the saved answer links the copy, with nothing shown in the chat. The copy follows no symlink, refuses hard-linked files and directories, and is bounded at 128 MiB per file, 256 MiB and 64 files per turn; a refused file keeps its original link. Every copy and refusal is stored as a `promotion` or `promotion_refused` governance event (`GET /api/governance/events`). Turn temp is the worker's private, size-limited `/tmp` tmpfs. The server retains a directory descriptor into that filesystem so linked files can be promoted after the worker exits; this does not use a host-created `/dev/shm` staging directory. For backend authors, `StartTurnRequest.turnId` passes the host's turn id, and `BackendActivityEvent` gains the `promotion` and `promotion_refused` variants.
- 2b196b3: Every agent worker now runs under resource limits, so one runaway turn cannot exhaust the host (#1660). `prlimit` sets the process, per-process memory (`RLIMIT_DATA`), file size and open file limits inside the worker before the agent starts. Where the server runs alone in a delegated cgroup v2 subtree, such as a systemd unit with `Delegate=yes`, each worker also gets its own cgroup with `memory.max`, `pids.max` and `cpu.max`. The defaults are far above normal use: 4096 tasks, half the memory the server has (physical memory, or a lower cgroup cap above it), 16 GiB per file, 65536 open files and all CPUs but one. `BRAIN_UI_WORKER_LIMITS` overrides them, for example `memory=8GiB,pids=2048,cpu=2`. A host without `prlimit` (util-linux) now refuses agent turns and names that requirement. `GET /api/status` reports each limit as enforced or absent, with the reason, under `runtime.workerHost.limits` (`WorkerLimitsStatus` in `@schlessera/brain-ui-sdk/protocol`). The agent is told the same limits before it starts. A cgroup limit hit is recorded in the run's Activity next to the step that caused it. A limit that ends the worker fails the turn with the new first-party class `worker_resource_limit`, which names the limit. Backends report hits through the new `resource_limit` activity event.
- b8862b3: Give hosted agent turns verified persistent scratch and workspace areas (#1626), now integrated with the 0.42.0 profiles. Governed is the interactive/voice default: ordinary brain files are writable except protected paths, and scratch/workspaces use their canonical destinations. Strict keeps an immutable read-only execution view and writes private copies at `/tmp/brain-worker-areas/scratch` and `/tmp/brain-worker-areas/workspaces`, with validated publication after exit; links use the canonical brain destinations. Scratch is created when missing and refused when redirected by a symlink or not gitignored; an existing workspace remains unavailable when its boundary cannot be verified.

  There is no agent HOME overlay. Host home is read-only and may be masked by the resolved profile; fresh XDG directories live in size-limited turn temp. The generated note states the actual profile, writable paths and output-link rules. CLI read-only refusals name the scratch route, and scratch serving/pruning uses descriptor-safe operations on Linux. Autonomous turns retain their restricted envelope.

### Patch Changes

- bdb1d6d: The server no longer runs the brain's own code, the `brain` CLI or git against the brain in a host process wherever a governed turn could have changed it (#1648). Capture planning and the index refresh behind `brain_add`, every server-spawned `brain` command, the streamed sync, cron jobs and git's ignore checks run in a maintenance worker instead: the same bubblewrap launcher, with the brain writable, the host read-only, and `/run`, `/var/lib`, the home directories and the UI database's directory masked. A malicious `brain.config.ts` import, `bunfig.toml` preload, `.env`, git include or symlinked ref therefore runs only inside that sandbox. Work a turn waits for runs without credentials or network and holds the brain's new writer gate shared; credentialed work (sync, reindex, capture, module actions) holds it exclusively and waits for running writers. Boot, and the cron runner before each job, quarantine any protected file a governed turn left behind after an unclean stop, beside the UI database.

  `GET /api/status` gains `runtime.workerHost.governed`: whether the `governed` profile can run, why not (`server_cwd_in_brain`, `database_in_brain`, `worker_host_unavailable`), and whether the brain's code runs in workers or on the host. A server started from inside the brain reports `governed` unavailable. The generated crontab now starts every line with `cd /` and the cron runner gives each job the brain as its working directory; regenerate the crontab on upgrade. The brain's CLI must be installed inside the brain (`node_modules/.bin/brain`), not linked from a home directory. The Claude runtime version probe now runs outside the brain.

- 3212c7d: Scope Claude worker state to the resumed conversation, reserve tmpfs headroom before copying, and offer a reviewed handoff when a session is too large. Automatically archive idle transcripts after 30 days and restore archived history and resumes transparently. Refuse oversized pi sessions before launch with growth headroom and classify snapshot overflow as `session_too_large`. Register `session_too_large` in `FIRST_PARTY_FAILURE_CLASSES`, so a reviewed report keeps the class.
- acec591: Preserve all first-party failure classes in reviewed failed-turn reports through the shared FIRST_PARTY_FAILURE_CLASSES SDK registry. Unregistered third-party classes still report as unknown. The additive SDK export ships in a minor release (#1619).
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

## 0.41.0

### Minor Changes

- d36cca7: Deliver messages sent during a running Claude turn into that turn, the way Claude Code does: the message reaches the model beside the next tool result, without interrupting the running step. The backend now declares `capabilities.followUp: true` and implements `followUp()`, so hosts send mid-turn messages live instead of queuing them as the next turn. A message sent while the final answer is being written runs before the turn ends, and the turn still ends on one `result` that counts both runs.
- 9a89d4a: Show configured profiles that cannot run now, with their reason, in the handoff sheet. `AgentBackend` gains an optional `listUnavailableProfiles()` returning `{ id, label, reason }`, with `reason` from the closed `PROFILE_UNAVAILABLE_REASONS` enum (`needs-credentials`). The Claude backend reports a profile whose required environment key is missing; pi lists every configured profile and omits the member. `GET /api/providers` gains an optional `unavailable` list beside `providers`, absent when empty: the runnable roster, routing and handoff resolution are unchanged, and the host drops any entry whose reason is not in the enum, so no key name or other backend text reaches a client. The handoff sheet's To list shows these profiles on other backends after the runnable ones, disabled and reading `needs credentials`; they cannot be chosen.
- 825cd04: Breaking (pre-1.0, ruled on #343 question 1): package entry points now export only the supported API. Names that only brain-kit's own packages used moved to `/internal` entry points, which have no compatibility guarantee and need the same lockstep version: `@schlessera/brain/internal` (path-safety, scratch, generated-region, taxonomy, context and write helpers, in addition to the existing native-handle helpers), and the new `@schlessera/brain-scrape/internal`, `@schlessera/brain-render-template/internal`, `@schlessera/brain-ui-kit/internal`, `@schlessera/brain-ui-server/internal` and `@schlessera/brain-ui-sdk/internal/client`; `@schlessera/brain-ui-sdk/internal` and `@schlessera/brain-backend-pi/internal` gain entries. Other incidental exports were removed: core's database, indexing, ingestion, search, archive, audit, validation, skills-discovery and config-loading functions (use `@schlessera/brain/queries` for content-index reads), the modules' ledger, scoring, routing and database helpers, pi's runtime building blocks, Claude's model-discovery helpers, ui-sdk's per-kind block schemas, tone tables, classification and web-search internals, ui-server's route, cron, staging and keyterm helpers, ui-react's URL helpers and default-root singletons, and the link-policy duplicates on the ui-kit root (use `@schlessera/brain-ui-kit/links`). Every removed or moved name, with its migration path, is listed in `docs/decisions/public-export-boundary.md`. The supported surface includes every type reachable through a public signature; from 1.0, breaking it needs a major version.
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

- 6f06be8: Expose shared durable inbox tool contracts and eagerly attached first-party bridge executors. Reuse authorized store reads and compensated trusted intake, enforce current turn and budget-admitted origin scope, and require an exact approved session/Action binding for deterministic resolution. Voice and restricted turns refuse mutations; deferred discuss sessions remain disabled.
- 84b8e00: Run autonomous Claude and pi turns inside a restricted envelope. The worker gets a private network namespace with only loopback and an explicit read envelope instead of the host root, so it cannot read the host home, stored logins or the server's environment, and cannot reach the network, DNS or host Unix sockets. Inference leaves only through a server-owned relay socket that forwards the provider's inference routes to the profile's upstream and injects the server-held credential; the worker holds a placeholder. Restricted turns load no project settings, instructions, skills, hooks, MCP servers or pi extensions, and use only the server's instruction snapshot and enforced tool roster.

  Additive SDK surface: `AutonomousTurnOptions.containment: "restricted"`, `BackendCapabilities.restrictedAutonomous`, and an optional `supportsRestricted` argument to `assertTurnPosture`. `runAutonomousTurn` always requests containment and refuses a backend without the capability. A restricted turn refuses before any worker starts when the host cannot establish the envelope, when a Claude subscription profile has no `CLAUDE_CODE_OAUTH_TOKEN` (a stored login is never copied into the envelope), or when a pi profile has no API key for an Anthropic Messages or OpenAI-compatible provider. Interactive, voice and handoff-summary turns are unchanged. Nothing dispatches autonomous work in production yet.

- 90d83d8: Run every Claude turn inside the isolated worker and apply hosted PNG masks through the bounded server operation.
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
- 83585eb: Route hosted capture, update, archive and permitted Markdown edits through a bounded server-owned application boundary with current authority, policy/alias denial and exact base hashes. Add hosted structured tools, preserve voice capabilities and archive confirmation, and explain CLI refusals in read-only workers.
- 70275b9: Reject unknown fields at the block and item levels of new `show_block` suggestions calls, including unsupported item `tone`, in both Claude and pi. This is a breaking accepted-input tightening shipped as a pre-1.0 minor. Stored and replayed suggestions still discard unknown fields and render when otherwise valid; malformed payloads keep the generic fallback. Other block kinds retain their existing behavior.
- 361320f: Support Claude Haiku 5.5 through existing discovery and profile selection,
  including its five effort levels and the required Claude Code 2.1.293 minimum
  on start and resume. Upgrade the Agent SDK to the verified 0.3.293 / bundled
  2.1.293 pair, retaining explicit manual approvals and existing enforcement.
- 6f94538: Give restricted autonomous turns a versioned trusted instruction/tool prefix and an explicit SDK cache boundary. Keep per-item server context after that prefix in the user message, without ambient project instructions. Provider cache savings require a separately authorized measurement and remain unclaimed.

### Patch Changes

- 1caadca: Add `@schlessera/brain-common`, an internal-only package with no compatibility promise. Its `./internal/env` entry holds the environment descriptor core and `./internal/frontmatter` holds the cache-free `parseFrontmatter`. The packages that carried byte-identical copies of these files now depend on it instead. Environment and frontmatter parsing behave exactly as before, and every public export is unchanged. module-finance, module-jobs, module-travel and ui-server no longer depend on `gray-matter` directly.
- 02fd0b9: `@schlessera/brain-ui-sdk/server` now exports the helpers both shipped backends use, so a third-party backend can give the host the same behavior and security posture without reaching into `/internal`. The new names, all `@experimental` until 1.0: the bridge-tool handlers (`handleAskUser`, `handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`, `handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`, `handleShowBlock`, with `ImageMaskHandlerOptions` and `LocationHandlerOptions`) and `BRIDGE_TOOL_POSTURE`; the exec wrapper (`wrapCommand`, `validateExecWrapper`, `EXEC_WRAPPER_ENV`, `EXEC_KILLER_ENV`); the subprocess environment filter (`filterSubprocessEnv`, `parseSubprocessEnvExtra`, `SubprocessEnvAudience`); the lock keys (`BRAIN_LOCK_KEY`, `bashLockKey`); `describeRetry`, `resolveThinkingLevel`, `assertLoadedSdk`, `rtkRewriteCommand`; and the bundled `DEFAULT_CONFIRM_BASH_PATTERNS`, whose entries may still change between releases. Their behavior is unchanged. They are no longer exported from the unsupported `@schlessera/brain-ui-sdk/internal` entry; first-party code imports them from `/server`.
- 7347c5d: Update the bundled Claude Agent SDK to 0.3.292 / Claude Code 2.1.292 for native Sonnet 5.5 support. Preserve manual approvals with an explicit default permission mode and remeasure native permission, credential, rewrite and enforcement behavior.
- 56cf3e3: Retain completed-response usage when restricted autonomous turns escalate or yield. Settle successful checkpoints using observed spend and a conservative allowance for any uncertain request, while preserving whole reservations for crashes and missing receipts.
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
- 0c0c9df: Add `ask_user_form` for conditional questions answered in one card, with shared scale and ranking controls, configurable depth/node/options limits, visible-answer validation and history replay. Keep the existing ask tools available.
- 48c87e1: Reserve interactive capacity while limiting autonomous operations to two by
  default. Shared locks prioritize interactive waiters and cooperatively yield
  long autonomous holders after a configurable 20-second wait. Yield checkpoints
  before abort, drains writers before recovering work, retains completed-call
  receipts and incurred costs, and bounds repeated interruption with a single
  dead-letter Action. Production autonomous dispatch remains disabled.
- a01c389: Add per-message reasoning effort with saved profile defaults for Claude and Pi.
  Claude defaults to Opus 5.5 at medium; each resumed turn re-reads its default,
  unsupported levels resolve downward, and retries retain the original override.
  Expose supported levels and honest requested/confirmed effort metadata. The
  existing model chip opens a model/effort picker; overrides clear on correlated
  start or queue acceptance and remain with refused drafts. Older hosts retain
  their existing send behavior.
- 29dadb1: Allow the read-only jobs review MCP tool in the named voice posture and default chat allowlist without an approval card. Other module tools still require explicit admission.
- 35fb78d: Add ask_user_rank: one list ordered by handle drag, taps or keyboard, with explicit kept-order results, optional top-N cutoff, and answered transcript replay.
- 49bc6b2: Pre-1.0 breaking tightening: nonempty `confirmBashPatterns` / `BRAIN_UI_CONFIRM_BASH`
  lists with no valid regex now fail backend initialization instead of silently
  disabling confirmation. Repair the reported invalid entries, or explicitly set
  `[]` to disable confirmation. Missing configuration still uses defaults; mixed
  lists keep valid patterns and effects while reporting invalid entries. Malformed
  JSON and structurally unusable environment values retain their existing fallback.
- d9e64c9: Preserve observed retry counts and known rate-limit reset timestamps on terminal failures and durable replay.
- efafbb3: A failed API call no longer ends a Claude turn as a success (#575). A `result` with `subtype: "success"` and `is_error: true` now ends the turn with `outcome: "error"` and a `failure` that carries the class from the runtime's API-error message, the status from `api_error_status`, and the runtime's text. The API-error message is no longer dropped. A stream that ends after one without a `result` still carries its failure. On a subscription profile, an auth failure also carries its `authAction`, and a turn the subscription gate refuses carries `subscription_required` with `check_config`. `api_retry` messages become `status: "thinking"` frames with a `retry` and a readable `detail`. After a reload, the history reader turns the runtime's API-error message into the assistant message's `failure` instead of prose.

### Patch Changes

- ab70ad1: Serialize unlisted brain MCP module tools with core document writers while keeping named read-only tools lock-free, including after an explicit approval.
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
  - @schlessera/brain-ui-sdk@0.40.0

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
  `sdk-options.ts:90` for the project settings this backend loads; the line moved
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

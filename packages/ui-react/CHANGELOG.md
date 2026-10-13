# @schlessera/brain-ui-react

## 0.42.0

### Minor Changes

- 9988109: A chat link or image whose scratch file has been cleared now reads as expired instead of opening a "File not found." error (#1657). The link keeps its words, followed by a muted "expired", and no longer opens anything; an image becomes a small placeholder holding its alt text and the same label. Both carry "expired" in their accessible names. Opening such a file in the viewer shows "This file has expired" rather than an error. Only files under `.brain/scratch/` are checked, with one `HEAD` request on the existing raw files route per file; links elsewhere keep their current not-found behaviour.
- 857ab01: Enforce per-turn tool-call, wall-time, observed changed-path and write caps through the existing worker lifecycle and shared journal observations. Interactive turns freeze for a finite, once-per-dimension Continue or Stop decision; the free-space floor and true voice remain Stop-only. Retain scoped decisions, interruption/recovery receipts and truthful observation coverage in the existing turn disclosure and expose actual limits in This chat. Independent host deadlines and resource/storage limits remain binding.
- 6f74aaa: An answer whose turn-temp link was promoted into scratch now shows the link to the copy in the open conversation as soon as the turn has ended, with no reload and no marker (#1698). The server sends the turn's clients a new `message_links` frame (`{ sessionId, turnId, links: [{ from, to }] }`) for each promoted file, and the client rewrites those link destinations in that turn's answer, outside code, exactly as the saved answer was rewritten. A turn with no promotion sends nothing. For backend authors, the `promotion` activity event gains optional `aliases` listing other spellings of a link to the same file.
- 2151826: Show a dismissible saved-state warning at the existing 75% threshold using the
  backend's actual admission measurement. Preserve its age, dismissal across
  reloads, changed-allowance invalidation, quiet history, voice and focus behavior,
  and the existing reviewed continuation. Add optional result/history observations
  and provider allowance metadata without changing capacity or admission.
- 857ab01: Enforce admitted turn, conversation and UTC-day list-price inference budgets using completed response receipts, retained Activity usage and unknown-price token fallback. Share measured limits and once-only warnings with the existing turn disclosure; preserve partial work and reviewed conversation handoff on a named budget stop.
- f5433b3: Require existing per-use approval for visible outward commands in interactive turns, preserve force-push and voice refusals, and retain irreversible admission receipts in the turn journal. Explicitly disclose opaque HTTPS-script and unavailable outward MCP descriptor coverage.
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
- 56bad96: Recover retained artifact loads with truthful failure states, manual retry, confirmed preview expiry and keyboard focus return.
- 67a48ca: A server running as root now says so (#1638). Its agent workers run as root too, and although they have no capabilities and a read-only `/proc`, they can still read root-owned files and connect to root-owned and abstract Unix sockets. The server still boots. It logs that warning once at boot, reports it on `GET /api/status` as `runtime.workerHost.rootServer` (typed on `WorkerHostStatus` in `@schlessera/brain-ui-sdk/protocol`), and the app shows a standing notice above the composer that links the hosting guide's section on running the server as a non-root user.
- 3212c7d: Allow reviewed handoffs to any available profile, including the source conversation's own backend. Every handoff starts a distinct linked conversation. Preselect the source profile when recovering from `session_too_large`, closing the single-backend dead end while preserving review, reference checks, recording and idempotency. This is an additive contract behavior change: the same-backend refusal is removed.
- 52cbd1d: Add authenticated per-chat governed or strict preferences in the model picker's This chat section. Successful saves affect the next interactive turn, preserve the policy lower bound, and bind first-turn choices through the existing draft identity. Show voice facts read-only and unavailable limits as unknown.
- 857ab01: Retain explicit shared-window conflict versions and let authenticated users keep a selected observed version or both through the existing history operation, with raw-state checks, numbered exclusive siblings and journaled Undo.
- 1c20df8: The server now learns at boot whether its host can run agent workers, instead of finding out on every turn (#1632). Boot probes the agent worker boundary (the restricted envelope too while autonomous work is enabled), logs a failure once with its named requirement, and keeps running. `GET /api/status` reports the latest probe as `runtime.workerHost` (typed as `WorkerHostStatus` in `@schlessera/brain-ui-sdk/protocol`), every turn's own probe re-records it, and the new authenticated `POST /api/status/worker-host` re-runs the probe. While the host is unavailable, the app shows a notice above the composer that names the requirement, links the hosting guide's container section and offers "Check again". The composer stays usable. A turn sent anyway is still refused by its own probe, and its failure card now says the server can't run agent turns and shows the requirement, without offering a retry. Every turn still runs the probe: a passing result is never cached.
- 2b196b3: Every agent worker now runs under resource limits, so one runaway turn cannot exhaust the host (#1660). `prlimit` sets the process, per-process memory (`RLIMIT_DATA`), file size and open file limits inside the worker before the agent starts. Where the server runs alone in a delegated cgroup v2 subtree, such as a systemd unit with `Delegate=yes`, each worker also gets its own cgroup with `memory.max`, `pids.max` and `cpu.max`. The defaults are far above normal use: 4096 tasks, half the memory the server has (physical memory, or a lower cgroup cap above it), 16 GiB per file, 65536 open files and all CPUs but one. `BRAIN_UI_WORKER_LIMITS` overrides them, for example `memory=8GiB,pids=2048,cpu=2`. A host without `prlimit` (util-linux) now refuses agent turns and names that requirement. `GET /api/status` reports each limit as enforced or absent, with the reason, under `runtime.workerHost.limits` (`WorkerLimitsStatus` in `@schlessera/brain-ui-sdk/protocol`). The agent is told the same limits before it starts. A cgroup limit hit is recorded in the run's Activity next to the step that caused it. A limit that ends the worker fails the turn with the new first-party class `worker_resource_limit`, which names the limit. Backends report hits through the new `resource_limit` activity event.

### Patch Changes

- a8fbaa3: Report refused Claude worker-state copy-out as `worker_state_save_refused`, preserving actual turn usage, host cancellation and exhaustion precedence. Show an incomplete-save card with scoped Retry and disclose that retry does not recover unsaved transcript or agent memory.
- ea12d65: Keep classified answer blocks after reloading a conversation whose temporary
  artifact links were promoted to persistent scratch. Saved blocks follow the
  rewritten text and retain correct spans regardless of classification timing.
- 52cbd1d: Keep keyboard focus on the control a user selects while the Search panel opens.
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
  - @schlessera/brain-ui-kit@0.42.0

## 0.41.0

### Minor Changes

- 45326b1: Show follow-ups that are still waiting for the agent, and keep them through a reload. A message sent while a session is busy no longer appears in the chat until the agent takes it: it waits as a `pending` pill in the right half of the row above the composer, and its full text opens on hover, keyboard focus or a tap. Three or more show the oldest pill and a `+N pending` summary that opens a read-only `Pending follow-ups` sheet. When the agent takes one, its pill goes and the message appears in the chat once, where it entered the conversation; a dropped one leaves with its reason. The host reports each session's queue in a new `session_queue` frame (`server_hello.capabilities.followUpQueue`, sent only to clients that declare the same flag in `client_hello`) after a reconnect, after `session_resume` and on every change, so a reloaded or second client rebuilds the same stack. The kit adds `PendingFollowUps` and `followUpLabel`, and `ListRow` gains `describedBy` for pills.
- 637d2c4: Label pending follow-up and working-session pills with a few words from a small, fast model. A host that passes `createApp({ labeller: { provider } })`, with any value of core's `CompletionProvider` shape, gets a 2–4 word label for each queued follow-up (on `QueuedFollowUpView.label`, sent again in `session_queue` when it arrives) and for each session's latest request (on `ChatSession.label` in `GET /api/sessions`, stored so a reload or restart reuses it). Labels are plain text of at most `PILL_LABEL_MAX_CHARS` (32) characters. Pills render at once with their fallback, the session title or the start of the prompt, and keep it when the labeller is off, which is the default, or fails. With a labeller set, the text of every queued follow-up and turn request goes to its provider, which may be a different vendor from the session's backend. Calls are counted in `brain.labeller.calls`. The app's pending follow-up pills print the host's label when there is one.
- 07f5a26: Record on the device without a server voice session. `startLocalCapture` opens the microphone and records with MediaRecorder (`audio/webm;codecs=opus`, else `audio/mp4`), handing each chunk to a sink with its start and end in milliseconds; `stop(reason)` resolves once the final chunk was handed over and the microphone released. It makes no network request. `detectLocalCaptureSupport` reports whether the page can: a supported container, a Blob write to IndexedDB and a secure context, without touching the microphone.

  A root created with `localCapture: { sink }` offers it in the composer: with the host unreachable, the mic becomes "Record on this device", and a tap records into the sink. A recording stays one when the host comes back, and a dictation never turns into one. A refused microphone and a browser that cannot record on the device each get their own copy, and the latter shows no mic. Without the option nothing changes: online and offline, the mic dictates as before. Shipped builds leave it off until recordings are stored durably.

  The kit `Composer` gains `mic` (off hides the microphone) and `micLabel` (its accessible name when the capture is not dictation).

- f508e27: Keep the composer's drafts on this device across a reload. The authenticated `GET /api/vpn-check` probe now also returns `accountKey`, an opaque name for the signed-in account on this host and brain root that stays the same across sign-out and sign-in as the same owner, differs between hosts and roots, and is never given to an agent principal. The client writes every draft (text and images), the voice review text, the selection, the focused element and the transcript position to IndexedDB in that account's partition a moment after each change, and opens the partition only while it holds the same key. After an authenticated boot as the same account they come back: the text, images and review text, the selection and focus, then the place in the transcript. Another account restores nothing. A write the browser refuses shows `Couldn't save your draft on this device.` in the composer's hint and is never reported as kept, while editing goes on. Staged track files still live in this tab only. The stored drafts are not encrypted and are not protection against someone with access to the device.
- 89498a3: A service-worker update no longer reloads the page during a voice dictation or
  while dictated text waits in the review card, even when the composer's text
  field is empty. The reload waits for every update hold registered on the root
  and fires once when they are all idle. `registerUpdateHold(root, { busy,
subscribe })` lets other local work hold the reload the same way; the shell's
  `isBusy` option still adds its own work.
- ca68cbc: Add the local recording sheet, recording tray and editable transcript review; commit accepted text to the device-local draft before deleting its audio.
- 9a89d4a: Show configured profiles that cannot run now, with their reason, in the handoff sheet. `AgentBackend` gains an optional `listUnavailableProfiles()` returning `{ id, label, reason }`, with `reason` from the closed `PROFILE_UNAVAILABLE_REASONS` enum (`needs-credentials`). The Claude backend reports a profile whose required environment key is missing; pi lists every configured profile and omits the member. `GET /api/providers` gains an optional `unavailable` list beside `providers`, absent when empty: the runnable roster, routing and handoff resolution are unchanged, and the host drops any entry whose reason is not in the enum, so no key name or other backend text reaches a client. The handoff sheet's To list shows these profiles on other backends after the runnable ones, disabled and reading `needs credentials`; they cannot be chosen.
- b0815ec: **Breaking (pre-1.0, ruled on #1053):** narrow the public surfaces that were public only because a public declaration reached them, and move the names whose classification was uncertain.

  - `@schlessera/brain-ui-server`: `WsHost` keeps its configuration fields, `registry` and `close()`. Its connection, client-set, catalog, turn, activity, inbox, draft, label and classification members are `@internal`, as are the matching `WsHostOptions` fields. `SessionCatalog` and `createSessionCatalog` move to `@schlessera/brain-ui-server/internal`; a custom session catalog is no longer supported, so build the host with `createApp`.
  - `@schlessera/brain-ui-react`: `useChatStore`, `useFileStore`, `useShareStore`, `useUIStore` and `useVoiceStore` are typed as `ShellStoreHook<View>` over the new `ChatShellState`, `FileShellState`, `ShareShellState`, `UIShellState` and `VoiceShellState`, which hold the fields a shell reads and calls. The selector form and the `getState()`/`subscribe()` statics remain; `setState` is no longer typed. `activeChat`, `anyStreaming` and `hasPendingShare` take the views. `ShareIntakeState` is no longer exported, the full store state types leave the public surface, and `BrainUiRoot.stores` is `@internal`.
  - Moved to `/internal`, with no compatibility promise: `collectStats` and `CollectStatsOptions` (`@schlessera/brain/internal`); `MAX_ROUTE_BYTES` (the new `@schlessera/brain-geo/internal`); `applyExportLinkPolicy` and `protectExportLinkDestinations` (`@schlessera/brain-render-template/internal`); `TOKENS`, `LIGHT_TOKENS`, `canvas` and `TokenName` (`@schlessera/brain-ui-kit/internal`); the SDK's bridge-tool handlers (`handleAskUser`, `handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`, `handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`, `handleShowBlock`, with `ImageMaskHandlerOptions` and `LocationHandlerOptions`), `wrapCommand` and `execWrapperSpawnOptions` (`@schlessera/brain-ui-sdk/internal`); `describeRetry`, `canonicalModelId` and `resolveThinkingLevel`, from every SDK entry (`/internal` and `/internal/client`); `createToolRendererRegistry`, `pruneStoredShares`, `ShareTargetError`, `isShareTargetRequest` and `handleShareTargetRequest` (`@schlessera/brain-ui-sdk/internal/client`). `registerShareTarget` and `readShareLaunchParams` stay on `/share-target`.
  - Kept and documented: `repoRelativePathSchema` (module config schemas), `MEASURED_RUNTIME` and `runScrape`.

  The migration list is in `docs/decisions/public-export-boundary.md`.

- 67aea56: A restored approval card now follows the host. When the host advertises session recovery, a card it re-delivered after a reload stays answerable only while the recovery envelope lists its request as pending. Otherwise it turns read-only, without Allow or Deny, and says why: `answered on another device`, `ended with the turn` or `no longer yours to answer` (after a 401/403 read or a revocation, which also drops the card's request and turn identities). Nothing is sent when a card closes. The read is the tracker client's existing recovery read, now also made for a session that holds a restored card. A turn shell's header shows the host's `startedAt` for its turn when the envelope's latest turn is that one, and no time otherwise, instead of the page's clock. Without the capability, cards behave as before. `ToolCall` gains `approvalTurnId` and `readOnly` (a `RestoredApprovalClosure`), and `ChatMessage` gains `turnShell`.
- daf4546: Run the scripts of HTML files in the file viewer, isolated from the app. A new authenticated `GET /api/files/html?path=…` serves an `.html`/`.htm` file under the same path, auth and size rules as `?raw=1`. Its CSP `sandbox allow-scripts` directive gives the document an opaque origin, and `connect-src 'none'` and `form-action 'none'` keep it off the network. It is the only response sent with `X-Frame-Options: SAMEORIGIN`; every other response keeps `DENY`. The viewer's preview now loads that route in an `allow-scripts` iframe, and an "Open in new tab" link opens it full-screen with the same isolation. A previewed page cannot read the app's DOM, cookies or storage, call `/api/*`, open popups, submit forms, download files or navigate the app. It can still navigate itself to another site, carrying what it can read, and a tab shows it under the app's host: both are accepted residual risks (#1084). The SDK's default service-worker policy never answers an `/api` navigation from the app shell.
- 8327d47: A page that throws, or a lazy chunk a redeploy has replaced, no longer blanks
  the app. `AppShell` answers in place of the page, with a retry, a way back to
  Chat and a reviewed copy of the details, while navigation keeps working. A
  stale chunk reloads by itself when that is safe. Shells can wrap everything in
  the new `AppErrorBoundary` for a last-resort reload screen.
- 23599e2: Export the share pipeline (`shareMarkdown`, `renderBlockHtml`,
  `buildDiagramShareOptions`, `inlineMermaidDiagrams`), `splitFrontmatter` and
  `runStats` from the package root, for shells that assemble their own surfaces.
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
- 618064d: Show durable decisions and a read-only Queue in the existing Actions destination (#684).

  - `@schlessera/brain-ui-kit` adds `EffectPreview` (the exact tool, path and full input of a stored effect, with a 12-line reveal gate and a raw-text fallback for a malformed effect) and `DispositionBar` (commit, Later and Dismiss with 44px floors and a `Recording…` state), an optional `ActionCard.footLink`, and an optional `Button.ariaLabel`.
  - `@schlessera/brain-ui-react` subscribes to the durable Actions and Queue views when the host advertises them, and renders open decisions in the `needs you` lens after live approvals, grouped by thread in priority order, with notices after them and snoozed items under `Later`. FYIs are filed under `done › Notes`. Nothing changes on a tap until the server confirms it; refusals reconcile from a fresh snapshot and nothing is resent automatically.
  - The Actions badge now counts live approvals plus open, non-FYI durable decisions. Run notices keep their own count in the list and no longer badge.
  - A pruned run's detail now reads "Trace pruned · this run's rollup is kept."

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

- f21c430: The kit gains `DiscButton` and `DiscRow`, the overlay disc: a 32px paint in a 44px button with `ink` or `mute` rest ink and an optional label that expands leftward on hover and keyboard focus, instantly under reduced motion. `SuggestionItem` gains optional `cost`, printed as a gold effect chip, and `disabled` with `why`, printed at rest; a disabled chip stays focusable and ignores clicks, taps, Enter and Space. Interactive chips are at least 44px tall under a coarse pointer. Icons gain `latest`. The Chat page's New chat and scroll discs now use `DiscButton`: New chat is ink at rest and opens to its label, and the scroll disc is named `Scroll to latest` with a 44px target.
- 80657b9: The desktop rail follows D52 §1. Its destinations are Chat, Sessions, Actions, Files and Settings on ⌘1–⌘5 (Sessions is ⌘2, Actions moves to ⌘3 and Files to ⌘4). Graph is no longer a destination: it stays in the palette's Jump to, with no key. Under the destinations, the rail draws Search, Add a note and the Daily briefing (printing `spends` and its unavailable reason) with the palette's own handlers; collapsed, it draws only Search and Add. The passive ⌘K cap is now an `All commands` button that opens this root's palette by click, tap, Enter or space. Closing the palette without running a row returns focus to what held it. The palette lists Sessions once, under Jump to, and prints destination keys only under a fine pointer, as the rail does. A route that lands in Chat and then runs something (the acts, Sessions, New chat and the palette rows) now waits for unsaved Settings to be left before doing either.
- 18bc182: The phone bar is now Chat, Sessions, Actions, Files and More (D52). Sessions has a slot of its own and Graph has moved into More. More now holds Settings, Graph, Add a note, the Daily briefing, Sync and Brain statistics. The briefing always shows `spends` and Sync always shows `sync`, including when they cannot run. Each unavailable row gives the real reason: `needs the host` when offline, `a turn is running` while a turn streams. A Search disc sits left of New chat in an occupied chat below 480px. On the empty chat, the starting chips are the briefing (showing `spends`, disabled with its reason when it cannot run), Search and Add a note. Add a note replaces the statistics chip.

  Every bar slot replaces any open panel, and tapping the slot you are already on no longer closes it. The Sessions, Files and Settings drawers now stop above the phone bar, so every slot stays one tap away while one of them is open. A Files or Sessions tap from a view that cannot show that panel lands in Chat with the panel open. The UI store gains `openPanel("sessions" | "files" | "settings")` for this. Closing More with Escape or the scrim returns focus to the More slot.

- ea8506b: Track work left running in another session until you have seen it (D52 §4).
  Leaving a session by New chat, by selecting another one, or by leaving the
  page while its turn runs, is queued, waits on an approval or a question, or
  has a send the host never acknowledged, now records a tracker for it. So
  does work that starts in a session you are not looking at. A tracker's state
  comes only from the host: its recovery envelope when it advertises
  `sessionRecovery`, and the live frames between reads. The states, in display
  order, are needs you, failed, unconfirmed, running, queued, unknown, can't
  check, done and cancelled, and times are only ever the host's own. A tracker
  clears only when Chat shows that session's latest turn, with the document
  visible, no panel over it and the transcript at its end. Selecting the
  session or being scrolled up does not count, and an older observation never
  clears newer work. Each root stores only identifiers, under its own prefix
  (`${storagePrefix}:trackers:v1`); a different principal or a revocation
  deletes the set. Recovery reads never send a frame, select a session or
  start a turn. The strip and pane that show trackers are separate work.
- 7bfdc71: Show work left running in other sessions where you can reach it. Below 1280px the sessions you left busy, or whose work started while you were elsewhere, appear as pills in the left half of the row above the composer, most urgent first: `needs you`, `failed`, `running · 2m`, `done · 4m` and the other tracker states, labelled with the host's few-word label or the session title. Three or more show the most urgent and a summary that opens the `Working` sheet. From 1280px Chat has a 280px Sessions pane beside the transcript instead: `New conversation` is its one primary action (there is no New chat disc at that width, and in an empty chat the button is `aria-disabled` with `already a new chat`), and a `Working` group lists the trackers above the date groups. Pressing Sessions there stays in Chat and moves focus into the pane. In the drawer and the pane, Working replaces the single `Session running…` row, a tracked session is not listed again in its date group, and the list is one roving tab stop.

  Opening a tracker reattaches its session without starting a turn, shows its latest turn and moves focus to a waiting approval or question, a failed turn's primary action, or the composer (nowhere on a phone, so the keyboard stays down). It clears only once that latest turn is on screen. A latest turn the host cannot link offers `Mark as seen`. A change to `needs you`, `failed` or `done` is announced once in a polite live region; a reload, repeated frames and ticking ages announce nothing.

- f9999e3: Every session keeps its own composer draft. Text and images typed in one session stay with it: switching sessions, opening Actions, Files or Settings, and remounting the composer bring back exactly that session's draft, and nothing typed in one session appears in another. New chat, from the overlay disc, Sessions `New conversation` and the palette, opens an empty composer and keeps the old draft where it was, with no confirmation. A draft that has no session yet is listed in Sessions under `Drafts` (`Draft with 2 images` when it has no text) and opens again in an empty chat; a session with a draft prints `draft · 2h` on its row. Repeated empty New chats list nothing.

  On a host that advertises `capabilities.sessionDrafts`, drafts are saved there and restored after a reload and on the operator's other devices. The line under the composer says what happened: `draft · saved` only once the host acknowledged that exact revision, images included; `draft · saving…`, `draft · not saved yet` while unreachable, `too large to save` and `drafts saved · delete one to save this` for the host's limits, and `draft · this host doesn't keep drafts · kept on this device` without the capability. A draft changed on another device while edited here prints `draft changed on another device · Compare`; `Compare drafts` shows both versions and offers `Keep this device's`, `Keep other's` and `Keep both`, which turns the other version into a Draft entry. Nothing is merged and nothing visible is overwritten.

  A send is now a snapshot apart from the draft: the field empties when you send, the message names the saved revision so the host consumes exactly that one, and words typed after sending are the session's next draft. A refused message comes back into the draft. A message the host never confirmed (the connection dropped, or the host refused a frame without naming it) is held where it was sent as a `Didn't hear back` block with `Check again`, `Send again` and `Edit`; nothing is resent on its own. A new conversation's first message that is answered after you have moved on attaches to its own session without taking over the view. `useServiceWorkerUpdates` now also waits while any draft holds words the host has not saved, or a send has not been settled, since those live in the page's memory rather than on screen.

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
- ab55924: Breaking: remove the nonexistent `health().version` declaration and expose `timestamp`; callers needing software identity must use authenticated `status()`.
  Fix `brainSync()` to consume SSE terminal results and reject incomplete streams without retrying.
- ef479fd: Offer device-local unassigned voice capture on cached offline launches and from re-authentication, with locked account recordings shown only as aggregate size. Explain the one-online-load requirement in the worker's last-resort response.
- d2436b8: Continue a conversation on another backend (#61). The locked model picker, a session row's overflow and the ⌘K palette open a review sheet that drafts a handoff summary with the source's own model (falling back to a draft from the last six messages), lets you edit it and pick references, and starts a new linked chat on the chosen backend. The source keeps its history, backend and accounting and shows a forward marker; the new chat opens with a handoff card linking back. Additive wire: `chat_message.handoff`, `handoff_prepare`/`handoff_prepare_cancel`/`handoff_status`, `handoff_draft`/`handoff_receipt`, message source `handoff` and `ChatSession.handoffFrom`. A repeated handoff key never creates a second session. `ModelPicker` gains an optional `lockedAction`.
- 4c29de7: Require explicit association of unassigned recordings and warn before sign-out deletes account-local work.
- 11c54ba: Explain Actions-limit hygiene pauses and server-confirmed Resume outcomes, with accessible focus and responsive panels.
- 1a8ba32: Present human-started hygiene reviews in Actions with finding evidence, typed repairs, exact previews, confirmed dispositions, recovery controls and review receipts. Reuse the durable inbox stream, and explicitly refresh stale findings through the server-owned replacement operation.
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
- 416bda6: Compose Markdown fences through CodeBlock with exact source copy and a
  kit-token syntax theme in both themes. CodeBlock accepts highlighted
  children and a host-owned head action; wrapping preserves full commands.

  Pre-1.0 breaking change approved in #1142: CodeBlock no longer defaults to
  bash or a sample command and draws no action-less copy glyph. Consumers
  must pass lang explicitly when wanted, code or children for content, and
  an action for a real control. Native wrap=false scrolling is retained.

- 0c889d7: Stop capture and save the work context before locking protected views on auth expiry; restore it after same-account sign-in without a reload.
- 0f54eea: Add account-partitioned local audio recordings with committed recovery, playback, hard caps and update holds.
- 8d966cf: Transcribe retained recordings only after explicit upload consent through the server. Add optional saved-audio speech support, read-only capability/status discovery, durable account-owned receipts and tombstones, and at most three explicit retries for definitive transient provider failures. Deepgram supports saved containers; Web Speech remains unavailable. Retain local audio through failures and durable transcript review, coordinate tabs, and never upload automatically on reconnect or reload.
- 9857f6f: Render Search and agent search results with the shared search card, preserving all snippet highlights, real scores when available, warnings and root-scoped file navigation. The kit gains optional title, type, selected-state and multi-highlight segment props; existing single-highlight callers remain supported.
- 7b4f62a: Add a bounded data-only `show_block` supporting-files variant rendered through RelatedFiles in chat, replay and static exports. Keep file opening in the current root, omit invented scores and sample metadata, and make actionable rows at least 44px tall.
- b05d556: `show_block` gains a `tracker` block (#1001): issues and pull requests the agent opened, closed, reopened, merged, labeled, commented on or reviewed, as `{ kind: "tracker", events: [{ url, action, qualifier?, title }] }` with 1-20 events.

  - **ui-kit:** `TrackerPillList` draws each event as one tappable line, `action [qualifier] · number · title ↗`, under run headers that name the host and repository. Repository, number and type are derived from a GitHub-shaped `url`; any other address shows only its title, action and host. Long titles truncate instead of wrapping, a refused address draws a withheld line with no anchor, more than six events collapse to five behind `Show all N changes` (a shared image or PDF draws them all, titles in full), and the list always says the changes are as reported by the brain.
  - **ui-sdk:** the schema rejects an event carrying any key besides its four, so a payload cannot state a repository, number or type, and the handler rejects an event whose address the link policy refuses, naming its position and the reason. The `show_block` description tells the model to use `tracker` instead of listing tracker changes in prose; the per-turn brief is unchanged.
  - **ui-react:** the block renderer draws `tracker` blocks.

### Patch Changes

- 07345fa: Connection drops no longer move or reset what is on screen. The composer's hint line stays one line high (text that does not fit ends in an ellipsis), so the offline reason arriving or leaving no longer moves the field. A draft whose save is still on its way keeps the save line's place under the composer. Reconnecting in the middle of a running turn reattaches to it: the host's greeting no longer ends the stream in view, and a history replay keeps the messages already drawn (and their nodes, times and the reader's scroll position), so the answer keeps streaming into the same message. A track upload that fails in transit just before the page sees the connection go now waits and resumes with the connection instead of showing a failure.
- 70af334: On the desktop rail, ⌘2/⌘4/⌘5 and the palette's Jump to rows, Sessions, Files and Settings no longer toggle (D52 N1/N3). Pressing the destination that is already open leaves it open, and each one replaces any other open panel. Files from Actions, which has no Files panel, now lands in Chat with Files drawn rather than setting the flag with nothing shown.
- 42228d3: From 480px up, the Sessions, Files and Settings drawers and their backdrops stop beside the desktop rail instead of covering it, as they already stop above the phone bar. With one of them open, every rail destination is one press away again (D52 §2, "Panel open: 1"). Search, Add and the job panels still cover the rail.
- 3c49d9f: Pressing the destination already shown, by rail row, ⌘1–⌘5, the palette's Jump to or a phone bar slot, now scrolls it to its start and moves focus instead of doing nothing (D52 N3 and its addendum). Chat's start is its latest turn: it does what `Scroll to latest` does, then focuses a waiting approval or question, the latest turn's failure, or the composer with the caret at the end; on a phone focus stays on the Chat tab. Sessions focuses the running session, then the one in view. Actions, Files and Settings focus their selected run, file or section, and fall back to their heading. Nothing is closed or cleared. Run rows in Actions now carry `aria-current` for the run the detail shows.
- 270cb63: Say which backend to fix when Continue on another backend cannot run because the other backends are set up but none of their profiles can run. The entry in the locked model picker, a session row's menu and the desktop palette stays disabled, and now names every such backend, as `useBackendName` does, followed by the reason, for example `pi needs credentials` or `pi, codex need credentials`. It reads `can't run now` instead when any of those profiles reports another reason. `no other backend set up` is now shown only when no other backend reports any profile. `useBackendName` now falls back to the label of a profile that cannot run before it falls back to the backend id.
- 0146922: A new chat that holds only staged track files (GPX, KML, GeoJSON) stays reachable after New chat. Sessions lists it under `Drafts` as `Draft with 1 track file`, with the state line `draft · tracks in this tab only`; a draft that also has text or images reads `draft · {save state} · tracks in this tab only`. A failed upload (`1 track failed`) is shown before one still under way (`uploading 1 track`). Opening the entry brings back the same staged tracks, uploads continuing, and sends nothing. Removing the last track from a chat with no text or images takes it out of Drafts at once and puts focus in the composer field. At 1280 and wider, the Sessions pane's `New conversation` is available while the new chat holds staged tracks. Tracks are never called saved: they live in this tab's memory only.

  `useServiceWorkerUpdates` now also waits while any session or new chat holds a staged track, whichever is in view, and reloads once when the last one is sent or removed.

- dff882e: Ask before leaving the page while staged track files would be lost. While any session or new chat holds a staged track (GPX, KML, GeoJSON), whichever is in view and whatever its upload state, the page asks the browser to confirm a reload, tab close or navigation away, including a reload the app starts itself, such as the one after signing in again. The browser shows its own confirmation, with its own words. Sending or removing the last track removes the guard, and the service-worker update's reload after it never asks.
- d5a5feb: Keep what was dictated when the speech provider ends a dictation on its own. When the Deepgram socket closed (end of stream, an idle timeout, a dropped connection or an expired grant) or the browser's speech recognition ended without a stop, the dictation sheet closed and the words heard so far were lost. They now go to the review card as Done hands them, in the same update that ends the dictation, so a pending app update still waits for them. A dictation whose composer unmounts mid-capture keeps its words the same way, and a replaced recognizer ending late no longer ends the dictation that replaced it.
- 6ce696e: Keep pending approval controls stable as their detail panels mount, so an early phone touch produces its original approval reply. Respect reduced motion for tool details while preserving ordinary expansion animation.
- 5ffb624: Keep tool permissions pending when a decision send is refused, preserve restored approval controls through reconnect history, and avoid false Actions decision or policy-write receipts.
- f341317: After a reload, the chat no longer shows the welcome screen while the next message would go into the previously selected conversation. Until that conversation's history arrives, Chat says "Restoring conversation", the composer keeps the draft and explains why sending waits, and no message can be sent into it from any surface. The history request is confirmed rather than fire-and-forget: it is asked for again on the next connection, and once on the session's next idle status, and a request nothing answers ends after 20 seconds in "Couldn't restore this conversation" with Retry and New chat, as does a load error. Retry only reads the history again; New chat starts a new conversation without the old session id. Nothing is sent automatically once the history arrives. The host logs one `session resume` line per `session_resume`, with the session id and its outcome (`loaded`, `error` or `unauthorized`).
- e159c45: A tool renderer that throws no longer takes down the app. The failing call
  falls back to the generic tool view, including its approval card, and the
  error is reported once.
- a1e007c: Internal: the root crash screen's native button carries a raw-button marker for
  the new lint gate. Behaviour is unchanged.
- 964f7dd: Internal: ui-react's stores, lib and connection modules no longer import its
  components. The pure helpers they used moved into `lib/`. The public exports
  are unchanged.
- 2c3e5bd: The Daily briefing panel now shows the keyless `brain briefing` output from `GET /api/brain/briefing`, the selected root's existing briefing route, with loading, empty, failure and Retry states. The internal `POST /api/brain/whatsup` route is gone, and with it the repo-local script lookup at `private/whatsup.ts` and `scripts/whatsup.ts` and its forced `--gemini` flag: opening the briefing runs no script and no agent turn. Because the briefing cannot spend, the rail, palette, More sheet and welcome chip no longer print `spends` beside it.

  `SuggestionChips` now sets its chip gaps as longhands, so a chip whose reason comes and goes on a rerender no longer makes React report a conflicting `gap`/`rowGap` style.

- dcdda5d: The app shows the brain-kit logo where the lucide Brain icon stood in for it: the desktop side rail's wordmark tile, the login screen and the empty chat. `EmptyState` gains `brand`, which shows the logo on a plain tile in place of the icon. The Chat tab and command palette keep the lucide Brain navigation glyph.
- 810af03: Enter runs a slash command instead of sending it. Typing `/stats` and pressing Enter shows the statistics, as clicking its row in the command palette does; nothing goes to the agent. While the palette is open, Enter runs its highlighted row, the first by default, and the up and down arrows move the highlight, which is marked with `aria-current` and announced. A command typed in full still runs after Escape closes the palette, and a draft that starts with `/` but names no command, such as `/etc/hosts?`, is sent as before.
- 77b9db4: Give the Files drawer close button the accessible name “Close Files” so assistive navigation can identify and dismiss it.
- 067d63c: Paper Buttons in the primary and affirm tones keep their near-black label on hover. `--bk-button-hover-fg-primary` and `--bk-button-hover-fg-affirm` now point at `--bk-on-fill` instead of `--bk-color-canvas`, so the hovered label on the amber and teal lift fills is `#231f1a` (8.64:1 and 9.10:1) instead of the paper canvas colour (1.54:1 and 1.46:1). The dark theme resolves to the same `#0c0e12` as before, and fills, borders and caller-owned `style` are unchanged. ui-react's precompiled stylesheet carries the corrected aliases.
- 2274b9e: Use kit icon, text and row controls in Actions and Queue, keeping pricing status visible on phones and providing consistent touch targets and keyboard focus.
- 0c156cb: Add touch and pen header swipe dismissal to sheet-shaped Overlay surfaces, with bounded feedback, cancellation and reduced-motion support. OverlayCloseReason gains the additive "swipe" reason. Dictation treats swipe as Stop and keeps words for review.
- 17a6f84: Use kit icon and text actions for media, tool timelines and track controls, and kit row interaction for composite timeline and command rows.
- c8b317a: Use kit controls for chat, handoff, draft comparison and share actions, with accessible names, focus rings and touch targets.
- 48e8460: Keep the chat transcript's top spacer until its message area reaches 888px, so the centered reading column clears the New chat target.
- 7e398dc: Use the shared Overlay for app sheets, dialogs, fullscreen tools and panels. Escape dismisses only the topmost surface, modal focus stays inside and returns on dismissal, and destination panels keep the phone bar and rail operable. Palette and More actions run after closing. Expose the overlay surface ref and destination heading for app navigation adapters.

  CommandPalette no longer carries dialog semantics (`role="dialog"` and `aria-modal`); wrap it in Overlay to supply modal semantics and focus management. This standalone-consumer behavior change ships in a pre-1.0 minor.

  Credential and created-handoff focus destinations use deferred focus getters, preserving their targets when the owner unmounts.

- f752ff9: Restore shared Button hover colours while preserving caller-owned styles.
- 2f0c99d: Show a distinct graph unavailable state when the server cannot load core, preserving mode navigation and hiding unusable scene controls.
- b92cdb5: Keep reading server-owned hygiene review state during next-item selection so a final confirmed disposition displays Review complete without reloading, including on another connected device.
- 276a6de: Preserve local hygiene decision attribution across successful intermediate updates until the confirmed lifecycle transition. Fix, manual recheck, Dismiss and Later no longer show a false receipt from another device.
- 5b0c7d6: Keep hygiene decision controls and desktop detail entry unavailable while a REST finding awaits inbox replication. Enable the same pending Action when it arrives, without replaying an earlier response.
- 978031a: Add a deterministic human-started hygiene review backed by durable Actions, with pause/resume, confirmed CLI previews, persisted failure outcomes and check-only interrupted-write recovery. Extend the inbox contract with bounded handler input and hygiene effects. Existing generic cards display the new effect as unavailable until the separate hygiene surface is implemented.
- f91c9e3: Keep both versions of a device-local draft when two tabs edit it concurrently.
- 9adc62e: Move the Working and Pending follow-up sheets and the phone ModelPicker onto the kit Overlay's native modal coordination, preserving their contents and caller actions. Keep existing sheet chrome, inherit subtree themes without sheet portals, and enforce the removal of the two legacy overlay exceptions.
- 97021a4: Use StreamingAnswer for first-content, approval-wait and retry status while
  preserving rich transcript rendering and the composer's single Stop control.
  Show only measured elapsed time and announce only phase changes.

  Approved pre-1.0 breaking migration: StreamingAnswer no longer supplies example
  phase, target, elapsed, answer or cost. Pass those facts explicitly where known.
  The polite live region contains only the phase word. Set the new `pulse` prop
  to false for a static decision-wait dot.

- 65215fb: Keep the principal learned from the host when an older startup storage read
  finishes later. Offline answers can then be saved for the current principal;
  results from before logout or disposal cannot restore admission authority.
- fd01063: Use kit icon and text actions across Files, graph, search, image viewing and voice review. Preserve composite row interaction and keep voice review actions reachable at narrow widths.

  Draw Overlay dismissal with the native mute IconButton, retaining its accessible name and 44px target, including untitled media and dictation close slots.

- ec033c9: Show persistent, dismissible dictation failure explanations with safe copy while keeping captured words for review.
- 5d48d1d: Use the shared Overlay for local-work warnings, diagnostic reviews and draft comparisons, with consistent dialog geometry at 900px and shared focus and dismissal handling.

  Wait for the shared dialog's entrance transition before asserting visibility in the review stories.

- 7b2d470: Keep dense graph nodes distinct with relative exponential sizing, tighter linked clusters and attached reminder branches, clearer reciprocal edges, and responsive labels that prioritize the focused neighborhood. Bound layout work with fewer iterations and stop collision cleanup when marks settle.
- 27671c2: Render Activity run subagents through AgentOrbit using recorded identities and
  needs-you/running/ended rings. Denied and cancelled agents use the neutral
  stopped state; no radius represents progress.

  Pre-1.0 migration approved in #1145: callers must pass agents with stable id
  and state. Remove orbit/angle props; the kit computes placement and accepts
  an optional state ring. Pass coreMeta explicitly. Empty/missing data draws
  no sample agents. RunState now includes stopped, also styled neutrally in
  AgentRunCard. Phone hosts pass compact; labelled pills use onOpen(id) and
  onOverflow callbacks, with a truthful count legend.

- 879352b: Render retained Activity run intervals through LaneChart on one recorded time
  axis. Only explicit approval boundaries hatch; only recorded active work has
  an open tail, and missing terminal timing is disclosed without inference.
  Preserve outcome words and complete readable timing in both themes and on phones.

  Expose LaneChart's existing HATCH_GLYPH constant from the public kit barrel so
  hosts can supply the documented waiting legend. Long lane names and legends wrap.

- 9857f6f: Render real chat and subagent tool permissions through ApprovalCard, retaining full targets, actual input/diffs and risk wording, eligibility-gated remembered grants and focus-scoped decisions. Duplicate or closed requests cannot send a second reply. ApprovalCard accepts input details, wrapped runtime headers and an optional remembered-grant action.
- 2a7de32: Preserve leading dots in bare and inline-code chat links to scratch files and
  directories, and document preview/download through direct links while scratch
  remains hidden from normal file-tree browsing.
- 4c92b91: Render sent validated tracks through AttachmentRow with the same identity and
  known metadata live and after history replay. Preserve image thumbnails/zoom
  and composer retry/remove controls.

  AttachmentRow's approved pre-1.0 breaking migration requires `kind` and `label`.
  Pass optional duration, metadata, extract and provenance explicitly; sample
  facts are no longer defaults. `meta` also accepts a list of wrapping lines.

- a9e934d: Use kit icon buttons, switches and text actions in Settings and Share, and kit keyboard interaction for settings tabs, variant segments and share menu rows.
- Updated dependencies [45326b1]
- Updated dependencies [637d2c4]
- Updated dependencies [07f5a26]
- Updated dependencies [07345fa]
- Updated dependencies [ca68cbc]
- Updated dependencies [9a89d4a]
- Updated dependencies [b0815ec]
- Updated dependencies [daf4546]
- Updated dependencies [341bee1]
- Updated dependencies [9ef25ef]
- Updated dependencies [bddc92b]
- Updated dependencies [2c3e5bd]
- Updated dependencies [1caadca]
- Updated dependencies [02fd0b9]
- Updated dependencies [b68dd15]
- Updated dependencies [b68dd15]
- Updated dependencies [dcdda5d]
- Updated dependencies [a9a3376]
- Updated dependencies [825cd04]
- Updated dependencies [543231e]
- Updated dependencies [5416a22]
- Updated dependencies [618064d]
- Updated dependencies [98baa4c]
- Updated dependencies [2529d28]
- Updated dependencies [f21c430]
- Updated dependencies [2808074]
- Updated dependencies [75e79b6]
- Updated dependencies [067d63c]
- Updated dependencies [18d5dde]
- Updated dependencies [a95f7c2]
- Updated dependencies [6a46e7f]
- Updated dependencies [6f06be8]
- Updated dependencies [84b8e00]
- Updated dependencies [368c318]
- Updated dependencies [0c156cb]
- Updated dependencies [ee4bcf0]
- Updated dependencies [90d83d8]
- Updated dependencies [e7f0ff3]
- Updated dependencies [ef479fd]
- Updated dependencies [7e398dc]
- Updated dependencies [62c912c]
- Updated dependencies [d2436b8]
- Updated dependencies [56cf3e3]
- Updated dependencies [33af7e2]
- Updated dependencies [f752ff9]
- Updated dependencies [b04f98b]
- Updated dependencies [978031a]
- Updated dependencies [e632b50]
- Updated dependencies [1a8ba32]
- Updated dependencies [d89e175]
- Updated dependencies [9adc62e]
- Updated dependencies [533c0a7]
- Updated dependencies [97021a4]
- Updated dependencies [416bda6]
- Updated dependencies [9e8dc3e]
- Updated dependencies [fd01063]
- Updated dependencies [7e398dc]
- Updated dependencies [c1052e2]
- Updated dependencies [5d48d1d]
- Updated dependencies [b180a2f]
- Updated dependencies [a713b14]
- Updated dependencies [5b1cd90]
- Updated dependencies [ad855ce]
- Updated dependencies [374bdd6]
- Updated dependencies [27671c2]
- Updated dependencies [879352b]
- Updated dependencies [9857f6f]
- Updated dependencies [8d966cf]
- Updated dependencies [2a7de32]
- Updated dependencies [9857f6f]
- Updated dependencies [4c92b91]
- Updated dependencies [83585eb]
- Updated dependencies [0e4290f]
- Updated dependencies [0c156cb]
- Updated dependencies [70275b9]
- Updated dependencies [7b4f62a]
- Updated dependencies [693cb3e]
- Updated dependencies [b05d556]
- Updated dependencies [3dddcc9]
- Updated dependencies [96ad470]
  - @schlessera/brain-ui-sdk@0.41.0
  - @schlessera/brain-ui-kit@0.41.0

## 0.40.0

### Minor Changes

- b1b83cd: Report deterministic recorded coverage, broken-link and orphan trend verdicts
  through stats, maintain, briefing and the PWA, with comparison evidence and
  explicit insufficient, stale and incomparable states.
- 0575b1b: Add `ask_user_list`, a bridge tool that asks the user to place up to 30 items on one shared scale of 2–8 options in a single card, for rating, triage and sorting. The result maps item ids to the chosen option, lists the skipped ids, and carries optional per-item notes. It ships as new `ask_user_list_request` / `ask_user_list_response` protocol frames, a kit `AskUserListCard` (inline chip grid, "set the rest to …" with undo, a Submit that states what it will send and never silently does nothing), and a transcript binding that replays the answered summary after a reload. Both backends expose it, and withhold it from turns that have no one to show a card to. `ask_user` is unchanged.
- 830127c: Keep desktop dictation in a bounded panel above the composer, with focused stop controls and an unchanged phone sheet. Add a dictating composer state that preserves the draft and prevents typing or sending until review.
- 0c0c9df: Add `ask_user_form` for conditional questions answered in one card, with shared scale and ranking controls, configurable depth/node/options limits, visible-answer validation and history replay. Keep the existing ask tools available.
- c1a1595: Render recoverable failed-turn cards with reviewed diagnostics, subscription auth instructions, and a latest-turn Retry that retains original inputs and checks delivery after reconnect.
- 60d9690: A `/stats` answer is part of the session (#582): in an existing session it is sent to the host with a plain-text rendering of its figures, so the agent sees them with the next message and a reload or a second device shows the answer again, drawn with the kit. In a draft conversation it is kept with the draft and sent with the message that starts the session. When it cannot be kept (no connection, or the host refused it), the answer still renders and says it was not saved to the conversation.
- 4503591: Add schema-driven module Settings with per-module JSON overrides, validated revision-guarded saves, explicit source-preserving migrations and separate lifecycle/actions. Jobs exposes its complete scoring format, adapter choices and execution settings, preserving legacy scoring representation during migration and edits.
- ccdd301: New chat is now an icon-only disc in the top-right corner of the chat's message area, drawn like the scroll-to-bottom disc, instead of a row of its own above the transcript. The transcript gets that height back. The button is a 44px target named "New chat" (label and title), still shown only once a conversation exists, and it still starts a new chat in one activation. While the message area is narrower than 880px, the transcript's content starts 40px lower so the resting first message clears the disc. That space scrolls away with the content.
- 0064d67: Show observed retries on failed-turn cards and preserve reported future cooldowns across replay. Retry becomes available when the reported reset passes, while pending sends and uncertain delivery retain their existing recovery behavior.
- a01c389: Add per-message reasoning effort with saved profile defaults for Claude and Pi.
  Claude defaults to Opus 5.5 at medium; each resumed turn re-reads its default,
  unsupported levels resolve downward, and retries retain the original override.
  Expose supported levels and honest requested/confirmed effort metadata. The
  existing model chip opens a model/effort picker; overrides clear on correlated
  start or queue acceptance and remain with refused drafts. Older hosts retain
  their existing send behavior.
- 35fb78d: Add ask_user_rank: one list ordered by handle drag, taps or keyboard, with explicit kept-order results, optional top-N cutoff, and answered transcript replay.
- bd19d83: Add a copy control to every raw text block: the run detail's raw trace and pruned rollup, span event payloads, a tool's raw input and its clamped output. The shared copy button stays visible on touch devices instead of only appearing on hover.
- 878e6cf: Record `brain stats` over time (#581). `brain maintain` gains a `stats` step, run after the index and audit, that keeps the day's figures as one line of `.stats-history.jsonl` at the brain root: the counts, the health figures and the size totals, one snapshot per UTC day (a second run the same day replaces it), every day for 90 days and then one per week. The file is committed with the brain, so `brain index --force` and a fresh clone keep it; nothing indexes, validates or audits it. `brain stats --record` records on demand, and `brain stats --history [--since YYYY-MM-DD] [--json]` reads the snapshots back oldest first, one array per field, with `null` where a snapshot has no figure. `brain stats --json` is unchanged.

  `GET /api/brain/stats/history` passes the history through, and the PWA's /stats answer draws trend charts for documents, orphans, stale documents, embedding coverage and the broken-link rate once two snapshots exist, and nothing with fewer.

- 3f0870d: Attach validated GPX, KML and supported GeoJSON originals in chat, preserving incoming names and MIME separately from detected staged names. Keep server-derived file evidence on queued turns and replay. Draw static track blocks with complete metrics, waypoint evidence, explicit unknown and partial values, separate gaps and original references; resolve assets before PNG/PDF export. Generic share intake remains compatible.
- efafbb3: A failed turn is shown as soon as it ends, not only after a reload (#575). The assistant row shows the `**Error:**` line it always showed for an error, and for a Claude subscription auth failure the #254 instruction for what to do next. A turn that fails before any text arrives no longer leaves an empty row. A partial answer stays above the error. One failure is shown once, even when a diagnostic error came first. The same turn reads the same after a reload. While the runtime is retrying a failed call, the row says so ("Retrying (attempt 2 of 10) in 5s after rate_limit, HTTP 429") in place of the thinking indicator.

### Patch Changes

- 6267d4f: Add explicit nonpersistent autonomous turns and synchronous escalation capture.
  Both backends preserve ordinary session behavior while headless attempts keep
  runtime identity and usage in Activity without saving interactive history. This
  supplies turn plumbing; autonomous dispatch remains gated on containment,
  budgets, admission and system verification.
- 7386b7b: Keep frame validation and rate-limit refusals in connection recovery without adding a false failed assistant message to a running conversation.
- 3f6c88f: `useDictation` releases capture through one helper shared by Stop/Cancel and its unmount cleanup. No behaviour change: teardown still invalidates the in-flight start, aborts a pending session request and stops the current ASR client, including one started after the hook mounted.
- cbc683a: Define durable Queue/Action frames and strict v1 effect validation; safely ignore the new frames in clients awaiting subscription wiring.
- 3829fed: Render multi-question ask_user exchanges in one grouped card, with visible validation, preserved free-text answers, and one answered or dismissed record.
- 08321a5: Restore the phone dictation sheet's 200ms upward entrance through both CSS entry points, respecting reduced motion.
- d934fe0: Keep ranking keyboard instructions readable when reordered actions wrap at phone width and preserve 44px touch targets for its footer actions.
- fa6a62c: Add optional `embed: false` type policies that retain keyword search, links and
  audit while skipping chunk contexts and Markdown/image/PDF vectors. Ordinary
  indexing removes existing vectors after a type opts out, even for unchanged
  files; opting back in takes effect on the next embedding-enabled index.

  Change nullable `health.embedding_coverage` to count only eligible chunks and
  their vectors. Total chunk/vector inventory fields keep their meaning, and
  zero eligible chunks remain unmeasured. This is an approved pre-1.0 semantic
  contract change: consumers should use the supplied ratio rather than divide
  the total counters. CLI and chat stats wording now names eligible chunks.

- Updated dependencies [0575b1b]
- Updated dependencies [dee9b10]
- Updated dependencies [6267d4f]
- Updated dependencies [96b2339]
- Updated dependencies [f0b84c0]
- Updated dependencies [0aaabdd]
- Updated dependencies [c849bf2]
- Updated dependencies [830127c]
- Updated dependencies [a4d5ef0]
- Updated dependencies [0c0c9df]
- Updated dependencies [cbc683a]
- Updated dependencies [f19da8b]
- Updated dependencies [c1a1595]
- Updated dependencies [3829fed]
- Updated dependencies [95865d1]
- Updated dependencies [48c87e1]
- Updated dependencies [0506c10]
- Updated dependencies [60d9690]
- Updated dependencies [4503591]
- Updated dependencies [619ee2b]
- Updated dependencies [a01c389]
- Updated dependencies [d934fe0]
- Updated dependencies [35fb78d]
- Updated dependencies [1eaeba2]
- Updated dependencies [49bc6b2]
- Updated dependencies [cf6fee6]
- Updated dependencies [67c7403]
- Updated dependencies [d9e64c9]
- Updated dependencies [3f0870d]
- Updated dependencies [efafbb3]
- Updated dependencies [4c1a424]
  - @schlessera/brain-ui-sdk@0.40.0
  - @schlessera/brain-ui-kit@0.40.0

## 0.39.0

### Minor Changes

- f5a8f81: The model can offer up to two follow-ups under its answer (#40). `show_block` gains a thirteenth kind, `suggestions`: `label?` and `items[1..2]{label, icon?}`, each label one line of 4-80 characters. That is the data of the kit's `SuggestionChips` without `tone`, and a type test holds the two together in both directions. Both backends offer it through the tool description; the per-turn brief is unchanged.

  `@schlessera/brain-ui-react` draws the turn's last valid call as the answer's closing row, a row of chips after the text and share menu, never where the call was made. A chip puts its words in the composer, below any draft, and never sends: no message, no answer to a pending question, no approval. The row is gone once the reader sends anything. It is not drawn while the turn runs, while a question in the turn is unanswered, when the answer ends in a question, while voice holds the composer, or on a turn spoken in a voice conversation. The client also drops duplicates, a restatement of the reader's own question, and generic filler. The decision reads only the transcript and current state, so a replayed session draws what the live one did. Shares and prints leave suggestions out, and the welcome chips are unchanged.

- cf94a81: `show_block` gains a `link` block (#43): one external page the reader may want to open, as `{ kind: "link", url, title?, description? }`.

  - **ui-kit:** `LinkPreviewCard` gains a link mode, switched on by a new `url` prop, with `description`, `expanded`, `onExpandedChange` and `onCopy`. The card derives the host it shows and the `href` it opens from one parse of `url`, so no caller can supply a host that disagrees with the destination. The host is the first line and is never ellipsised; an internationalised name leads with its ASCII (`xn--`) form and adds a "reads as" line. The title and description render as the brain's words, with an attribution line on every card. Nothing is fetched. The card opens the page only from its `Open ↗` anchor (new tab, no opener, no referrer), and the full address sits behind a disclosure. A refused address draws a "Link withheld" card with no anchor. Without `url` the card is unchanged. The policy is `classifyLink`, exported from `@schlessera/brain-ui-kit` and from the new React-free `@schlessera/brain-ui-kit/links` entry.
  - **ui-sdk:** the `show_block` handler rejects a `link` block whose address `classifyLink` refuses (relative, not `http(s)`, carrying credentials, containing invisible or bidi characters, mixing scripts in one hostname label, or longer than 2,048 characters), naming the reason. ui-sdk now depends on `@schlessera/brain-ui-kit` for that function.
  - **ui-react:** the block renderer draws `link` blocks and copies the exact address to the clipboard from the card's Copy control.

- e5d3cc0: A dictated message keeps its dictation badge after a reload or on another device (#549). The composer, the ask-user re-ask and share intake send `source` on every `chat_message`, and a replayed user message takes its `source` from history, defaulting to `typed`.
- b1805ee: A markdown link in prose shows where it goes (#551, D49). Every link `BrainMarkdown` draws, apart from repo file and directory links, is classified by `classifyLink` on every surface: answers, share blocks, `ask_user`, the briefing and the file viewer, autolinks included. An accepted link keeps its text and shows the ASCII host beside it, `your bank (account-check.example)`, with `rel="noopener noreferrer nofollow"` and `referrerpolicy="no-referrer"`. A refused link is inert text followed by `[link withheld — <reason>]`. A `mailto:` link stays live with its address shown, and its query parameters (`subject`, `body`, `cc`, `bcc`) are dropped from the href. While an answer streams, a link that has not closed yet is held back, so no raw address or half-typed autolink is ever drawn.

  `@schlessera/brain-ui-kit/links` gains `classifyMailto`, a check beside `classifyLink` for the one scheme prose keeps live. `classifyLink` is unchanged, and the `link` block still refuses `mailto:`.

- b8c355d: `show_block` gains a `map` block: 1 to 30 named places, drawn on real geography with a numbered list under them that always carries every place (#44). The model supplies places and, when a source states them, coordinates. The surface decides everything the drawing needs: one map, a pair of maps for two groups too far apart for one, or only the list, with a line that says why. The payload has no span, zoom, box, tone or numbering field.

  - **ui-sdk**: `MAP_BLOCK_SCHEMA` joins the block union, and the tool's description and brief name it. `planPlaces` (from `/client`) is the pure plan behind the drawing: rows in payload order, the mode, each frame's geometry box, and whether names fit on the map. A place with no coordinates, at `0, 0` or past ±85° is listed with the reason and never pinned.
  - **ui-kit**: new `PlaceMap` and `PlaceList` blocks. `MapView` gains additive props: `pinMode="number"` (numbered badges, lettered clusters such as `A·5`), `onClusters`, `letterFrom`, `coordChip`, `describe` (an accessible name, with the list as its description), `framed`, and `MapPin.n`. `mapViewBounds` exports the box the view draws. Existing `MapView` output is unchanged.
  - **ui-react**: `BlockCard` draws the `map` block. It fetches each frame's geometry through the existing `/geo/coastline` route and cache. When geometry is empty or unavailable, the frame becomes a one-line note and the list still carries every place. A shared answer draws the list and asks for no geometry. `BlockCard` takes an optional `isStatic` prop for renders nothing will update.

- 4f43158: Show client and server releases and application revisions in stats, including mismatched and unavailable identities.
- 826152e: `/stats` answers with kit blocks instead of a markdown bullet list (#97). It asks both channels at once: the corpus over `GET /api/brain/stats` and the runtime over `GET /api/activity/stats`. Each answers in its own blocks, and either can fail without taking the other down. The answer shows two tile rows (corpus, then runtime), bar lists for documents by type, status and relevance, and receipts for the corpus, the runtime window, the lifetime record and what is on disk. A notice appears above them when a health threshold is crossed or runs failed. The relevance breakdown, broken links, chunks and embeddings, which the old answer dropped, are now shown, along with the health and size figures. The index's per-table row counts and vector slots stay in `brain stats --json`. Costs keep their unpriced runs visible: a partly priced sum reads as a floor (`≥ $4.10`), a wholly unpriced one reads `unknown`, and neither ever reads `$0`. `api.brainStats()` is typed with the full corpus shape (`CorpusStats`), and `api.activityStats(days?)` is new.

### Patch Changes

- Updated dependencies [f5a8f81]
- Updated dependencies [c1ac8c9]
- Updated dependencies [ba23fcc]
- Updated dependencies [cf94a81]
- Updated dependencies [e5d3cc0]
- Updated dependencies [b1805ee]
- Updated dependencies [b8c355d]
- Updated dependencies [9342cd2]
  - @schlessera/brain-ui-sdk@0.39.0
  - @schlessera/brain-ui-kit@0.39.0

## 0.38.0

### Minor Changes

- 0230c6c: The file viewer previews PDFs, audio and video inline instead of offering only a download. A PDF is drawn by pdf.js, one page per canvas down the panel, and tapping a page opens it in the zoom viewer. MP3 and WAV play in a native `<audio>` element, and MP4 and WebM in an inline `<video>`. A PDF, audio or video file the browser cannot open, or a PDF page it cannot draw, falls back to the "Preview not available" card, which any other binary still gets. The binary viewer picks its previewer from a table keyed by MIME type.

  New config field `pdfWorkerUrl`: the URL of pdf.js's worker script, `pdfjs-dist/legacy/build/pdf.worker.min.mjs`, imported by the shell (with Vite, `?url`). Without it, or when it does not start a worker of the bundled pdf.js version, PDFs are parsed on the main thread. `@schlessera/brain-ui-react` now depends on `pdfjs-dist`.

  The raw file route (`/api/files/content?raw=1`) answers a single byte range on a GET with `206 Partial Content`, and a range past the end with `416`. Every raw file response carries `Accept-Ranges: bytes`. iOS Safari plays video and audio only from a server that does this. `/api/files/content` now reports `.pdf`, `.mp3`, `.wav`, `.mp4` and `.webm` files as `binary` whatever their bytes: an uncompressed PDF is plain ASCII, and used to come back as `text`, with its source as the content.

- fe0041f: A shared answer (PNG or PDF) now draws its answer blocks, in a new print theme, where before it contained only the message's markdown. `@schlessera/brain-ui-kit` adds `PRINT_TOKENS`, `printThemeCss()` and a `[data-theme="print"]` block in its stylesheet: a white ground, no washes, and borders that carry the structure. `@schlessera/brain-ui-react` renders each `show_block` block and each classified block to static HTML in the print theme, in the order the answer shows them. A message with no block shares exactly as before.

### Patch Changes

- Updated dependencies [8c1daaa]
- Updated dependencies [aec3dd8]
- Updated dependencies [a9094fb]
- Updated dependencies [1d29fcd]
- Updated dependencies [94fd8c9]
- Updated dependencies [70a5502]
- Updated dependencies [2d985ba]
- Updated dependencies [d350daa]
- Updated dependencies [e4b5251]
- Updated dependencies [fe0041f]
- Updated dependencies [4224247]
  - @schlessera/brain-ui-sdk@0.38.0
  - @schlessera/brain-ui-kit@0.38.0

## 0.37.0

### Minor Changes

- 7fe9bc0: An approval decision records the channel it was made on. `tool_approval` and
  `tool_denial` gain an optional `channel` (`card` | `voice`), stored on the
  `approval_decision` activity event; the host refuses a voice-attributed grant
  and leaves the request pending; the web client's approval cards send `card`;
  and a resolved approval in Actions reads as the decision and its channel
  ("Denied by voice").
- 6ae12e7: A destructive-command approval card now says what the command will do.

  - Added: each default confirm pattern carries an `effect` phrase ("delete a directory and everything inside it"). A `command` approval's reason is that phrase, and both approval cards show it.
  - Changed: `DEFAULT_CONFIRM_BASH_PATTERNS` entries are `{ pattern, effect }`. `confirmBashPatterns` and `compileConfirmPatterns` accept that form or a bare regex source; a bare source keeps the old generic sentence.
  - Changed: `BRAIN_UI_CONFIRM_BASH` accepts the object form too. A non-empty list with no entry of a usable shape now means the defaults rather than "no confirmation". A list whose patterns are all invalid regexes still compiles to none (#251).

- f489482: An approval card no longer offers "Always allow" for a grant the host will not
  keep. `tool_approval_request` gains an optional `rememberable: false`, sent for
  a request outside the turn's enforced allowlist (or by a host with no grant
  store) and again when the card is re-delivered on reconnect; both approval surfaces hide the button for it, and
  the Actions receipt no longer prints "Always allowed" for a decision that was
  not remembered.

### Patch Changes

- 0cb97e3: The Actions pane's printed keys — the "j / k move · d dismiss" footers and the
  "Dismiss · d" hint on each inbox card — now appear only while the device has a
  fine pointer, like the rest of the printed shortcuts. The keys still work in
  both states.
- ab3e1ff: No behaviour change. The `useFinePointer()` doc comment now says a tablet with
  a keyboard but no trackpad prints none of the pointer-gated shortcut hints by decision, and points at
  the D36 addendum in `docs/decisions/design-kit.md` that records why.
- da1c504: Doc comments now cite `docs/decisions/` instead of the removed `.plan/` tree. No
  runtime change.
- 9ffdd23: The printed keyboard shortcuts — the rail's `⌘1`–`⌘5`, the `a` / `d` caps on
  approval buttons, and the "↑ ↓ to pick, ↵ to open" and "Ctrl/Cmd + ↵ to save"
  hints — now appear only while the device has a fine pointer, so a tablet in
  landscape no longer reads five shortcuts it cannot fire. Pairing a fine pointer brings them back live. A keyboard alone does not
  necessarily change the pointer signal. The bindings themselves are unchanged: every
  key still works in both states, and the single-key shortcuts switch in
  Settings stays independent of the pointer.
- 552ad8f: A stray click on the backdrop no longer cancels `brain sync`. `SlidePanel`
  takes a `closedBy` prop in `<dialog closedby>`'s vocabulary — `any` (the
  default, light dismiss), `closerequest` (Escape only) or `none` — and the
  header's X closes the drawer under every value. The sync panel is `none`
  while the job runs and `closerequest` once it has finished, so the log stays
  until it is dismissed deliberately; Settings is `none` while a credential is
  being minted or is still unacknowledged, and its close control now works
  there instead of silently doing nothing. The drawer's X also has an
  accessible name (`Close <title>`).
- 002c0cc: The sync and briefing panels no longer spin forever on a stream that ends
  without a `done` frame. `POST /api/brain/whatsup` now ends on a failed `done`
  frame carrying the error when anything throws before its last send, such as a
  spawn that cannot start (`POST /api/brain/sync` already did). On the client,
  `StreamingPanel` and `WhatsupPanel` treat a stream that closes without `done`
  as failed: they keep the output that arrived, say the connection closed before
  the job reported a result, and offer Close instead of Cancel.
- b953693: A stray click on the backdrop no longer cancels the briefing `/whatsup` is
  loading, nor discards the one it has just produced. The briefing drawer now
  carries the same `closedBy` prop as the sync panel — `none` while the briefing
  loads, so neither the backdrop nor a reflexive Escape can abort a model call
  mid-flight, and `closerequest` once it has arrived, failed or been cancelled,
  so Escape dismisses it but a click beside the drawer does not. The header's X
  closes it in every state, and the footer's Cancel still aborts the request.
- Updated dependencies [7fe9bc0]
- Updated dependencies [907e8bc]
- Updated dependencies [e77ab6f]
- Updated dependencies [206a2a9]
- Updated dependencies [6ae12e7]
- Updated dependencies [d9d4061]
- Updated dependencies [4ed02fb]
- Updated dependencies [7b6b2b0]
- Updated dependencies [ecc93b9]
- Updated dependencies [da1c504]
- Updated dependencies [d33492e]
- Updated dependencies [54eea05]
- Updated dependencies [97837c1]
- Updated dependencies [1de4d6c]
- Updated dependencies [fa09aaa]
- Updated dependencies [3015302]
- Updated dependencies [08d4ed2]
- Updated dependencies [4d409c0]
- Updated dependencies [146d5a9]
- Updated dependencies [92a599d]
- Updated dependencies [09d9f4e]
- Updated dependencies [f489482]
- Updated dependencies [f7b46d3]
- Updated dependencies [1bf00b8]
  - @schlessera/brain-ui-sdk@0.37.0
  - @schlessera/brain-ui-kit@0.37.0

## 0.36.0

### Minor Changes

- da15281: `ask_user` is an exchange, and a mask is a receipt (D38 §1, §2).

  The hand-drawn ask-user card with its collapsed summary row retires for the
  kit `AskUserCard`, one per question, in the three states the design ruled:
  `pending` (options, one focus stop; "Other" opens the kit's field in place of
  the Submit row), `answered` (the chosen answer with when — the alternatives
  are gone, not dimmed, because they were never the record) and `typed`. All
  three stay in the transcript at full contrast; nothing rolls up. A dismissed
  question keeps its card with no options and a neutral note.

  `typed` is new behaviour: a composer send while a single-question exchange is
  pending is the ANSWER to it. The text goes out as `ask_user_response` and the
  card quotes what it took under a neutral border — nothing is sent as a chat
  message. A multi-question prompt keeps its cards' own Submit (the server
  resolves the whole request on the first response, so binding a typed reply to
  one question would strand the rest). Option previews follow focus, as the
  contract says, in both single- and multi-select questions. The exchange records `typed` and
  `answeredAt`; both are live-only, because the persisted tool output carries
  neither, so a resumed transcript shows a typed answer as a plain answered one
  with no time rather than one it made up.

  `request_image_mask` renders through its contract like the location card: a
  hatched source thumb (no remote image inline) above a kit `Receipt` with the
  rows its payload actually carries — source and mask — and a red mono
  `Callout` stating a declined mask from the result's own words. The design
  also draws a region and a coverage figure; the payload has neither yet, and
  the card invents neither.

- e738d3e: In-chat tool results render from their contract, on every backend.

  `bind(contract, Component)` types a component as the contract's payload and
  parses the tool's `output` through the same schema before rendering it. Drift
  is a `tsc` error — binding a component the payload does not fit, or reading a
  field the tool stopped sending, both fail the typecheck — and a result that
  does not parse falls back to its raw output rather than blanking the row, which
  is what a denial, a timeout or an older server actually produces.

  The first binding is `get_current_location`, which also closes a real gap: it
  had a renderer only under Claude's `mcp__brain-ui__` name, so the identical
  tool on the pi backend rendered as raw JSON and a resumed transcript carrying
  the pre-rename prefix did too. A bound contract registers every spelling of its
  name, globally, because the tool is the chat UI's own rather than any one
  backend's.

  `isLocationTool` is gone with it — it was never called, and it could only ever
  recognise one of the three names.

- babc668: Classified blocks render in place (D42). `MarkdownContent` takes the
  `message_blocks` a host sends after a turn, cuts the text part at each
  block's span, and draws the kit block between the markdown pieces through
  the same `BlockCard` that renders `show_block`. History carries the blocks
  on replay. A message without blocks renders exactly as before; a span that
  does not fit the text is ignored rather than rendered blank.

  A `message_blocks` frame is targeted by the turn it belongs to, since a
  queued follow-up may have opened a newer assistant message by the time the
  pass returns, and it never reopens a finished session's running badge.

  The first scoped delta stamps the host's turn id onto the assistant
  message the composer opened optimistically, so the turn-targeted frame
  finds it; a frame whose turn no message carries lands on the last
  finished assistant message, never a streaming one.

- 6b57843: Add independent UI configuration and REST client factories with per-request URL resolution for isolated UI roots.
- 6b57843: Add UI roots and a React provider with independent stores, persistence, request
  caches, renderer/ASR registries and WebSocket lifetimes. Store hooks select from
  the nearest provider; connection handlers close over that same root. Multiple
  consumers share one socket within a root, and disposing it releases its resources.

  Add an ASR registry factory to the SDK. The default application entry points
  remain available. Component API/config migration is still in progress, so this
  does not yet make the entire application safe for separate backends in one page.

- 7e829a8: A `show_block` result renders as the kit block it names, inline in the answer.

  `BlockCard` is one switch typed by the contract's payload, handing each
  variant to its kit component — `ComparisonTable`, `StatTiles`, `TrendChart`,
  `DataTable`, `BarList`, `Receipt`, `StepList`, `TimelineList`,
  `ScheduleList`, `QuoteCard`, `ContactCard` — so a schema field the kit does
  not accept is a `tsc` error, and a type-level test holds the schema's tone
  lists equal to the kit's unions. The transcript draws a parsed block at the
  call's chronological position, the way an `ask_user` exchange is drawn, rather
  than inside the tool timeline; a call whose result does not parse (a rejected
  argument, an older server) stays in the timeline, where the bound fallback
  shows the result's own words. The collapsed summary reads the shape:
  `comparison · 3 columns · 4 rows`. Icon keys the kit does not know are
  dropped before they reach the kit, which would otherwise draw an empty box.

  Omitted optional text fields are handed to the kit as empty strings: the kit
  ports the design's demo defaults, so a quote with no source would otherwise
  cite the fixture world's forecast and a contact with no label would be
  Penelope. Icon keys are checked as own properties, so `constructor` is not
  an icon.

- b1e7640: The app shell follows the light theme (D39).

  `theme.css` declared every utility colour as a literal dark hex, so under
  `data-theme="light"` the kit's cards turned to paper while the page, the rail
  and every `bg-surface` / `text-foreground` element around them stayed dark.
  Every `--color-*` is now the kit's own `--bk-*` token, declared `@theme
inline` so the utility carries the token and it resolves where it is used;
  the prose blocks and the filament use the tokens by name too. The app types
  no colour of its own, in either theme.

  Ink and fill are named apart, as the kit names them: `primary`, `accent` and
  `destructive` are the inks (text, borders, rings) and `primary-fill`,
  `accent-fill`, `destructive-fill` are the fills (backgrounds, solid or with an
  alpha), with `primary-foreground` the ink that sits on a fill, and `primary-mark`, `accent-mark`, `destructive-mark` for a dot of six to eight pixels, where a fill falls under 3:1 on paper. A consumer that
  used `bg-primary` on its own elements should move to `bg-primary-fill`; the
  ink name still exists and is now a dark amber on paper.

  The four component files that used Tailwind's palette (`text-amber-100`,
  `bg-amber-950/90`, the diff's red and emerald) use token utilities instead.
  `tests/theme-neutral.test.ts` holds the package to this: no hex or rgb
  literal in `theme.css`, no palette class in `src/`, and a hex in source only
  in the files that draw on a canvas, each with a written reason.

- 84f26d1: The graph canvas and mermaid diagrams follow the theme, from the kit's canvas
  palette (seventh drop, rulings 1, 3 and 4).

  A real regression first. `useGraphTheme` read the kit's tokens with
  `getComputedStyle` and handed the strings to sigma; since the kit's light
  theme every token is a `light-dark(<paper>, <dark>)` expression, which a
  custom property returns verbatim and a canvas `fillStyle` silently rejects.
  Checked in a browser, the dark theme's node labels were drawing in the canvas
  default black on the dark ground, with a black outline — unreadable — and the
  paper theme's labels were black by the same accident. `lib/light-dark.ts` now
  splits the expression on the scheme in force; `useColorScheme` follows the
  store's preference and, under `system`, the OS, so the hook re-resolves on a
  switch and the canvas re-applies the label ink, the label drawers and every
  node and edge colour in place. Labels always take the ink, never a node's
  colour.

  The palettes are the kit's `--bk-canvas-*` tokens, read for the theme:
  `communityColor`, `distanceColor` and `assignFolderColors` take the resolved
  palette from `useGraphTheme().palette` rather than module constants, the
  maintenance lenses come from the same place, and the legends and the node
  card read the same values as the canvas. On paper the nodes wear the
  design's paper set at 3:1 against the canvas; slot order is unchanged.
  `mermaidThemeVariables` builds both themes from the kit's diagram surfaces,
  the slot series and the accent inks, so a diagram in the transcript is drawn
  for the scheme the page is in (re-rendered on a switch, cached per scheme)
  and a shared export takes the paper surfaces. A bar that carries near-black
  text — an active, done or critical task — is a fill, never an ink.
  Three source files that used to carry hex literals carry none now, and the
  theme gate's allowlist is down to the two files whose colours are not the
  theme's.

  Prose tints follow the kit's rule: a ground takes the fill hue (the table
  row's hover, the blockquote's ground, a file link's hover ground) and a line
  takes the ink hue (a link's underline at rest and hovered, the file link's
  dotted underline). And a bare mark takes the mark value at every size: the
  timeline's status dot, the dictation sheet's live dot, its pulse ring and its
  level bars move from `bg-*-fill` to `bg-*-mark`, because an accent fill sits
  under 3:1 on paper at any diameter. Buttons and badges that put
  `text-primary-foreground` content on a fill are unchanged.

- 4d28f20: The desktop, on the design's ladder: the phone bar to 479px, the rail
  collapsed from 480 and expanded from 900, a fourth pane from 1440. From
  `laptop:` up Settings is a pane with a 216px section column and a 720px
  measure; Files is tree · reading · frontmatter rail; Actions is list ·
  detail · trace rail; Graph is controls column · canvas · node rail with the
  selected node as a `ContactCard`. Below `laptop:` every screen keeps its
  phone shape.
- 004935e: The desktop rail is the kit's `SideRail`: five destinations (Chat, Activity
  with the inbox count, Files, Graph, Settings) reachable by ⌘1–⌘5 or Ctrl,
  collapsed to the 60px icon rail below 900px and expanded above, with the
  socket state on the wordmark's line. The actions the old rail carried — New
  chat, Sessions, Sync, the daily briefing, Search, Add a note, Statistics —
  move to a ⌘K palette on the kit's `CommandPalette`, which filters as you
  type, runs the selected row on ⏎ and closes on esc; Sync shows its effect
  chip, and the commands that need the socket are left out while it is down.

  `theme.css` now imports the kit's `tokens.css` itself, so a Tailwind consumer
  that imports only `theme.css` gets the `--bk-*` values the kit components
  read; before, such a consumer rendered every kit surface colourless.

- 4f36ba3: Five destinations everywhere (D37): Chat · Actions · Files · Graph · Settings
  on the rail and the phone bar, with Settings folded into More — a kit
  `BottomSheet` holding Settings and the acts (Sessions, Sync, Daily briefing,
  Brain statistics). Activity becomes Actions: one queue with three lenses
  (`needs you` — pending approvals from every transcript, then the inbox;
  `running`; `done`), and a drained section becomes the empty state whose
  heading takes focus, with the receipt above it. New chat is the Chat header's
  action and a palette row. The ⌘K palette groups by what ⏎ does (Jump to ·
  Ask · Run), prints a cost chip on the briefing, shows unservable commands
  disabled with their reason, and types into a real input. The composer is the
  kit `Composer`: capture is a menu behind the paperclip, the provider chip
  sits in the hint line, and the connection state drives placeholder, hint and
  send/stop together. The location card passes accuracy and note through to
  the kit map. Settings › Input carries the single-key switch as the design
  draws it.
- 427b735: First step of the app onto the design kit: `@schlessera/brain-ui-kit` is a
  dependency, its `tokens.css` is part of the app stylesheet, and the phone's
  bottom navigation is the kit's `TabBar` (roving tab stop, amber active slot,
  red inbox badge; the More menu stays app-owned). Settings gains a three-way
  theme toggle (system / paper / dark), persisted per root and written to
  `<html data-theme>` by `AppShell`.
- d257ee1: The `get_current_location` result is a map. The card renders the kit's
  `MapView` with the fix as its pin, widens the view when the accuracy is
  coarse, and fetches the shoreline and roads around the fix from the server's
  `/geo/coastline` route, credited to OpenStreetMap when geometry is drawn. With
  no server, an older server or an outage the map keeps its pin, graticule and
  scale bar. The API client gains `geoCoastline(bbox, { width, signal })`, and
  the kit exports the `MapLand` type beside `MapPath` and `MapPin`.
- aaedb6a: The six fetch-on-mount components are split into a container that owns the
  request and its cancellation, and a view rendered from props on kit
  primitives: `PushToggle` renders `PushSwitch`, `LoginScreen` renders
  `LoginForm`, `WebSearchSection` renders `WebSearchChain`, `PasskeyTab` renders
  `PasskeyList`, `SkillsTab` renders `SkillsList` and `SkillEditor`, `AddPanel`
  renders `AddForm`, and the sync and briefing panels render `StreamingOutput`
  and `BriefingOutput`. Switches are the kit's `Toggle`; buttons are the kit's
  `Button`; loading and empty states are the kit's `Placeholder`. The muted
  foreground colour follows the kit's floor to `#9a96a1`.
- 84f26d1: The chat surfaces follow the design's seventh drop.

  - Multi-select `ask_user` questions render on the kit `AskUserCard` with `multi`: checkbox options in a labelled group, "Other" toggling like any row and opening the free-text field while it is on, previews following focus as before. The app's own checkbox rows are gone. An answered multi-select lists every pick and counts them in the head; a typed "Other" answer joins the other picks instead of replacing them.
  - A dismissed question is the kit's gold `dismissed` state rather than a pending head with a note, and it offers "Ask again". The server resolved the request when the turn ended, so asking again reopens the card locally; a submit from a reopened card goes out as an ordinary composer message that quotes the question and the chosen answer(s), and its Dismiss closes it again without sending anything.
  - The `request_image_mask` receipt states an absent region instead of omitting the row: `region · region not recorded`, in gold. When the result reports mask bytes, the mask file is drawn over the hatched thumb from the files API, with the teal region fill showing through its transparent pixels; when it reports none, the thumb shows the source alone under a mono "mask not rendered" line.
  - The Edit tool's diff renders through the kit `DiffBlock` in its tinted mode. The app's word-level highlight inside a changed line pair had no equivalent in the design — the sign column and the row grounds are its whole vocabulary — so it was dropped, and `lib/diff.ts` is a line diff plus `diffText`, the signed text the kit reads.
  - The Actions page's approval card applies the same button rule as the kit card: Allow takes the remaining width, Deny is content-sized with a 96 x 44 floor. Its title already wraps.

- d94ddf9: Single-key shortcuts, focus-scoped. `a` and `d` decide the in-chat approval
  card that holds focus and are printed on its Allow and Deny buttons; `j` and
  `k` move between the Activity inbox's cards and `d` dismisses the focused
  one, printed in the list's footer. A decision hands focus to the next card,
  else the previous, else the composer or the page heading. Settings gains an
  off switch for the letters (WCAG 2.1.4), persisted per root; ⌘K and ⌘1–⌘5
  are not governed by it.
- 6b212a7: The sixth drop's pane rulings (D38 §3, §4, §7, §8).

  The Files evidence rail never collapses: with a file open the column stays
  mounted and each block is drawn only when its data exists. A Modified block
  is built from the file's own `mtime` against a 30-day threshold (the design
  gives no number; the constant is named) and turns gold past it, and the tree
  marks a stale file the same way. "Untrusted only" is drawn disabled with its
  reason — provenance does not exist yet — never omitted. The tree binds `←` /
  `→` to fold through the kit `FileRow`'s new `onFold`, and the footer prints
  `← → fold · ⏎ open` regardless of the single-key switch, since arrows are not
  single keys.

  Dismissing inbox items is silent: no receipt without undo. Approval decisions
  keep theirs, because their effect happens in the run, out of sight.

  The graph's colouring modes gain `entity` (person · company · project, the
  kit's own entity tones) beside topic, distance and folder; the caption and
  the legend follow the active rule.

### Patch Changes

- b9e2390: The map's fetch envelope is 1.5 spans across by 1.0 down (D38 §9), replacing
  the square 2.4-span bleed of which only 23% could ever be drawn. The kit's
  fixture generator and the app's live location card share the rule; all six
  geo fixtures were regenerated and the set stays under its size guard.
- 5405fce: Bind activity lists, run details, digests, device management and remembered tool
  grants to their UI root. Ignore responses from previous roots and superseded
  activity refreshes, clear old detail metadata, and preserve delayed one-time
  credentials in the root that issued them.
- 632f439: Bind login and passkey management to their UI instance's API and configuration.
  Ignore stale login and credential-management responses after switching instances,
  and prevent superseded passkey ceremonies from submitting verification results.
- 77c35a6: Bind media, sharing, branding and remaining session/graph requests to the UI root, and discard stale completion state.
- 886273f: Bind model settings and pi account flows to their UI root. Preserve queued model
  write ordering across root switches, reject stale catalog and login responses,
  and stop cancelled or inactive login polls from replacing a newer flow.
- 20ee5c9: Bind push controls and post-login subscription registration to their UI instance.
  Ignore stale browser and server responses, reset connection-gate probe/retry
  state on instance changes, and require an explicit Enable click before replacing
  a browser subscription bound to a different server key.
- 6f86c62: Bind search, capture, sync and briefing requests to their UI root. Switching
  roots clears stale results and capture completions; cancelling or replacing a
  stream closes its reader without allowing old responses to overwrite the new
  panel or disable its Cancel button.
- 67e37c5: Bind skill management and web-search settings to their UI root. Clear drafts
  when switching roots and ignore late loads, saves, installs and failures so
  another root's editor, API-key draft and pending state remain intact.
- 6230c26: The Settings pane's Close button is inside the viewport again: the kit
  `ScreenHeader` is `width: 100%`, so it needs a shrinking flex child around it
  in the header row, as the Files pane already had. A closed drawer no longer
  casts its 48px shadow into the viewport from just past the right edge: the
  shadow fades with the slide-out, and a closed drawer takes no pointer events.
- Updated dependencies [9827a47]
- Updated dependencies [bbc90ab]
- Updated dependencies [6b57843]
- Updated dependencies [b3a3ffd]
- Updated dependencies [b9e2390]
- Updated dependencies [2c9e5d3]
- Updated dependencies [edb547b]
- Updated dependencies [f5512f7]
- Updated dependencies [9e5469c]
- Updated dependencies [43d7014]
- Updated dependencies [1d67cf1]
- Updated dependencies [9d5c255]
- Updated dependencies [7e829a8]
- Updated dependencies [79dd9cb]
- Updated dependencies [84af26d]
- Updated dependencies [2a58a6f]
- Updated dependencies [bc3a26d]
- Updated dependencies [b5a64a1]
- Updated dependencies [c516e43]
- Updated dependencies [2a58a6f]
- Updated dependencies [c659605]
- Updated dependencies [86a79f2]
- Updated dependencies [2a58a6f]
- Updated dependencies [1d67cf1]
- Updated dependencies [192f004]
- Updated dependencies [d8e3103]
- Updated dependencies [e878d87]
- Updated dependencies [2a58a6f]
- Updated dependencies [d257ee1]
  - @schlessera/brain-ui-sdk@0.36.0
  - @schlessera/brain-ui-kit@0.36.0

## 0.35.0

### Minor Changes

- 23a99d0: Bind push subscriptions to the authenticated principal and stop future delivery after revocation or expiry. Legacy subscriptions are inert until the client re-registers them after login; notifications already delivered to a device cannot be recalled.
- dd12f91: Add Devices & agents settings to list and revoke active access, mint expiring agent credentials, and preserve their one-time values across navigation until explicitly saved.

### Patch Changes

- 3aec83f: Prevent stale search results from opening and cancel superseded requests before debounce.
- 545f2f9: Preserve exact sync paths, prevent overlapping UI sync jobs, keep cron outcomes tied to child exit, and discard stale file-viewer responses.
- 1ddc4bb: Protect export destinations and share cleanup paths, replay missed failure notifications after restart, and keep session histories usable when a backend is unavailable.
- 714f45e: Serialize session startup, preserve draft correlation, expose capture indexing recovery, and deduplicate cyclic wikilink scans and concurrent refreshes.
- Updated dependencies [f89897b]
  - @schlessera/brain-ui-sdk@0.35.0

## 0.34.1

### Patch Changes

- 4ddfc80: Keep run detail from showing the wrong run or applying late updates after leaving Activity, prevent stale Graph scene loads, and cancel wasted scene and note-search requests after leaving their views.
- 9f2e4ae: Split the WebSocket dispatcher, activity stores, and large React surfaces into focused internal modules without changing behavior.
- aade466: Show when the server refuses the live connection, including a specific connection-limit message and a retry action, instead of leaving the composer on “Connecting...” forever.
- Updated dependencies [aade466]
  - @schlessera/brain-ui-sdk@0.34.1

## 0.34.0

### Patch Changes

- 69ce4f5: Add mounted lifecycle regression coverage for the activity and graph pages.
- Updated dependencies [4adb327]
- Updated dependencies [17706aa]
- Updated dependencies [c6d9a30]
- Updated dependencies [a41e81a]
  - @schlessera/brain-ui-sdk@0.34.0

## 0.33.1

### Patch Changes

- Updated dependencies [5b7fb32]
  - @schlessera/brain-ui-sdk@0.33.1

## 0.33.0

### Minor Changes

- 07d63eb: Add the injected service-worker policy and shared hash-routing and update-safe reload hooks.

### Patch Changes

- 396f2e6: Register built-in tool renderers and ASR clients synchronously on first render.
- 5274cd0: Prove the published package imports and typechecks with React 18 and its matching type packages.
- Updated dependencies [95a180c]
- Updated dependencies [07d63eb]
  - @schlessera/brain-ui-sdk@0.33.0

## 0.32.0

### Minor Changes

- f98026c: Password session cookies carry a strict server-side epoch. Signing out or revoking a passkey globally invalidates every outstanding cookie and closes every open WebSocket; callers without a current valid session cannot trigger invalidation. The Security panel now labels the action “Sign out everywhere.”

### Patch Changes

- Updated dependencies [ec340d2]
  - @schlessera/brain-ui-sdk@0.32.0

## 0.31.0

### Minor Changes

- 692f1a4: Chat surface performance: typing and streaming no longer scale with the length of the conversation.

  Typing a character re-rendered every message in the transcript, and each one rebuilt its markdown from scratch — react-markdown constructs a new unified processor per render. Streaming had the same shape, once per token. Both costs grew linearly with the conversation.

  - The composer is its own component, so a keystroke never reaches the message list. The command palette is derived during render rather than through an effect, and the textarea grows by CSS instead of reading `scrollHeight` (a forced document layout on every keystroke).
  - `MessageBubble` and the markdown renderer are memoized, and the remark/rehype plugin lists are module constants.
  - Streamed text and thinking deltas are coalesced into one store write per animation frame. Ordering is preserved on both sides: a kind change starts a new chunk, and any non-delta frame flushes the queue before it is handled.
  - Closed panels render nothing, and the file panel no longer keeps the file tree mounted behind the chat page.
  - Offscreen message bodies get `content-visibility: auto`.
  - The transcript renders a window of 40 messages with a "show earlier" control that preserves scroll position.
  - Syntax highlighting, the graph and activity surfaces, the settings tabs and the file panel load on first use. `GraphPage` and `ActivityPage` carry their own Suspense boundary, so consumers need no change.

  Measured per keystroke at 100 messages: 118.69 ms of React commit time down to 0.15 ms. Per streamed delta at 100 messages: 107.90 ms down to 0.84 ms. Mounting a 400-message transcript: 510 ms down to 65 ms. Entry bundle: 344 KB gzipped down to 265 KB.

### Patch Changes

- @schlessera/brain-ui-sdk@0.31.0

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

## 0.27.0

### Patch Changes

- Updated dependencies [afbe784]
  - @schlessera/brain-ui-sdk@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [8b41fc3]
  - @schlessera/brain-ui-sdk@0.26.0

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

### Patch Changes

- Updated dependencies [d4261bb]
  - @schlessera/brain-ui-sdk@0.22.0

## 0.21.0

### Minor Changes

- e3a9e60: Activity: name subscription-billed spend, and make the run detail a full view.

  - **`subbed`, not `free`** (span-bits): a $0 effective cost now reads
    `subbed` when the run was subscription-billed and `free` only when the
    rate itself is zero (an OpenRouter free tier, say). Both are $0 additive,
    but only one of them stays $0 once the seat plan lapses, so the run rows
    and the run-detail cost bar say which one it is.
  - **Run detail shows what was recorded** (activity-page): every span
    expands, not only tool spans — a cron or turn root used to be a status
    dot and a duration, which was strictly less than the trace it summarized.
    Expanding a span now shows its model and token usage, its list cost, its
    attributes, its recorded events, and (for tool spans) the input/output
    payload as before. The header carries origin, outcome, start, duration
    and the run's token totals; a failure reason renders in full.
  - **No event type renders nowhere**: `narrativeEventsFor` picks up
    everything the tool-payload expander filters out — transcript excerpts,
    the cron wrapper's `job_output`, and any type a span-sink producer
    invents — and `eventTypeLabel` names it instead of mislabelling it as
    "Output".
  - **Raw trace escape hatch**: the run detail can dump its spans, events and
    rollup as JSON, so the rendered view is never less than the record.

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

### Patch Changes

- Updated dependencies [a29b287]
  - @schlessera/brain-ui-sdk@0.18.0

## 0.17.0

### Patch Changes

- 571a74a: Open the graph view in Clusters instead of Local.

  Local mode is centred on a single node and has no center until the user picks
  one, so opening the graph landed on an empty canvas with a picker — which reads
  as "the graph is broken", not as "choose a starting point". Clusters answers
  the question someone opening a graph view is actually asking: what is in here,
  and what clumps together.

  Local is still one click away, and clicking any node switches to it — that is
  the natural way in, rather than the landing state.

  One consequence worth knowing: Local is exempt from the "needs precomputed
  graph tables" gate, so a repo whose graph has never been computed now lands on
  the "Graph not built yet" panel rather than an empty Local canvas. That is the
  more honest of the two — it names the problem and gives the command to fix it.

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

## 0.15.0

### Minor Changes

- 42789e1: Take backend URL and dev-tools configuration through `configureBrainUi()`
  instead of reading `import.meta.env`.

  `ui-server` already resolves its configuration once at the edge and never
  touches the ambient environment below that point; this is the browser-side
  mirror. The package read `VITE_BACKEND_URL` and `DEV` at module load, which
  pinned it to Vite — a webpack or Next.js consumer had no way to reach a
  split-topology backend at all, and no way to discover that from the types.
  `scripts/check-env-access.ts` gained a fourth rule refusing `import.meta.env`
  anywhere in a package's `src`, so the loophole cannot reopen.

  **Breaking for direct importers:** the `API_BASE` constant is now the
  `apiBase()` function. A constant would freeze the value at import time, and ES
  imports are hoisted, so it would always capture the default rather than what
  the shell configured. `configureBrainUi` gains `backendUrl` (empty = the
  same-origin default) and `devTools`; both are optional.

### Patch Changes

- @schlessera/brain-ui-sdk@0.15.0

## 0.14.0

### Patch Changes

- @schlessera/brain-ui-sdk@0.14.0

## 0.13.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.13.1

## 0.13.0

### Minor Changes

- c79e632: Zoom images the way diagrams zoom, and stop treating quality as a problem

  An inline image is only as wide as the viewport, so a generated one was visible
  but not legible — the same complaint mermaid diagrams had before they got a
  viewer. Images now get that viewer, and the pan/zoom surface behind it is shared
  rather than copied.

  - **`ZoomViewer`** (`components/viewer/`) is the extracted stage: pointer pan,
    pinch and wheel zoom, fit/zoom/close toolbar, Escape, body-scroll lock,
    re-fit-while-untouched. `MermaidViewer` is now a thin wrapper over it and
    behaves exactly as before (diagrams still fit up to 250%; images cap fit at
    100%, since past that a raster shows only interpolation).
  - **Tapping an image opens it** — in chat markdown, in the file viewer's binary
    preview, and on a user message's attachment thumbnails (those are
    object-cover crops, so the full frame was not even visible before).
  - **Sharing an image is now two explicit actions.** "Share original" ships the
    bytes untouched; "Share optimized" re-encodes toward 2048px / 1 MiB for
    messaging, and falls back to the original when the image is already inside
    that target rather than recompressing for show. Nothing is downgraded
    silently, and the file on disk is never touched.
  - The `generate-pdf` skill's size guidance already said the 10 MB server cap is
    the only real ceiling; this makes the UI live up to it, because a
    full-resolution image is what makes zooming worth anything.

- 2be49b8: Pick up a system share and file it, behind one confirmation

  Third phase of the Android share target: the app now claims what the service
  worker stashed, shows it, and — once the user taps "Add to brain" — uploads it
  to the staging directory and starts a chat session whose first turn reads,
  stores and processes it. The user watches the tool timeline and keeps talking in
  the same session.

  **The confirmation is the security boundary, not a nicety.** The share target is
  reachable by any website: a page that auto-submits a cross-site form to it is
  indistinguishable from the system share sheet. Acting on a share automatically
  would let a drive-by write into the knowledge base, spend subscription credit,
  and put attacker-authored text in front of a model with tool access. So nothing
  is uploaded and no turn starts until the arriving share has been shown — title,
  url, text, thumbnails — and confirmed. A real share pays one tap.

  Shares queue and run one at a time. That is also a correctness requirement, not
  just pacing: the client holds a single unbound chat draft, so two turns started
  before the first `session_info` arrives would land in the same buffer and the
  second session's transcript would be dropped for the rest of the connection.

  `?share=<id>` is moved into a localStorage claim and stripped from the URL
  immediately, so the intake survives a login round-trip, a manual reload, and the
  shell's own service-worker auto-reload — a reload preserves the query string,
  and a second pass over the same id while the first upload was in flight would
  file the share twice. `ShareStore.take()` makes the claim atomic underneath
  that. Orphans are recovered from the stash by listing it, because a share whose
  landing page never ran leaves a record nobody holds the id for.

  `sendClientMessage()` is now exported from `use-websocket`: `useWebSocket()`
  owns the socket through a per-instance guard, so a second caller would build a
  second client and orphan the first. Anything that needs to send but not to own
  goes through the module-level sender, which reports failure instead of dropping
  silently.

  `hasPendingShare()` is exported for the deployment shell's reload guard —
  reloading mid-intake is exactly what the claim above protects against.

  The upload does not go through `api-client`: `fetchJson` hardcodes a JSON
  content type, which would break the multipart boundary, and flattens errors to a
  message, discarding the `limit` a 413 carries — the only thing that lets the
  card say which cap was hit.

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

### Patch Changes

- a4eb4d0: Spell control and invisible characters as escapes so grep can see the source

  `chunkContextKey` embedded raw NUL bytes as hash field separators, which makes
  grep and ripgrep classify `indexer.ts` as binary — the file silently dropped out
  of every search. `brain-markdown.tsx` had the milder version: its entity
  delimiters were runs of one, two and three literal zero-width spaces, unreadable
  in a diff and destroyable by any editor that trims whitespace.

  Both now use escape sequences. The runtime strings are byte-identical, so
  existing `.context-cache.jsonl` keys still match and no LLM-generated context is
  regenerated.

  `bun run lint` (`scripts/check-invisibles.ts`) refuses raw control and invisible
  characters in tracked files and runs in CI as the invisible-character gate.

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

- Updated dependencies [2be49b8]
- Updated dependencies [2be49b8]
  - @schlessera/brain-ui-sdk@0.13.0

## 0.12.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.12.1

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

## 0.7.2

### Patch Changes

- Graph view: suppress node hover while a camera gesture (drag pan, pinch zoom/rotate) is in progress, so dragging no longer flickers random nodes in and out of the hover fade.
  - @schlessera/brain-ui-sdk@0.7.2

## 0.7.1

### Patch Changes

- 411bbbc: Graph view UX polish: theme-dark hover label plate (readable light-on-dark
  text), half-strength fade of non-matching nodes during search highlight,
  thin background-color outlines on canvas labels for overlapping text, and
  the node popover's community label rendered as an explicit "Topic:" chip.
  - @schlessera/brain-ui-sdk@0.7.1

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

## 0.6.3

### Patch Changes

- Fix Deepgram voice input: present the minted token as `bearer`, not `token`

  The server mints a short-lived `/v1/auth/grant` access token, but the client
  still offered it with the raw-API-key subprotocol scheme
  (`["token", …]`). Deepgram rejects that handshake outright — no 101, close code
  1002 — so the mic sheet opened, the recorder started, and the sheet closed again
  a moment later with no transcript. Voice has been broken this way since the
  grant-only change removed the master-key fallback: that change swapped the
  credential type without swapping the scheme word.

  - @schlessera/brain-ui-sdk@0.6.3

## 0.6.2

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.2

## 0.6.1

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.1

## 0.6.0

### Minor Changes

- The Search and Add quick actions do something now. Both were stubs that cleared
  the composer and focused it, so the "Search..." card on the new-conversation
  screen (and `/search`, `/add` in the command palette) looked like a no-op that
  dropped you into an empty chat.

  - **Search** opens a panel that queries `brain search` as you type (debounced,
    superseded requests aborted), highlights the matched terms, strips the
    markdown noise out of snippets, and opens the hit in the file viewer. Arrow
    keys pick, Enter opens. Degraded-mode warnings from the CLI are shown.
  - **Add** opens a form — note, optional title, type (completed from the types
    already in the brain) and tags — and posts it to `brain add`.

  Both talk to the brain CLI over REST rather than to the agent, so they stay
  available while a turn is streaming or the socket is down.

### Patch Changes

- @schlessera/brain-ui-sdk@0.6.0

## 0.5.1

### Patch Changes

- - Fixed: hiding or unhiding a model in Settings → Models now updates the
    composer's model picker immediately, instead of only after a page reload.
  - Fixed: a session pinned to a hidden model showed "Default model" in the
    picker; it shows the pinned model's id.
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

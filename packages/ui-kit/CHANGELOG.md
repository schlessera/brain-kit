# @schlessera/brain-ui-kit

## 0.43.0

### Patch Changes

- @schlessera/brain-render-template@0.43.0

## 0.42.1

### Patch Changes

- @schlessera/brain-render-template@0.42.1

## 0.42.0

### Minor Changes

- 857ab01: Enforce per-turn tool-call, wall-time, observed changed-path and write caps through the existing worker lifecycle and shared journal observations. Interactive turns freeze for a finite, once-per-dimension Continue or Stop decision; the free-space floor and true voice remain Stop-only. Retain scoped decisions, interruption/recovery receipts and truthful observation coverage in the existing turn disclosure and expose actual limits in This chat. Independent host deadlines and resource/storage limits remain binding.
- f5433b3: Add validated hosted policy proposals with explicit exact-base approval, retained same-request receipts and read-only policy settings. Voice and autonomous tools and worker policy-write restrictions remain unchanged.
- 52cbd1d: Add authenticated per-chat governed or strict preferences in the model picker's This chat section. Successful saves affect the next interactive turn, preserve the policy lower bound, and bind first-turn choices through the existing draft identity. Show voice facts read-only and unavailable limits as unknown.

### Patch Changes

- @schlessera/brain-render-template@0.42.0

## 0.41.0

### Minor Changes

- 45326b1: Show follow-ups that are still waiting for the agent, and keep them through a reload. A message sent while a session is busy no longer appears in the chat until the agent takes it: it waits as a `pending` pill in the right half of the row above the composer, and its full text opens on hover, keyboard focus or a tap. Three or more show the oldest pill and a `+N pending` summary that opens a read-only `Pending follow-ups` sheet. When the agent takes one, its pill goes and the message appears in the chat once, where it entered the conversation; a dropped one leaves with its reason. The host reports each session's queue in a new `session_queue` frame (`server_hello.capabilities.followUpQueue`, sent only to clients that declare the same flag in `client_hello`) after a reconnect, after `session_resume` and on every change, so a reloaded or second client rebuilds the same stack. The kit adds `PendingFollowUps` and `followUpLabel`, and `ListRow` gains `describedBy` for pills.
- 07f5a26: Record on the device without a server voice session. `startLocalCapture` opens the microphone and records with MediaRecorder (`audio/webm;codecs=opus`, else `audio/mp4`), handing each chunk to a sink with its start and end in milliseconds; `stop(reason)` resolves once the final chunk was handed over and the microphone released. It makes no network request. `detectLocalCaptureSupport` reports whether the page can: a supported container, a Blob write to IndexedDB and a secure context, without touching the microphone.

  A root created with `localCapture: { sink }` offers it in the composer: with the host unreachable, the mic becomes "Record on this device", and a tap records into the sink. A recording stays one when the host comes back, and a dictation never turns into one. A refused microphone and a browser that cannot record on the device each get their own copy, and the latter shows no mic. Without the option nothing changes: online and offline, the mic dictates as before. Shipped builds leave it off until recordings are stored durably.

  The kit `Composer` gains `mic` (off hides the microphone) and `micLabel` (its accessible name when the capture is not dictation).

- ca68cbc: Add the local recording sheet, recording tray and editable transcript review; commit accepted text to the device-local draft before deleting its audio.
- b0815ec: **Breaking (pre-1.0, ruled on #1053):** narrow the public surfaces that were public only because a public declaration reached them, and move the names whose classification was uncertain.

  - `@schlessera/brain-ui-server`: `WsHost` keeps its configuration fields, `registry` and `close()`. Its connection, client-set, catalog, turn, activity, inbox, draft, label and classification members are `@internal`, as are the matching `WsHostOptions` fields. `SessionCatalog` and `createSessionCatalog` move to `@schlessera/brain-ui-server/internal`; a custom session catalog is no longer supported, so build the host with `createApp`.
  - `@schlessera/brain-ui-react`: `useChatStore`, `useFileStore`, `useShareStore`, `useUIStore` and `useVoiceStore` are typed as `ShellStoreHook<View>` over the new `ChatShellState`, `FileShellState`, `ShareShellState`, `UIShellState` and `VoiceShellState`, which hold the fields a shell reads and calls. The selector form and the `getState()`/`subscribe()` statics remain; `setState` is no longer typed. `activeChat`, `anyStreaming` and `hasPendingShare` take the views. `ShareIntakeState` is no longer exported, the full store state types leave the public surface, and `BrainUiRoot.stores` is `@internal`.
  - Moved to `/internal`, with no compatibility promise: `collectStats` and `CollectStatsOptions` (`@schlessera/brain/internal`); `MAX_ROUTE_BYTES` (the new `@schlessera/brain-geo/internal`); `applyExportLinkPolicy` and `protectExportLinkDestinations` (`@schlessera/brain-render-template/internal`); `TOKENS`, `LIGHT_TOKENS`, `canvas` and `TokenName` (`@schlessera/brain-ui-kit/internal`); the SDK's bridge-tool handlers (`handleAskUser`, `handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`, `handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`, `handleShowBlock`, with `ImageMaskHandlerOptions` and `LocationHandlerOptions`), `wrapCommand` and `execWrapperSpawnOptions` (`@schlessera/brain-ui-sdk/internal`); `describeRetry`, `canonicalModelId` and `resolveThinkingLevel`, from every SDK entry (`/internal` and `/internal/client`); `createToolRendererRegistry`, `pruneStoredShares`, `ShareTargetError`, `isShareTargetRequest` and `handleShareTargetRequest` (`@schlessera/brain-ui-sdk/internal/client`). `registerShareTarget` and `readShareLaunchParams` stay on `/share-target`.
  - Kept and documented: `repoRelativePathSchema` (module config schemas), `MEASURED_RUNTIME` and `runScrape`.

  The migration list is in `docs/decisions/public-export-boundary.md`.

- 9ef25ef: Loading is ghost text. `Placeholder`'s `loading` variant, `StreamingAnswer`,
  `ActionCard`, `QueueItemRow`, `SearchResultCard` and `FileRow` no longer draw
  breathing skeleton bars: they draw blurred text in the replaced content's type
  role and length, with the kit spectrum sweeping through it, and cross-fade to
  the real content over 600ms when that item's data lands. The frame, icons and
  dot slots are final from the first frame, so the layout does not move.

  New: `Placeholder` takes `ghost` (the blocks it stands in for, each
  `{ length, role, size? }`), `seed`, and `arrived` with the real content as
  children; `lines` stays as the neutral fallback, and `barHeight` is ignored.
  `QueueItemRow` and `SearchResultCard` take `index` to stagger the sweep down a
  list, and `SearchResultCard` takes `snippetLength` to size its snippet ghost.
  `StreamingAnswer` ghosts behind the answer until its first token (`bars` and
  `lines` now describe that ghost, and the answer holds that height while it
  streams); the first chunk fades in over the same 600ms, and later characters
  settle in from 0.2 opacity as they stream. Ghost glyphs are seeded per
  component instance, so re-ranking a list never regenerates them. New `--bk-ghost-*` tokens in both themes; reduced motion shows the
  ghost as plain blurred text, with no sweep or spectrum, and makes the handoff
  instant; print hides it.

- b68dd15: Ship the brain-kit logo. `BrandMark` renders the mark, or with `variant="lockup"` the mark beside the outlined `brain-kit` wordmark, in the theme's ink and amber tokens; below 24px it switches to the small-size master, and it is decorative unless given a `label`. The thirteen master SVGs ship in the package and resolve as `@schlessera/brain-ui-kit/brand/<file>`; the new React-free `@schlessera/brain-ui-kit/brand` entry lists them in `BRAND_MASTERS`.
- b68dd15: Ship a favicon and install-icon set for hosts. `@schlessera/brain-ui-kit/brand/` now also carries `favicon.ico` (16, 32 and 48px), an opaque 180px `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, a maskable `icon-maskable-512.png` all rendered from the logo's master SVGs, and a 1200x630 `social-card.png` for link previews. The `@schlessera/brain-ui-kit/brand` entry lists them in `BRAND_RASTERS` and exports what a host declares: `WEB_APP_MANIFEST_ICONS` for a web app manifest's `icons`, `WEB_APP_COLORS` for its `theme_color` and `background_color`, and `HTML_ICON_LINKS` for the page head.
- dcdda5d: The app shows the brain-kit logo where the lucide Brain icon stood in for it: the desktop side rail's wordmark tile, the login screen and the empty chat. `EmptyState` gains `brand`, which shows the logo on a plain tile in place of the icon. The Chat tab and command palette keep the lucide Brain navigation glyph.
- 825cd04: Breaking (pre-1.0, ruled on #343 question 1): package entry points now export only the supported API. Names that only brain-kit's own packages used moved to `/internal` entry points, which have no compatibility guarantee and need the same lockstep version: `@schlessera/brain/internal` (path-safety, scratch, generated-region, taxonomy, context and write helpers, in addition to the existing native-handle helpers), and the new `@schlessera/brain-scrape/internal`, `@schlessera/brain-render-template/internal`, `@schlessera/brain-ui-kit/internal`, `@schlessera/brain-ui-server/internal` and `@schlessera/brain-ui-sdk/internal/client`; `@schlessera/brain-ui-sdk/internal` and `@schlessera/brain-backend-pi/internal` gain entries. Other incidental exports were removed: core's database, indexing, ingestion, search, archive, audit, validation, skills-discovery and config-loading functions (use `@schlessera/brain/queries` for content-index reads), the modules' ledger, scoring, routing and database helpers, pi's runtime building blocks, Claude's model-discovery helpers, ui-sdk's per-kind block schemas, tone tables, classification and web-search internals, ui-server's route, cron, staging and keyterm helpers, ui-react's URL helpers and default-root singletons, and the link-policy duplicates on the ui-kit root (use `@schlessera/brain-ui-kit/links`). Every removed or moved name, with its migration path, is listed in `docs/decisions/public-export-boundary.md`. The supported surface includes every type reachable through a public signature; from 1.0, breaking it needs a major version.
- 618064d: Show durable decisions and a read-only Queue in the existing Actions destination (#684).

  - `@schlessera/brain-ui-kit` adds `EffectPreview` (the exact tool, path and full input of a stored effect, with a 12-line reveal gate and a raw-text fallback for a malformed effect) and `DispositionBar` (commit, Later and Dismiss with 44px floors and a `Recording…` state), an optional `ActionCard.footLink`, and an optional `Button.ariaLabel`.
  - `@schlessera/brain-ui-react` subscribes to the durable Actions and Queue views when the host advertises them, and renders open decisions in the `needs you` lens after live approvals, grouped by thread in priority order, with notices after them and snoozed items under `Later`. FYIs are filed under `done › Notes`. Nothing changes on a tap until the server confirms it; refusals reconcile from a fresh snapshot and nothing is resent automatically.
  - The Actions badge now counts live approvals plus open, non-FYI durable decisions. Run notices keep their own count in the list and no longer badge.
  - A pruned run's detail now reads "Trace pruned · this run's rollup is kept."

- 2529d28: `SideRail` gains optional rail acts and an operable All commands button (D52 §1). `acts` draws Search, Add a note and Daily briefing under the destinations as a vertical `Acts` toolbar with its own roving tab stop, printing each act's effect or cost and any unavailable reason at rest; the collapsed rail draws only effect-free acts. `onOpenPalette` replaces the passive ⌘K cap with an `All commands` button (`aria-keyshortcuts="Meta+K"`). The rail's middle now scrolls between a pinned wordmark and footer, and every new target is at least 44×44 under a coarse pointer. Callers that omit both props render as before. New export: `RailAct`.
- f21c430: The kit gains `DiscButton` and `DiscRow`, the overlay disc: a 32px paint in a 44px button with `ink` or `mute` rest ink and an optional label that expands leftward on hover and keyboard focus, instantly under reduced motion. `SuggestionItem` gains optional `cost`, printed as a gold effect chip, and `disabled` with `why`, printed at rest; a disabled chip stays focusable and ignores clicks, taps, Enter and Space. Interactive chips are at least 44px tall under a coarse pointer. Icons gain `latest`. The Chat page's New chat and scroll discs now use `DiscButton`: New chat is ink at rest and opens to its label, and the scroll disc is named `Scroll to latest` with a 44px target.
- 2808074: Add the working-session strip and the shared row above the composer (D52). `ComposerRow` lays out two hard halves with an 8px gutter and disappears when both are empty. `SessionStrip` fills the left half: one or two 44px pills, or the most urgent pill and a summary that opens a focus-trapped `Working` sheet listing every session, and a single 44px summary while the keyboard is up. It prints each tracker state's word, tone and icon and is one roving tab stop. `ListRow` gains `density="pill"`, which draws two lines in a half under 240px and one line otherwise, plus `name`, `tabStop` and `onFocus`. The icon map gains eight session-state keys, and `describeWorkingSession` exports the state vocabulary for other surfaces.
- 0c156cb: Add touch and pen header swipe dismissal to sheet-shaped Overlay surfaces, with bounded feedback, cancellation and reduced-motion support. OverlayCloseReason gains the additive "swipe" reason. Dictation treats swipe as Stop and keeps words for review.
- 7e398dc: Use the shared Overlay for app sheets, dialogs, fullscreen tools and panels. Escape dismisses only the topmost surface, modal focus stays inside and returns on dismissal, and destination panels keep the phone bar and rail operable. Palette and More actions run after closing. Expose the overlay surface ref and destination heading for app navigation adapters.

  CommandPalette no longer carries dialog semantics (`role="dialog"` and `aria-modal`); wrap it in Overlay to supply modal semantics and focus management. This standalone-consumer behavior change ships in a pre-1.0 minor.

  Credential and created-handoff focus destinations use deferred focus getters, preserving their targets when the owner unmounts.

- 62c912c: Change ContactCard keyWidth to a finite-positive minimum for one capped aligned column; wrap complete fact keys and long values without truncation.
- d2436b8: Continue a conversation on another backend (#61). The locked model picker, a session row's overflow and the ⌘K palette open a review sheet that drafts a handoff summary with the source's own model (falling back to a draft from the last six messages), lets you edit it and pick references, and starts a new linked chat on the chosen backend. The source keeps its history, backend and accounting and shows a forward marker; the new chat opens with a handoff card linking back. Additive wire: `chat_message.handoff`, `handoff_prepare`/`handoff_prepare_cancel`/`handoff_status`, `handoff_draft`/`handoff_receipt`, message source `handoff` and `ChatSession.handoffFrom`. A repeated handoff key never creates a second session. `ModelPicker` gains an optional `lockedAction`.
- 1a8ba32: Present human-started hygiene reviews in Actions with finding evidence, typed repairs, exact previews, confirmed dispositions, recovery controls and review receipts. Reuse the durable inbox stream, and explicitly refresh stale findings through the server-owned replacement operation.
- d89e175: Add agent-authored inline graph blocks with bounded topology, deterministic layout, supplied edges, safe local-file links and accessible replay/static lists. GraphView can disable implicit focus connections and wrap bounded labels.
- 97021a4: Use StreamingAnswer for first-content, approval-wait and retry status while
  preserving rich transcript rendering and the composer's single Stop control.
  Show only measured elapsed time and announce only phase changes.

  Approved pre-1.0 breaking migration: StreamingAnswer no longer supplies example
  phase, target, elapsed, answer or cost. Pass those facts explicitly where known.
  The polite live region contains only the phase word. Set the new `pulse` prop
  to false for a static decision-wait dot.

- 416bda6: Compose Markdown fences through CodeBlock with exact source copy and a
  kit-token syntax theme in both themes. CodeBlock accepts highlighted
  children and a host-owned head action; wrapping preserves full commands.

  Pre-1.0 breaking change approved in #1142: CodeBlock no longer defaults to
  bash or a sample command and draws no action-less copy glyph. Consumers
  must pass lang explicitly when wanted, code or children for content, and
  an action for a real control. Native wrap=false scrolling is retained.

- 9e8dc3e: Add native IconButton and TextButton primitives with kit interaction states, accessible names, forwarded refs and data hooks, and 44px touch targets.
- 7e398dc: Add the controlled Overlay primitive with four variants, native modal focus and stacking, destination-panel inertness, and named document layer tokens. BottomSheet supports an optional close control; CommandPalette supplies group semantics inside its owning overlay.

  CommandPalette no longer carries dialog semantics (`role="dialog"` and `aria-modal`); wrap it in Overlay to supply modal semantics and focus management. This standalone-consumer behavior change ships in a pre-1.0 minor.

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
- 9857f6f: Render Search and agent search results with the shared search card, preserving all snippet highlights, real scores when available, warnings and root-scoped file navigation. The kit gains optional title, type, selected-state and multi-highlight segment props; existing single-highlight callers remain supported.
- 4c92b91: Render sent validated tracks through AttachmentRow with the same identity and
  known metadata live and after history replay. Preserve image thumbnails/zoom
  and composer retry/remove controls.

  AttachmentRow's approved pre-1.0 breaking migration requires `kind` and `label`.
  Pass optional duration, metadata, extract and provenance explicitly; sample
  facts are no longer defaults. `meta` also accepts a list of wrapping lines.

- b05d556: `show_block` gains a `tracker` block (#1001): issues and pull requests the agent opened, closed, reopened, merged, labeled, commented on or reviewed, as `{ kind: "tracker", events: [{ url, action, qualifier?, title }] }` with 1-20 events.

  - **ui-kit:** `TrackerPillList` draws each event as one tappable line, `action [qualifier] · number · title ↗`, under run headers that name the host and repository. Repository, number and type are derived from a GitHub-shaped `url`; any other address shows only its title, action and host. Long titles truncate instead of wrapping, a refused address draws a withheld line with no anchor, more than six events collapse to five behind `Show all N changes` (a shared image or PDF draws them all, titles in full), and the list always says the changes are as reported by the brain.
  - **ui-sdk:** the schema rejects an event carrying any key besides its four, so a payload cannot state a repository, number or type, and the handler rejects an event whose address the link policy refuses, naming its position and the reason. The `show_block` description tells the model to use `tracker` instead of listing tracker changes in prose; the per-turn brief is unchanged.
  - **ui-react:** the block renderer draws `tracker` blocks.

### Patch Changes

- 07345fa: Connection drops no longer move or reset what is on screen. The composer's hint line stays one line high (text that does not fit ends in an ellipsis), so the offline reason arriving or leaving no longer moves the field. A draft whose save is still on its way keeps the save line's place under the composer. Reconnecting in the middle of a running turn reattaches to it: the host's greeting no longer ends the stream in view, and a history replay keeps the messages already drawn (and their nodes, times and the reader's scroll position), so the answer keeps streaming into the same message. A track upload that fails in transit just before the page sees the connection go now waits and resumes with the connection instead of showing a failure.
- 341bee1: `CommandPalette`: a disabled row's reason no longer squeezes its label to an
  ellipsis. The reason stays on the label's line, right-aligned, while the label,
  its chips and the whole reason fit side by side; otherwise it drops to a line
  of its own under the label and wraps there, with the icon kept beside the
  label. Rows with a short reason look as before.
- bddc92b: Make every `CommandPalette` row a 44px touch target under a coarse pointer. The rows were 34px tall (35.7px with a chip) for every pointer, and the palette is the only pointer route to Graph, Sync and Brain statistics. A mouse keeps the 34px rows; the label stays centred on its own line, and a reason that wraps still grows the row downward.
- 2c3e5bd: The Daily briefing panel now shows the keyless `brain briefing` output from `GET /api/brain/briefing`, the selected root's existing briefing route, with loading, empty, failure and Retry states. The internal `POST /api/brain/whatsup` route is gone, and with it the repo-local script lookup at `private/whatsup.ts` and `scripts/whatsup.ts` and its forced `--gemini` flag: opening the briefing runs no script and no agent turn. Because the briefing cannot spend, the rail, palette, More sheet and welcome chip no longer print `spends` beside it.

  `SuggestionChips` now sets its chip gaps as longhands, so a chip whose reason comes and goes on a rerender no longer makes React report a conflicting `gap`/`rowGap` style.

- a9a3376: Replace the social card with the reviewed product card (#1428); `social-card.png` is now a reviewed raster master and `social-card.svg` is removed. A 2400x1260 `social-card@2x.png` of the same card ships beside it for high-DPI Open Graph use.
- 067d63c: Paper Buttons in the primary and affirm tones keep their near-black label on hover. `--bk-button-hover-fg-primary` and `--bk-button-hover-fg-affirm` now point at `--bk-on-fill` instead of `--bk-color-canvas`, so the hovered label on the amber and teal lift fills is `#231f1a` (8.64:1 and 9.10:1) instead of the paper canvas colour (1.54:1 and 1.46:1). The dark theme resolves to the same `#0c0e12` as before, and fills, borders and caller-owned `style` are unchanged. ui-react's precompiled stylesheet carries the corrected aliases.
- a95f7c2: Keep the last rail destination whole when End scrolls a short rail to it. After a touch pan that stopped without a fling, Chromium could draw End's scroll one pixel short for a frame, and with only one pixel of trailing room that cut half a pixel off the bottom of the focused row. The scrolling part of the rail now leaves two pixels below its last item.
- 6a46e7f: Fit StatTiles into responsive columns without stretching orphan tiles, and align same-row values across labels of different heights. Keep the no-props example metadata in the Odysseus world.
- ee4bcf0: Use the canonical voyage path in Receipt's default example.
- e7f0ff3: Give desktop rail destinations full 44px touch targets, including on mixed-pointer devices, and keep short rails scrollable.
- f752ff9: Restore shared Button hover colours while preserving caller-owned styles.
- 9adc62e: Move the Working and Pending follow-up sheets and the phone ModelPicker onto the kit Overlay's native modal coordination, preserving their contents and caller actions. Keep existing sheet chrome, inherit subtree themes without sheet portals, and enforce the removal of the two legacy overlay exceptions.
- fd01063: Use kit icon and text actions across Files, graph, search, image viewing and voice review. Preserve composite row interaction and keep voice review actions reachable at narrow widths.

  Draw Overlay dismissal with the native mute IconButton, retaining its accessible name and 44px target, including untitled media and dictation close slots.

- c1052e2: Move loading ghost sweeps to one compositor band per frame, with broad, smooth
  edge fades and static glyphs. Preserve the per-item 600ms arrival handoff and
  reduced-motion/print behavior; queue and search rows no longer stagger sweeps.
- 5d48d1d: Use the shared Overlay for local-work warnings, diagnostic reviews and draft comparisons, with consistent dialog geometry at 900px and shared focus and dismissal handling.

  Wait for the shared dialog's entrance transition before asserting visibility in the review stories.

- a713b14: Keep tracker pills inside narrow flex columns with the design fonts, while preserving the action, item number and open glyph and letting the qualifier yield after the title.
- 5b1cd90: Keep complete code and suggestions reachable with native horizontal scrolling when wrapping is disabled.
- ad855ce: Keep long comparison-table values, headings and notes readable inside their own cells by wrapping unbroken text.
- 374bdd6: Place map callouts from their rendered bounds so full names fit and avoid neighboring labels while geographic markers and scale remain truthful.
- 0c156cb: End uninitiated pen gestures when their contact ends outside the header, and confine swipe-control stacking to sheet headers while keeping untitled body controls hittable.
- 7b4f62a: Add a bounded data-only `show_block` supporting-files variant rendered through RelatedFiles in chat, replay and static exports. Keep file opening in the current root, omit invented scores and sample metadata, and make actionable rows at least 44px tall.
- 693cb3e: Align stacked Meter labels with the track and value, and wrap long labels within the available width. Row meters retain their label gutter.
- 3dddcc9: Omit invented activity metadata from first-run, no-results, offline and quiet EmptyState variants. Preserve explicit metadata, empty overrides and the caught-up example default.
- Updated dependencies [b0815ec]
- Updated dependencies [825cd04]
  - @schlessera/brain-render-template@0.41.0

## 0.40.0

### Minor Changes

- 0575b1b: Add `ask_user_list`, a bridge tool that asks the user to place up to 30 items on one shared scale of 2–8 options in a single card, for rating, triage and sorting. The result maps item ids to the chosen option, lists the skipped ids, and carries optional per-item notes. It ships as new `ask_user_list_request` / `ask_user_list_response` protocol frames, a kit `AskUserListCard` (inline chip grid, "set the rest to …" with undo, a Submit that states what it will send and never silently does nothing), and a transcript binding that replays the answered summary after a reload. Both backends expose it, and withhold it from turns that have no one to show a card to. `ask_user` is unchanged.
- 830127c: Keep desktop dictation in a bounded panel above the composer, with focused stop controls and an unchanged phone sheet. Add a dictating composer state that preserves the draft and prevents typing or sending until review.
- 0c0c9df: Add `ask_user_form` for conditional questions answered in one card, with shared scale and ranking controls, configurable depth/node/options limits, visible-answer validation and history replay. Keep the existing ask tools available.
- c1a1595: Render recoverable failed-turn cards with reviewed diagnostics, subscription auth instructions, and a latest-turn Retry that retains original inputs and checks delivery after reconnect.
- 3829fed: Render multi-question ask_user exchanges in one grouped card, with visible validation, preserved free-text answers, and one answered or dismissed record.
- a01c389: Add per-message reasoning effort with saved profile defaults for Claude and Pi.
  Claude defaults to Opus 5.5 at medium; each resumed turn re-reads its default,
  unsupported levels resolve downward, and retries retain the original override.
  Expose supported levels and honest requested/confirmed effort metadata. The
  existing model chip opens a model/effort picker; overrides clear on correlated
  start or queue acceptance and remain with refused drafts. Older hosts retain
  their existing send behavior.
- 35fb78d: Add ask_user_rank: one list ordered by handle drag, taps or keyboard, with explicit kept-order results, optional top-N cutoff, and answered transcript replay.
- 3f0870d: Attach validated GPX, KML and supported GeoJSON originals in chat, preserving incoming names and MIME separately from detected staged names. Keep server-derived file evidence on queued turns and replay. Draw static track blocks with complete metrics, waypoint evidence, explicit unknown and partial values, separate gaps and original references; resolve assets before PNG/PDF export. Generic share intake remains compatible.

### Patch Changes

- a4d5ef0: Restore composer focus after inline approvals and ask-user list, rank, and form submissions.
- 0506c10: Correct the README's UI-root isolation, component coverage and hit-target descriptions.
- 619ee2b: Use the Odysseus world consistently in fixture corpora, package guidance and examples.
- d934fe0: Keep ranking keyboard instructions readable when reordered actions wrap at phone width and preserve 44px touch targets for its footer actions.
- 1eaeba2: `Receipt`: a key wider than its column no longer runs into its value. The key column is sized once per receipt, to the widest key, never narrower than `keyWidth` and never wider than 90px; a key past 90px wraps inside the column and is never cut. Receipts whose keys already fit render as before.
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
- Updated dependencies [4c1a424]
  - @schlessera/brain-render-template@0.40.0

## 0.39.0

### Minor Changes

- cf94a81: `show_block` gains a `link` block (#43): one external page the reader may want to open, as `{ kind: "link", url, title?, description? }`.

  - **ui-kit:** `LinkPreviewCard` gains a link mode, switched on by a new `url` prop, with `description`, `expanded`, `onExpandedChange` and `onCopy`. The card derives the host it shows and the `href` it opens from one parse of `url`, so no caller can supply a host that disagrees with the destination. The host is the first line and is never ellipsised; an internationalised name leads with its ASCII (`xn--`) form and adds a "reads as" line. The title and description render as the brain's words, with an attribution line on every card. Nothing is fetched. The card opens the page only from its `Open ↗` anchor (new tab, no opener, no referrer), and the full address sits behind a disclosure. A refused address draws a "Link withheld" card with no anchor. Without `url` the card is unchanged. The policy is `classifyLink`, exported from `@schlessera/brain-ui-kit` and from the new React-free `@schlessera/brain-ui-kit/links` entry.
  - **ui-sdk:** the `show_block` handler rejects a `link` block whose address `classifyLink` refuses (relative, not `http(s)`, carrying credentials, containing invisible or bidi characters, mixing scripts in one hostname label, or longer than 2,048 characters), naming the reason. ui-sdk now depends on `@schlessera/brain-ui-kit` for that function.
  - **ui-react:** the block renderer draws `link` blocks and copies the exact address to the clipboard from the card's Copy control.

- b1805ee: A markdown link in prose shows where it goes (#551, D49). Every link `BrainMarkdown` draws, apart from repo file and directory links, is classified by `classifyLink` on every surface: answers, share blocks, `ask_user`, the briefing and the file viewer, autolinks included. An accepted link keeps its text and shows the ASCII host beside it, `your bank (account-check.example)`, with `rel="noopener noreferrer nofollow"` and `referrerpolicy="no-referrer"`. A refused link is inert text followed by `[link withheld — <reason>]`. A `mailto:` link stays live with its address shown, and its query parameters (`subject`, `body`, `cc`, `bcc`) are dropped from the href. While an answer streams, a link that has not closed yet is held back, so no raw address or half-typed autolink is ever drawn.

  `@schlessera/brain-ui-kit/links` gains `classifyMailto`, a check beside `classifyLink` for the one scheme prose keeps live. `classifyLink` is unchanged, and the `link` block still refuses `mailto:`.

- b8c355d: `show_block` gains a `map` block: 1 to 30 named places, drawn on real geography with a numbered list under them that always carries every place (#44). The model supplies places and, when a source states them, coordinates. The surface decides everything the drawing needs: one map, a pair of maps for two groups too far apart for one, or only the list, with a line that says why. The payload has no span, zoom, box, tone or numbering field.

  - **ui-sdk**: `MAP_BLOCK_SCHEMA` joins the block union, and the tool's description and brief name it. `planPlaces` (from `/client`) is the pure plan behind the drawing: rows in payload order, the mode, each frame's geometry box, and whether names fit on the map. A place with no coordinates, at `0, 0` or past ±85° is listed with the reason and never pinned.
  - **ui-kit**: new `PlaceMap` and `PlaceList` blocks. `MapView` gains additive props: `pinMode="number"` (numbered badges, lettered clusters such as `A·5`), `onClusters`, `letterFrom`, `coordChip`, `describe` (an accessible name, with the list as its description), `framed`, and `MapPin.n`. `mapViewBounds` exports the box the view draws. Existing `MapView` output is unchanged.
  - **ui-react**: `BlockCard` draws the `map` block. It fetches each frame's geometry through the existing `/geo/coastline` route and cache. When geometry is empty or unavailable, the frame becomes a one-line note and the list still carries every place. A shared answer draws the list and asks for no geometry. `BlockCard` takes an optional `isStatic` prop for renders nothing will update.

### Patch Changes

- c1ac8c9: `BarList` labels wrap instead of being cut off with an ellipsis (#174). A bar list row is the record, so a long document type or agent name is now shown in full: it breaks at spaces and hyphens, and mid-word only when a single word cannot fit. The bar and the figure stay on the label's first line, and continuation lines fill the label column alone. Rows are about 4px taller than before, including single-line ones. No prop changes.

## 0.38.0

### Minor Changes

- 94fd8c9: Each meaning an answer block carried in ink colour alone now also draws a non-colour cue, derived from the tone the payload already carries, so it survives a grayscale print and a reader who cannot tell the hues apart. A judged value in `ComparisonTable`, `StatTiles`, `DataTable`, `Receipt`, `ContactCard` and the `TrendChart` delta draws its tone's glyph from the kit's icon vocabulary (red a triangle, gold a circle, amber a hand, purple a question mark; teal, blue, neutral, ink and dim draw none). `TimelineList` draws an event kind's glyph in place of the dot, `ScheduleList` leads a title with the claim on you, `StepList`'s current step wears a 2px ring, and a company or project `ContactCard` leads its role line with the kind word. No payload field, prop, token or icon key is added. `show_block`'s `bars` description now says a bar's tone is the class of work, not a judgement.
- fe0041f: A shared answer (PNG or PDF) now draws its answer blocks, in a new print theme, where before it contained only the message's markdown. `@schlessera/brain-ui-kit` adds `PRINT_TOKENS`, `printThemeCss()` and a `[data-theme="print"]` block in its stylesheet: a white ground, no washes, and borders that carry the structure. `@schlessera/brain-ui-react` renders each `show_block` block and each classified block to static HTML in the print theme, in the order the answer shows them. A message with no block shares exactly as before.

## 0.37.0

### Minor Changes

- fa09aaa: Land fills for a mainland view: an open coastline is closed against the viewport on the land side.

  `prepareLand` used to keep only the rings that closed on their own, so an island came back filled and a mainland shore came back as a bare stroke that does not say which side is water. It now closes an open shore against the requested bbox using OSM's land-on-the-left winding: a counterclockwise walk from where the shore leaves the box to where the next shore comes in. That gets a peninsula and a bay right without deciding between them, and two shores bounding the same land — an island wider than the view, an isthmus — come out as the one ring they bound rather than as two overlapping claims.

  Two things come with it. `stitch` now joins ways from both ends rather than only forward, which is what makes a shore that Overpass returned out of order one chain instead of two half-chains that close against nothing. And `prepareLand` takes an optional `onLand` witness — the road network from the same response — and drops the closure rather than drawing it when the fill turns out not to contain the roads.

  New from `@schlessera/brain-ui-sdk/server`: `closeAgainstViewport`, `signedArea`, `stitch`, and the `LandOptions` type. `CoastlineResult`'s shape is unchanged; its `land` key now carries mainland rings where it was empty before. The strait fixture in `@schlessera/brain-ui-kit` is regenerated with its three land rings.

### Patch Changes

- 206a2a9: The composer's field grows with the text it displays, wrapped lines included,
  up to its five-row cap, and shrinks back when the draft does. It used to grow
  only on explicit newlines, so a paragraph typed into a phone-width field
  scrolled inside one visible line. Sizing is `field-sizing: content` on a
  controlled value with text in it — no ref, no measuring, no layout effect, so a
  keystroke still costs one render — with the newline count kept on `rows` as the
  floor a browser without `field-sizing` falls back to. `maxRows` now also caps
  soft-wrapped growth, at that many whole lines or the design's 96px ceiling,
  whichever is smaller — the same heights the previous constant cap produced.
- da1c504: Doc comments now cite `docs/decisions/` instead of the removed `.plan/` tree. No
  runtime change.
- 3015302: `QuoteCard`: a quote or note with no break opportunity in it — a URL, most
  often — now wraps inside the card instead of laying out at its full width and
  scrolling the whole transcript sideways on a phone. The quote and note slots
  take the kit's existing `overflow-wrap: anywhere`; the source row was already
  ellipsised. No prop changes and the `quote` block payload is unchanged.

## 0.36.0

### Minor Changes

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

- 9e5469c: ui-kit wave 1b: the accessibility gate is enforced, not configured.

  `parameters.a11y.test` is now `'error'`. It was previously `'todo'`, which is
  silent in CI — and that was shown rather than assumed: a bare `<img>` with no
  `alt` added to `Callout`, rendering in six stories, passed the whole suite green
  at `'todo'` (503/503, exit 0) and failed six stories at `'error'`. Until this
  release, nothing in the kit's green CI was an accessibility claim.

  The flip found 33 failures from four axe rules. What changed in the package:

  - **`FileRow`: every operable row is a `treeitem`.** A file was an `option`,
    which no container can make valid — `treeitem` needs a `tree` parent and
    `option` needs a `listbox`, so whichever one a caller renders, half the rows
    are invalid inside it. The design's own role table says `button` / `treeitem`
    and never mentions `option`.
  - **`Toggle` gained `label` and `labelledBy`.** A `role="switch"` shipped with no
    accessible name, and a switch is the one control with no visual words to fall
    back on. Passing a handler without either now warns in development.
  - **Five components that put a handler on a bare `<div>`/`<span>` became real
    controls** — `Surface`, `LinkPreviewCard`, `AttachmentRow`, `Placeholder`'s
    retry and `StreamingAnswer`'s Stop. Role, tab stop, Enter/Space, hover and a
    focus ring at the offset their class specifies, all still gated on the handler:
    no `onClick`, no class, no role, no tab stop.
  - **`prefers-reduced-motion` is implemented.** It was absent entirely, and it is
    one media query, because there is one keyframe: redefining `breathe` under the
    media query reaches all six call sites, which write `animation` on their own
    inline style and so cannot be reached from a stylesheet any other way. The
    single stop is the rest state, so a pulsing dot settles at full opacity rather
    than reading as disabled.
  - **`--bk-focus-ring` is `var(--bk-color-ink)`** rather than a second copy of
    ink's literal, so a theme that moves ink moves the ring with it. Three
    `var(--token, #hex)` fallbacks removed.
  - **Seven `--bk-surface-hover-tint-*` tokens**, for the newly operable `Surface`.

  Contrast was measured rather than trusted. The design's floor claim is exact —
  `#8a8691` is 5.09:1 on surface — and it holds on no other ground the kit
  actually uses: over `raised` plus any of the kit's 81 translucent tints it fails
  all 81, and under an `opacity: .7` row it reaches 3.08. Nothing in the palette
  was changed; every figure is recomputed from the tokens in a test, so a token
  that moves fails a test and names what changed.

- 43d7014: ui-kit wave 4: agent views, screen chrome and the first desktop components.

  Thirteen components, taking the kit to 59. Agent and corpus views —
  `AgentRunCard`, `AgentOrbit`, `LaneChart`, `GraphView`. Screen chrome —
  `ScreenHeader`, `ScreenBody`, `Composer`, `TabBar`, `BottomSheet`,
  `MessageBubble`. Desktop, per D22 — `SideRail` and `CommandPalette`, the first
  components in the kit built for a window rather than a phone.

  Three of those are not straight ports and each is documented where it lives:

  - **`Composer` is now a real `<textarea>`.** The design draws it as a styled
    span and its own known-gaps list asks for the input; ⏎ sends, ⇧⏎ inserts a
    newline, and with no `onChange` the field is genuinely `readOnly` rather than
    a div wearing `role="textbox"`.
  - **`ScreenBody` is the kit's one addition to the design's component set.**
    Every assembled screen retypes the same `flex: 1; min-height: 0; overflow`
    container by hand, and a body missing `min-height: 0` does not scroll, it
    grows.
  - **`AgentRunCard` takes `agent`, not `name`.** The source's `data-props`
    declares `name` while its own `renderVals()` reads `p.agent`; the half that
    renders wins.

  `AgentOrbit`'s polar placement is verified numerically against hand-computed
  pixel values, the way `MapView`'s projection was. `TabBar`'s expanded hit target
  is measured rather than described, including the bar width below which its slots
  begin stealing each other's clicks.

  34 new tokens. Three runtime fallbacks that named a real brand or a real person
  were replaced with the fixture world's content; every other fallback is the
  design's verbatim, so it stays comparable against the source.

- 1d67cf1: The canvas palettes get a paper set (seventh drop, §L6).

  The graph canvas and the diagram theme are the two places an app hands a
  colour to something that does not draw with CSS, and until now both used a
  dark set on paper — legible by accident, never judged. The kit now owns those
  values as tokens, `light-dark(<paper>, <dark>)` like every other one:
  `--bk-canvas-slot-1` to `-8` (the categorical slots), `--bk-canvas-ramp-1` to
  `-5` (the distance ramp, near to far), `--bk-canvas-root` and
  `--bk-canvas-other`, the four maintenance lenses `--bk-canvas-lens-orphan`,
  `-unreachable`, `-broken`, `-stale`, and the six diagram surfaces
  `--bk-diagram-bg`, `-node`, `-cluster`, `-line`, `-cluster-border`, `-text`.
  The dark halves are the sets the app validated against its dark canvas; the
  paper halves are the design's, every mark measured at 3:1 against the paper
  canvas and pinned by `tests/canvas-palette.test.ts`. Slot order is frozen in
  both themes: the order is the CVD mechanism, so a theme may respell a slot
  and never reorder one. The ramp gives up its light end on paper, not its
  steps — five luminance steps below the 3:1 ceiling rather than a reach for
  white.

  For a consumer that has to read a token as a value — a WebGL canvas, a
  diagram library's variables — the package now exports `TOKENS`,
  `LIGHT_TOKENS`, `TokenName` and a `canvas` map of the new references. Read the
  stylesheet's declaration first and fall back to these tables where there is
  no document; a `--bk-*` token computes to the whole `light-dark()` expression,
  which a canvas `fillStyle` silently rejects, so split it on the element's
  `color-scheme` before drawing with it.

- 9d5c255: ui-kit: real coastline on the map, and three MapView bugs it made visible.

  Simplified OpenStreetMap coastline for five Mediterranean locations, plus roads
  for Troy, drawn through `MapView`'s existing `paths` prop — no tiles, no
  network at render time, no key, no new runtime dependency. **2,611 vertices,
  11.6 KB gzipped for all five**; one raster map tile is about 16 KB. The
  generation script is committed and re-runnable and is never run in CI.

  The geometry is ODbL where the rest of the repo is MIT — a rendered map is a
  Produced Work and carries no share-alike, but the JSON is a Derivative Database
  and does. `fixtures/geo/LICENSE` carries the obligation, and a test asserts
  that the npm tarball still contains zero fixture files, so the published
  package stays pure MIT.

  One new prop: `attribution`, rendered in the foot row. It is a prop rather than
  something the component infers because `MapView` cannot know where a caller's
  paths came from — a consumer drawing their own survey has nothing to credit.

  Three fixes the coastline exposed, each invisible while there was nothing to be
  wrong about:

  - **Every overlay was positioned in the wrong unit.** Pins, graticule labels
    and the scale bar sat at the projected SVG pixel on a drawing that scales to
    the card's fluid width — 30% of the box out on a 232px card. They are
    percentages now, and the SVG carries `preserveAspectRatio="none"`, which is
    what the projection already assumed: `px()` and `py()` map longitude and
    latitude across the full width and height independently.
  - **The scale bar claimed a distance the map was not drawn at** on any card
    that was not exactly `width` wide.
  - **A pin's dot was not on its coordinate.** `translate(-50%,-50%)` centred the
    whole label row on the point, putting the dot half a label away — 19% of the
    width — and displacing two pins by different amounts according to their label
    lengths, so the distance between them was wrong too.

- 79dd9cb: The fifth design drop. `CommandPalette` takes a real query input
  (`onQueryChange`, `placeholder`, combobox semantics), `cost` and `why` rows
  (a spend chip; a disabled row with its reason printed rather than omitted),
  and a list that scrolls. `Composer` is kit-owned: `state` (ready · streaming ·
  reconnecting · offline) drives placeholder, hint and the trailing control
  together, with `onStop`, a provider chip in the hint line (`provider`,
  `onProvider`), recall chips above the field (`recall`, `onRecallRemove`), an
  attach button that is a menu trigger, and the offline reason (`blockedWhy`).
  `MapView` takes `accuracyM` (the span becomes `max(spanKm, 6 × accuracy)` and
  the uncertainty is drawn as a ring at true scale, not below 14px), `note`
  (inside the card, under a hairline) and `maxWidth` (default 420). The nav
  defaults are the five destinations — Chat · Actions · Files · Graph ·
  Settings on the rail, Settings folded into More on the bar — and the
  assembled chat screen closes with `SuggestionChips` while the weekly review
  carries the `InlineToast` receipt for the last policy written.
- 84af26d: The design's answers to the open contrast and keyboard questions. The dark
  machine-meta ink and the `neutral` accent move from `#8a8691` to `#9a96a1`, the
  floor stated against the worst tint rather than the bare surface; a superseded
  `QueueItemRow` is no longer faded; the effect chip and subtitle on a solid
  `Button` sit on a white well in opaque near-black. On paper, teal, purple and
  red ink darken once more for stacked tints and every accent's dot value is the
  design's. `Home` and `End` reach the edges of every roving group (`FilterRow`,
  `TabBar`, `SideRail`, `CommandPalette`, `ChoiceOption`, `FileRow`, which also
  gains ↑↓); `MapView` clusters colliding pins into one `+N` label
  (`clusterPx`); `EmptyState`'s heading is focusable and takes `focusTitle`;
  `ListRow` names its toggle by its title; `Toggle` gains `disabled`, and a
  disabled `Button` no longer fires its handler.
- bc3a26d: Add the twenty in-chat block and conversation-lifecycle components — the shapes
  an answer can take inside a chat transcript, and the surface a model will drive
  by tool call.

  `StepList`, `MapView`, `TimelineList`, `ScheduleList`, `QuoteCard`, `CodeBlock`,
  `LinkPreviewCard`, `ContactCard`, `StatTiles`, `TrendChart`, `Disclosure` and
  `FeedbackRow`; `StreamingAnswer`, `SuggestionChips`, `AttachmentRow`,
  `InlineToast`, `ComparisonTable`, `RelatedFiles`, `DigestCard` and `EmptyState`.

  `MapView` projects real coordinates with Web Mercator and computes its scale bar
  from metres-per-pixel at the view's latitude, so the distance it claims is the
  distance it draws; `tests/mapview-projection.test.tsx` pins the arithmetic.
  `Disclosure` is the kit's one stateful component and is uncontrolled after the
  first toggle — `open` seeds it and is then ignored, which is the design's
  behaviour and is asserted rather than assumed.

  112 new design tokens, and one rename: `--bk-diff-bg-inset` is now
  `--bk-inset-well-bg`, since three components share it. `@schlessera/brain-ui-kit/styles.css`
  (or `theme.css`) remains mandatory — every colour resolves through a `--bk-*`
  custom property with no fallback.

- b5a64a1: The light theme, from the second design drop. Every colour token is now
  `light-dark(<paper>, <dark>)` and `color-scheme` selects the half; put
  `data-theme="light" | "dark" | "system"` on `<html>` or any subtree to switch.
  Dark stays the default. The kit follows the drop's other decisions: `neutral`
  is the grey accent everywhere and `ink` / `dim` are named tones for values
  (`StatTiles`, `ComparisonTable`, `Receipt` rows and `ContactCard` facts take
  `ValueTone`; untoned values keep their old rendering); text on a solid fill
  reads a new `on-fill` token, so count badges are near-black rather than white;
  `FeedbackRow` thumbs and `InlineToast`'s undo carry no border and meet the 44px
  hit-target floor. Storybook gains a theme switch and a second Vitest project
  that runs every story on paper.
- c516e43: `ui-kit` gains its first twelve components, ported from the design drop: the
  eleven primitives — `Icon`, `StatusDot`, `Chip`, `Label`, `Meter`, `Button`,
  `Toggle`, `Surface`, `Callout`, `PathRef`, `DiffBlock` — plus `Placeholder`,
  the loading / empty / error state four later components delegate to.

  This gives the package its first runtime dependency, `lucide-react`. `Icon` is
  the one component whose original behaviour was deliberately not ported: the
  source emitted `<i data-lucide>` and let Lucide replace the node outside React,
  on a timer. `Icon` now renders `lucide-react` components, so the glyph follows
  from the prop, and a test asserts all 77 semantic keys resolve to real exports.

  **Consumers MUST import `@schlessera/brain-ui-kit/styles.css`** (or `theme.css`
  into their own Tailwind v4 build). It is required, not recommended: every colour
  these components render resolves through a namespaced custom property with no
  fallback — `var(--bk-amber-ink)` — so without the stylesheet they render with no
  colour at all, as do the `breathe` keyframe, the three font families and the
  interaction states.

  The missing fallback is deliberate. With one, a consumer who forgot the
  stylesheet would render in the dark palette whatever theme they asked for, which
  is a failure that looks deliberate and ships; no colour is a failure that gets
  fixed in minutes. What the custom property buys is that a `[data-theme]` root
  re-points the whole kit with no runtime theme context. No component contains a
  colour literal; `src/tokens.ts` is the single place they are written down.

  Each accent is three tokens — `ink` for text and borders, `fill` for solid
  surfaces, `mark` for small marks — which are one colour in the dark theme and
  three on paper. That structure is what will let the design's published light
  palette land as a block of values rather than as an edit to every component.

  `Button` and `Toggle` ship the design's interaction states: hover that lifts the
  surface without changing the tone, pressed, a 2px ink `:focus-visible` ring,
  disabled, real roles, and keyboard activation. `Toggle` extends its 38x22 visual
  to a 44x44 hit target, with a test that probes the target's edges — the design
  records a real bug from getting that wrong. All of it appears only when a
  handler is passed, so a static control never pretends to be operable.

  Related: the token block is `@theme static`. Tailwind v4 prunes theme variables
  that no utility references, and these components style themselves from tokens
  rather than utility classes, so plain `@theme` shipped a stylesheet with no
  design tokens in it at all.

- 2a58a6f: ui-kit: one tab stop per group, not one per item.

  `FilterRow`, `TabBar`, `SideRail` and `ChoiceOption` each rendered
  `tabIndex={0}` on every item, so the arrow keys the design's role-and-keys table
  specifies were redundant with Tab rather than being the way you move. A screen
  carrying both nav components cost **ten tab presses before any content**; it
  costs two.

  The stop resolves last-focused → selected → **first eligible**, and the third
  clause is the finding rather than a fallback: a group with nothing selected
  whose items are all `tabIndex={-1}` is not harder to reach but unreachable, and
  an `AskUserCard` whose question nobody has answered yet is exactly that case.

  `ChoiceOption` needed a different answer, because it is one option inside its
  caller's `radiogroup` and cannot see its siblings. It takes a new `tabStop` prop
  (and `onFocus`) which `AskUserCard` computes; omitting it leaves the option a
  tab stop, which is the only safe default for a component that cannot see its own
  group.

  Also fixes a real bug: `FilterRow`'s arrow handler fired `items[n]` with an
  index into the DOM walk, which only visits items carrying a role — so a row
  mixing interactive and decorative pills filtered by the wrong one.

- c659605: `ui-kit` gains fourteen more components, ported from the design drop: the rows
  and lists — `ListRow`, `ChoiceOption`, `FileRow`, `QueueItemRow`, `FilterRow` —
  the evidence surfaces — `Receipt`, `TraceSteps`, `DataTable`, `BarList`,
  `SearchResultCard` — and the four decision surfaces, `ActionCard`,
  `AskUserCard`, `ApprovalCard` and `NotificationCard`.

  Seven of them ship the design's interaction states. Hover, pressed and focus are
  CSS rules in `theme.css` with the per-component values travelling as `--hv-*`
  custom properties, and **all of it is gated on a handler**: a row with no
  `onClick` gets no role, no tab stop, no hover and no focus ring, so a static list
  never pretends to be clickable. That is an API contract, not styling. Rows take a
  new `.bk-row` class rather than `.bk-control`, because the design draws a row's
  focus ring INSIDE the row — an outline at +2 on a full-width row is clipped by
  the first ancestor with `overflow: hidden`, which is every `Surface`.

  Keyboard activation comes with the roles: Enter and Space on every
  `role="button"`, ↑↓ inside `ChoiceOption`'s radio group, ←→ across `FilterRow`'s
  tabs with activation following focus. `FilterRow` and `AskUserCard` also render
  the `tablist` and `radiogroup` their children's roles require.

  `ActionCard`, `QueueItemRow`, `SearchResultCard` and `FileRow` delegate their
  loading, empty and error rendering to `Placeholder`, each supplying its own copy
  through overridable `stateMessage` / `stateDetail`.

  `Button` gains an optional `style` prop, merged onto its own root, and
  `ApprovalCard`'s two buttons now split their row evenly instead of overflowing
  the card. `block` means `width: 100%` _and_ `flex: none`, so two default Buttons
  in a flex row each demand the whole row and neither yields. A row of
  content-sized buttons passes `block={false}`; a row that should split evenly
  passes `style={{ flex: "1 1 0", width: "auto" }}`.

  Forty-one new tokens, all in `theme.css` — no `.tsx` in the package contains a
  colour literal. `@schlessera/brain-ui-kit/styles.css` (or `theme.css` into your
  own Tailwind v4 build) remains MANDATORY: every colour resolves through a
  `--bk-*` custom property with no fallback, so without the stylesheet the
  components render with no colour at all.

- 86a79f2: New package: `@schlessera/brain-ui-kit`, the presentational design kit.

  The design tokens and a Storybook (10.6, Vite builder, CSF Next, interaction
  tests in real Chromium). The component port follows in its own waves.

  The kit is 100% prop-driven by construction: no stores, no `fetch`, no ambient
  configuration, no browser globals. `bun run lint` grows a sixth gate,
  `scripts/check-kit-purity.ts`, that enforces it rather than leaving it to review.

- 2a58a6f: ui-kit: the four assembled screens, and four component fixes they surfaced.

  The catalog's §11 screens — morning digest, chat answer, weekly review, run
  detail — rebuilt from the kit alone. The component set held: no screen needed a
  new component, and nothing in a screen declares anything but layout.

  What assembly surfaced were defects in components that each passed their own
  stories, because a component's own stories put it in a container built for it
  and a screen does not:

  - **`ScreenBody` was crushing its children.** A flex column's children default
    to `flex-shrink: 1`, so an over-full screen squeezed every child instead of
    scrolling — and it failed as somebody else's bug: a `FilterRow` compressing to
    14px and clipping the descenders off its own labels, an `ActionCard`
    swallowing the last line of its body, a `margin-top: auto` spacer silently
    ceasing to space. `.bk-screen-body > * { flex-shrink: 0 }`.
  - **A scrolling `ScreenBody` is now a tab stop.** `overflow: auto` makes it a
    scrollable region, and this kit gates every other tab stop on a handler — so a
    read-only screen had no focusable content and stranded everything below the
    fold.
  - **A centred `Button` painted its content outside its own box** when it was
    narrower than its label plus its effect chip; `flex: none` was overriding the
    `minWidth: 0` already there.
  - **`ActionCard`'s children get their own band.** `body` and `foot` both set a
    margin and `children` had none, so a caller's button row sat flush against the
    last line of the body.

- 1d67cf1: The design's seventh drop, on the four components it ruled on.

  - `DiffBlock` gains `tinted`. Monochrome stays the default; tinted is for the one case where the diff is itself the decision. Removed rows sit on a red ground and added rows on teal, at the tint rule on the fill hue (`--bk-diff-tint-red` / `--bk-diff-tint-teal`, light halves derived), and the sign column is a mark: the tone's ink at weight 600, never an alpha. Rows are a fixed 8px sign column beside a wrapping text column, so a long line wraps with a hanging indent and a continuation can never be misread as an unsigned line. Nothing truncates and nothing scrolls sideways.
  - `ChoiceOption` gains `multiple`: the role goes radio to checkbox and the mark goes round to square, because the shape is the affordance. The arrow-key walk is scoped to a `role="group"` as well as a `radiogroup`, and the D20 gate holds (no handler, no role, no tab stop).
  - `AskUserCard` gains `multi` (checkbox options inside a `group` labelled by the question; an answered head reads "Answered · N chosen"), `answers` (every choice as its own row, meta on the first, default "you chose N · …"), and a fourth state, `dismissed`: gold border and head ("Unanswered — the turn ended"), no options, a lapsed row on a gold ground stating the fact (`lapsedNote` overrides it) with an "Ask again" button bound to `onAskAgain` — no handler, no button. New tokens `ask-border-gold`, `ask-lapsed-tint`, `ask-lapsed-border`. Nothing fades in any state.
  - `ApprovalCard` no longer splits its buttons evenly. The design ruled that an even split claims the two answers are equally likely, which the card has no business claiming: Allow takes the remaining width, Deny is content-sized with a 96 x 44 floor, the head aligns to the top, and the target wraps instead of ellipsising — the card is the record. The port's earlier defence of the 50/50 split is recorded in the component's comment as overruled. The `Default` visual baseline moves with it.

  Stories cover each of these (a tinted diff that wraps, a checkbox group and its keyboard walk, the multi and dismissed cards with and without the handler, the button floor and the wrapping target), and catalog §13 in `Question and mask` now stacks the four states, single and multi, beside the tinted diff.

- 192f004: `SideRail` takes `statusTone` (teal, amber or red) for the line under the
  wordmark, and `null` for `spendPct` or `hint` draws no spend meter and no ⌘K
  cap respectively — an app that tracks no spend or has no palette no longer
  prints a value it cannot back. `undefined` keeps the fixture defaults the
  stories render. `CommandPalette` takes `footHint` for the key legend, so an
  app that does not bind ⌘⏎ does not print it.
- d8e3103: The sixth design drop: a question is an exchange, a mask is a receipt.
  `AskUserCard` carries `state` — `pending` (options, one focus stop),
  `answered` (the chosen answer, checked and in the accent, with when; the
  alternatives are gone, not dimmed) and `typed` (the user answered in the
  composer; the card quotes what the agent took, behind a neutral border) — all
  three at full contrast, plus `otherOpen` / `otherPlaceholder` /
  `onOtherSubmit` for a real free-text field in place of the Submit row, and
  `answer` / `answerMeta`. Its heading is now the accent itself rather than the
  accent at 85%. `FileRow` binds ← / → on `treeitem` rows through `onFold`, and
  its name, `TraceSteps`' step text, `SearchResultCard`'s path, `ListRow`'s
  title and the palette's rows carry the full value as a `title` — a row that
  opens the record may ellipsise, a receipt may not: `InlineToast`'s target now
  wraps. `MapView` clamps its viewport to 110–260px so the server's geometry
  envelope is bounded; a screen that passed `height={88}` renders at 110. The
  catalog's §13 mask receipt is composed in `Decisions/Question and mask`.

### Patch Changes

- b9e2390: The map's fetch envelope is 1.5 spans across by 1.0 down (D38 §9), replacing
  the square 2.4-span bleed of which only 23% could ever be drawn. The kit's
  fixture generator and the app's live location card share the rule; all six
  geo fixtures were regenerated and the set stays under its size guard.
- 7e829a8: `ValueTone` and `InkTone` are exported from the package root. Several block
  props were already typed with `ValueTone` (`StatTile.tone`,
  `ComparisonColumn.tone`, `ReceiptRow.tone`, `ContactFact.tone`), so a consumer
  could receive the type but not name it.
- 2a58a6f: ui-kit: fix a graph that rendered as a line and a lane drawn as two runs.

  `GraphView` renders every element inside it absolutely, so its intrinsic width
  is zero and `width: 100%` in a container that sizes itself to its content
  resolved against a container waiting for the same number. Both landed on nothing
  and the graph collapsed to a 2px sliver of its own border. It now carries a
  `minWidth` floor: below it eight labelled nodes pile into an unreadable heap, so
  a narrow graph is the correct failure and an invisible one never is.

  `LaneChart` gave every segment a radius on all four corners, so a lane whose
  segments touch — one piece of work that stopped being able to continue — drew
  the solid cap and the hatched cap rounding away from each other with a notch
  between them, reading as two separate runs. Since the hatch means _waiting on
  the user_ and that distinction is the only argument the chart makes, the seam
  was working against the component. A continuation now drops its left rounding,
  reaches back under its predecessor by one corner radius, and paints behind it.

- e878d87: The Vathy geometry fixture lands: the Ithaca coordinate at 1.8 km, street
  tier, with `vathyMap` and a `VathyHasStreets` story showing the three stroke
  weights of the detail ladder on one card.
- 2a58a6f: ui-kit: visual regression, and the browser tests now run in CI at all.

  Sixteen committed baselines covering the four assembled screens, the components
  whose correctness is geometry rather than text, and two dense cards. They are
  generated and compared only inside `mcr.microsoft.com/playwright:v1.63.0-noble`,
  because browser rendering is not reproducible across environments — a
  host-generated baseline compared in the container did not merely differ, it made
  the matcher retry until the test timed out.

  The larger half is that the 536 Storybook interaction and accessibility tests
  ran nowhere but a developer's machine until now. The accessibility gate that was
  proved with a seeded violation was, from the moment it landed, enforced by
  nobody. Both projects now run in CI through the same script a developer runs
  locally, so the two cannot drift.

  No published behaviour changes; this is test infrastructure, and it ships as a
  patch so the lockstep group has a reason recorded.

- d257ee1: The `get_current_location` result is a map. The card renders the kit's
  `MapView` with the fix as its pin, widens the view when the accuracy is
  coarse, and fetches the shoreline and roads around the fix from the server's
  `/geo/coastline` route, credited to OpenStreetMap when geometry is drawn. With
  no server, an older server or an outage the map keeps its pin, graticule and
  scale bar. The API client gains `geoCoastline(bbox, { width, signal })`, and
  the kit exports the `MapLand` type beside `MapPath` and `MapPin`.

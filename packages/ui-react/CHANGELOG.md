# @schlessera/brain-ui-react

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

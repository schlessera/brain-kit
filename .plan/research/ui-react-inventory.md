# `@schlessera/brain-ui-react` — UI inventory

Snapshot of `packages/ui-react` at v0.35.0 (main @ c6f7a6e). Purpose: establish
what a Storybook would have to cover, and where the seams are for
"in-chat components an LLM invokes via tool calling".

Package facts:
- Runtime deps that matter for stories: `react-markdown` 10, `remark-gfm`,
  `rehype-highlight`, `mermaid` 11, `framer-motion` 12, `lucide-react` 0.460,
  `sigma` 3 + `graphology`, `zustand` 5, `clsx` + `tailwind-merge`,
  `@simplewebauthn/browser`, `@schlessera/brain-ui-sdk` (workspace).
- Peer deps: `react >= 18`, `react-dom >= 18`. Dev/test on React 19.
- Exports: `.` (bun→`src/index.ts`, else `dist/index.js`), `./styles.css`
  (precompiled), `./theme.css` (raw `@theme` block), `./package.json`.
- `sideEffects: ["**/*.css"]`.

---

## 1. Design tokens

Two CSS files only. **There is no `tailwind.config.js` anywhere** — this is
Tailwind v4, configured entirely in CSS.

### `src/styles.css` (4 lines, the precompiled-stylesheet entry)

```css
/* Precompiled-stylesheet entry: `bunx @tailwindcss/cli -i src/styles.css -o dist/styles.css`. */
@import "tailwindcss" source(none);
@source "./";
@import "./theme.css";
```

`source(none)` disables Tailwind's automatic content detection; `@source "./"`
pins the scan root to the package `src`, so the compiled output is identical
regardless of the CWD the CLI runs from.

Consumers have two paths (documented in the `theme.css` header):
- **With a Tailwind v4 build**: `@import` `theme.css` plus
  `@source "../node_modules/@schlessera/brain-ui-react/src";`
- **Without**: import the precompiled `./styles.css` export.

### `src/theme.css` — the `@theme` block (every token, verbatim)

```css
@theme {
  /* Backgrounds - warm-tinted darks */
  --color-background: #0c0e12;
  --color-surface: #141619;
  --color-surface-raised: #1a1d22;
  --color-surface-overlay: #1e2128;

  /* Borders */
  --color-border: #2a2d35;
  --color-border-subtle: #1f2229;

  /* Text hierarchy */
  --color-foreground: #e8e4df;
  --color-muted: #141619;
  --color-muted-foreground: #8a8691;
  --color-card: #141619;
  --color-card-foreground: #e8e4df;

  /* Primary: Amber */
  --color-primary: #e09f3e;
  --color-primary-foreground: #0c0e12;

  /* Secondary */
  --color-secondary: #1a1d22;
  --color-secondary-foreground: #e8e4df;
  --color-accent: #5bb5a2;
  --color-accent-foreground: #0c0e12;

  /* Semantic */
  --color-destructive: #f87171;
  --color-input: #2a2d35;
  --color-ring: #e09f3e80;

  /* Radius */
  --radius: 0.5rem;

  /* Fonts */
  --font-display: "DM Serif Text", Georgia, serif;
  --font-body: "Plus Jakarta Sans", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
}
```

**Dark/light mode: there is none.** The app is dark-only by construction. There
is no `.dark` class, no `prefers-color-scheme` query, no `[data-theme]`
attribute anywhere in the package. `use-graph-theme.ts` states it outright:
*"the app is dark-only, so tokens do not change at runtime."* Any Storybook
needs a single dark background; a light/dark toolbar toggle would be a new
feature, not a port.

**Fonts are not bundled.** `theme.css` names `DM Serif Text`, `Plus Jakarta
Sans` and `JetBrains Mono` but ships no `@font-face` and no Google Fonts
import — the deployment shell (`ui-server`'s `index.html`) is expected to load
them. A Storybook must load them itself or fall back to the stacks
(`Georgia, serif` / `system-ui, sans-serif` / `ui-mono`).

**Spacing / radii scale**: none defined beyond `--radius: 0.5rem`, which is
itself never referenced by any component. Components use Tailwind's default
spacing scale and literal radius utilities (`rounded-md`, `rounded-lg`,
`rounded-xl`) plus arbitrary values (`text-[11px]`, `max-h-56`,
`shadow-[0_0_0_1px_rgba(91,181,162,0.08)]`). Font family is applied via
`font-[family-name:var(--font-mono)]` throughout — that arbitrary-property form
is the house idiom for mono text.

**Color ramps**: no numeric ramps (`--color-primary-500` etc.). The palette is
flat and role-named. Components reach for Tailwind's built-in palette for a few
semantic accents that have no token: `red-500/10`, `red-400/70`, `red-200/90`,
`emerald-500/10`, `emerald-400/70`, `emerald-200/90` (diff rows),
`amber-400/25`, `amber-100` (grep match highlight), `amber-400` (risk hints).

#### Non-`@theme` CSS in `theme.css` (component styles that ship with the theme)

| Selector / keyframe | What it is |
|---|---|
| `.filament`, `.filament--active`, `@keyframes filament-scan` | The 1px amber line under the app header; the `--active` variant is a 2s scanning gradient shown while a turn streams |
| `@keyframes breathe` | Pulsing amber glow used inline by streaming/pending indicators (`style={{ animation: "breathe 2s ease-in-out infinite" }}`) |
| `.whatsup-briefing` + `h2` + `.entity-co/-p/-proj/-ev/-d/-st/-f` | The "what's up" briefing prose style with per-entity-type color coding (company `#67b8e3`, person `#5bb5a2`, project `#b197d4`, event `#e09f3e`, date `#67b8e3`, status `#eab354`, file `#8a8691` mono) |
| `.brain-prose` (~20 rules) | The unified markdown style: `h1`–`h4`, `p`, `strong`/`em`, `a`, `ul`/`ol`/`li` (accent `::marker`), `table`/`thead th`/`tbody td`, inline `code`, `pre`, `.mermaid-figure`, `blockquote`, `hr`, `img`. All hard-coded hex, not tokens. |
| `.brain-file-link`, `.brain-file-link--dir` | Dotted-underline mono file references; dir variant uses primary amber |
| `.brain-wiki-link::before` (`↗`), `.brain-wiki-link--unresolved` (`✗`) | Wikilink cues |
| `@keyframes brain-tree-flash`, `.brain-tree-highlight` | 1.6s flash when `openDir()` navigates the file tree |
| `.composer-grow`, `.composer-grow::after`, `.composer-grow > textarea` | Auto-growing textarea via a one-cell grid and a hidden `::after` mirror (`content: attr(data-value)`), deliberately avoiding a `scrollHeight` read per keystroke. **The mirror and the textarea must agree on every box/typography value.** |
| `.chat-message-body` | `content-visibility: auto; contain-intrinsic-size: auto 6rem` — offscreen transcript skipping. Scoped to the message body, never the whole message, because paint containment would clip the share dropdown. |

---

## 2. Component inventory

All paths relative to `packages/ui-react/src/`. "Store-coupled" = calls a
zustand hook directly; "pure" = every input arrives as a prop.

### `components/activity/`

| File | Export(s) | Props (verbatim) | Stores | Renders |
|---|---|---|---|---|
| `activity-page.tsx` | `ActivityPage` | `()` | `useActivityStore`, `useChatStore`, `useUIStore` | Full screen. Index of all agent activity: live runs, history, cost/token rollups. Deep-links a session run back to chat, a subagent into the drill-in stack. |
| `activity-rollups.tsx` | `RollupCards` | `{ rollups: ActivityRollups }` | — (**pure**) | Today/week/month cost + token rollup cards; resolves "today" in the server's tz |
| `activity-run-detail.tsx` | `RunDetail` | `{ runId: string; onBack: () => void }` | `useActivityStore` | Chat-less (cron) run detail: rollup header, span tree with usage/attributes/events, raw-trace escape hatch |
| `activity-run-list.tsx` | `LiveRow`, `RunRow` | `LiveRow: { span: ActivitySpan; onOpen: (row: { runId: string; origin: string; sessionId?: string \| null }) => void }`<br>`RunRow: { run: ActivityRunSummary; onOpen: (row: ActivityRunSummary) => void }` | `useActivityStore` (LiveRow only; `RunRow` is **pure**) | One row per live/historic run |
| `digest-card.tsx` | `DigestCard` | `()` | `useUIStore` | "While you were away" card, shown proactively on app open; dismissal persists server-side |
| `push-toggle.tsx` | `PushToggle` | `()` | — (local state + `lib/push-registration`) | Three-state push control (granted / default / blocked-in-site-settings), disabled-with-explanation where the platform has no push |
| `span-bits.tsx` | `SpanStatusDot`, `SpanPayload`, `SpanEventBlock`, `CountBadge` + pure helpers `spanToolLabel`, `eventTypeLabel`, `formatSpanUsage`, `formatEffectiveCost`, `formatAggregateCost`, `runCostText`, `digestCostClause` | `SpanStatusDot: { span?: ActivitySpan; outcome?: ActivitySpanOutcome \| string \| null; running?: boolean; className?: string }`<br>`SpanPayload: { spanId: string }`<br>`SpanEventBlock: { event: ActivitySpanEvent }`<br>`CountBadge: { count: number; className?: string }` | `useActivityStore` (`SpanPayload` only) | THE status-dot outcome→color mapping shared by every activity surface. `SpanStatusDot`, `SpanEventBlock`, `CountBadge` are **pure**. |

### `components/chat/`

| File | Export(s) | Props (verbatim) | Stores | Renders |
|---|---|---|---|---|
| `ask-user-card.tsx` | `AskUserCard` | `{ requestId: string; questions: AskUserQuestion[]; answered?: Record<string,string>; cancelled?: boolean; live?: boolean; onSubmit: (requestId, answers, annotations?) => void; onCancel: (requestId) => void }` | — (**pure**) | The interactive question card: per-question option lists (single/multi select + "Other" textarea), a markdown preview pane per focused option, and a collapsed one-line summary once answered/dismissed |
| `brain-markdown.tsx` | `BrainMarkdown` (memo), re-exports `DirLink`, `FileLink`, `WikiLink`, `linkifyPaths`, `repoImageSrc` | `{ content: string; className?: string; entityTags?: boolean; fileLinks?: boolean }` | `useFileStore` (`ensureWikilinks`) | The markdown renderer. Splits `<share>` blocks out first, then renders react-markdown with overridden `p/li/strong/em/h1-h4/td/th/code` (text processing), `pre`, `table`, `img` (→`ZoomableImage`), `a` (→`FileLink`/`DirLink`) |
| `brain-markdown-code.tsx` | `MarkdownPre`, `MarkdownTable` | `React.ComponentPropsWithoutRef<"pre"> / <"table">` | — (**pure**) | `pre` that detects a ```mermaid/```mmd fence and swaps in `MermaidBlock`, else a code block with a hover `CopyButton`; `table` in an overflow wrapper |
| `brain-markdown-entities.tsx` | `renderEntityTags`, `renderEntitiesInText`, `processChildText` | functions, not components | — | Unicode-marker entity tagging that survives markdown parsing without `rehypeRaw` |
| `brain-markdown-links.tsx` | `repoImageSrc`, `FileLink`, `WikiLink`, `DirLink`, `renderBarePathsInText`, `linkifyPaths` | `FileLink/DirLink: { path: string; children?: React.ReactNode }`<br>`WikiLink: { target: string; label?: string }` | `useFileStore`, `useUIStore` | Clickable repo file/dir references and `[[wikilinks]]` that open the file panel |
| `brain-markdown-share.ts` | `Segment`, `splitShareBlocks` | function | — (**pure**) | Parses `<share format="…" title="…">…</share>` out of markdown |
| `chat-page.tsx` | `ChatPage` | `()` | `useChatStore`, `useUIStore` | **Full screen.** The chat surface: windowed transcript (40 at a time, "show earlier"), all seven panels, the subagent overlay, mask editor, composer |
| `command-palette.tsx` | `CommandPalette` | `{ filter: string; onSelect: (command: string) => void }` | — (**pure**) | Slash-command list (`/sync`, `/search`, `/whatsup`, `/add`, …) filtered as you type |
| `composer.tsx` | `Composer` | `{ send: (msg: ClientMessage) => void }` | `useChatStore`, `useConnectionStore`, `useProviderStore`, `useVoiceStore` | Everything below the transcript: draft textarea (`.composer-grow`), image attachments, voice review card, provider picker, send/cancel. Owns the draft so keystrokes never reach the message list. |
| `copy-button.tsx` | `CopyButton` | `{ getText: () => string; className?: string }` | — (**pure**) | Hover-revealed copy button; expects a `group` ancestor |
| `markdown-content.tsx` | `MarkdownContent` | `{ content: string }` | — (thin wrapper; `BrainMarkdown` underneath touches `useFileStore`) | `<BrainMarkdown content fileLinks />` — the transcript's markdown entry point |
| `mermaid-block.tsx` | `MermaidBlock` | `{ source: string }` | — (**pure**) | A ```mermaid fence as a diagram. Streaming-safe: raw code block while invalid, debounced re-parse, last-good-SVG on failure, module-wide render cache |
| `mermaid-share.ts` | `buildDiagramShareOptions` | `(source: string, opts?: { filename?: string }) => ShareOption[]` | — | Diagram share options; exports render in the LIGHT theme |
| `mermaid-viewer.tsx` | `MermaidViewer` | `{ svg: string; source: string; onClose: () => void }` | — (**pure**) | Full-screen pan/zoom diagram over `ZoomViewer` |
| `message-bubble.tsx` | `MessageBubble` (memo) | `{ message: ChatMessage; onToolApproval: (toolUseId: string, approved: boolean) => void; onAskUserSubmit: (requestId, answers, annotations?) => void; onAskUserCancel: (requestId: string) => void }` | — (**pure**; memo is load-bearing — all callback props must be stable) | One transcript message. Internally: `UserAttachments`, `groupParts()`, `AssistantContent`, `ThinkingSection` |
| `message-share.ts` | `buildMessageShareOptions` | `({ content, renderedRef })` | — | Share options for an assistant message |
| `renderers/index.ts` | `registerBuiltinRenderers`, `GENERIC_RENDERER` | — | — | Build-time pack registration (see §5) |
| `renderers/claude-tools.tsx` | `claudeToolPack` | — | — | Claude backend renderer pack |
| `renderers/generic.tsx` | `genericToolPack`, `GENERIC_RENDERER` | — | — | Shape-sniffing fallback renderer |
| `renderers/pi-tools.tsx` | `piToolPack` | — | — | pi backend renderer pack |
| `risk-hints.ts` | `isInsideBrainRepo`, `ResolvedSemantics`, `resolveSemantics`, `RiskRule`, `RISK_RULES`, `riskHints` | functions | — (**pure**) | Approval-time advisories (rm -rf, force push, curl\|sh, unsandboxed, writes outside repo) |
| `session-drawer.tsx` | `SessionDrawer` | `{ open: boolean; onClose: () => void; onResume: (sessionId: string) => void }` | `useChatStore` | Session history list grouped by recency, with per-session cost |
| `share-block.tsx` | `ShareBlockFormat`, `ShareBlock` | `{ body: string; format?: ShareBlockFormat; title?: string }` (`ShareBlockProps`, not exported) | — (**pure**) | The `<share>` card: amber-bordered panel, primary share button + `ShareMenu` of the other four formats, markdown body |
| `share-card.tsx` | `ShareIntake` (internal `ShareCard`) | `ShareIntake: ()`<br>`ShareCard: { record: StoredShare; busy: boolean; onConfirm: () => void; onDismiss: () => void }` | `useShareStore` (`ShareIntake`); `ShareCard` is **pure** | System-share-sheet intake card. Security boundary: nothing uploads until the user taps |
| `subagent-view.tsx` | `SubagentView` | `{ spanId: string; onApproval?: (toolUseId: string, approved: boolean) => void }` | `useActivityStore`, `useChatStore`, `useUIStore` | Drill-in of one subagent: span tree + transcript excerpts interleaved by time. Observation-shaped, except approvals are actionable |
| `tool-call-timeline.tsx` | `ToolCallTimeline` | `{ toolCalls: ToolCall[]; onApproval: (toolUseId: string, approved: boolean, always?: boolean) => void; live?: boolean }` | `useActivityStore`, `useChatStore` (backend id), `useUIStore` (push subagent view) | The tool run. See §5 |
| `tool-views.tsx` | `ToolInputView`, `EditDiffView`, `WriteFileView`, `BashCommandView`, `KeyValueView`, `ToolOutputView`, `ClampedPre`, `FileRowsView` + helpers `toRepoRelative`, `formatDuration`, `formatTokenCount`, `countLines`, `getToolIcon`, `getToolLabel`, `getToolSummary`, `getOutputMeta`, `getTouchedFile`, `fenceFor`, `safeSearchRegex`, `splitMatches`, `splitGrepRow`, `parseWebSearchResults` | every view takes `{ tool: ToolCall }` except `ClampedPre: { text: string; isError?: boolean }` and `FileRowsView: { output: string; pattern?: string \| null }` | — (**pure** — `FileLink` inside touches `useFileStore`) | The shared view vocabulary every renderer pack composes |
| `use-chat-commands.ts` | `useChatCommands` | `() => (command: string) => void` | `useChatStore`, `useConnectionStore`, `useUIStore` (all via `getState()`, so the callback is stable) | Slash-command dispatch shared by the palette and the welcome screen |
| `use-markdown-highlight.ts` | `REMARK_PLUGINS`, `useRehypePlugins` | — | — | Hoisted plugin lists; syntax highlighting arrives after first paint |
| `welcome-state.tsx` | `WelcomeState` | `{ onAction: (action: string) => void }` | — (**pure**) | Empty-transcript hero: brain icon, shortcut buttons |

### `components/connectivity/`

| File | Export(s) | Props | Stores | Renders |
|---|---|---|---|---|
| `connection-gate.tsx` | `ConnectionGate` | `{ children: ReactNode }` | `useConnectionStore` (+ owns `useVpnStatus`) | Wraps the app; shows login / VPN-unreachable / connection-limit states instead of children |
| `connection-state.ts` | `REFUSAL_ATTEMPTS`, `CONNECTION_LIMIT_CLOSE_CODE`, `ConnectionIssue`, `deriveConnectionIssue` | `deriveConnectionIssue({ vpnStatus, handshakeFailures, lastCloseCode })` | — (**pure**) | Classification logic only |
| `login-screen.tsx` | `LoginScreen` | `()` | — (local state + `lib/passkeys`) | **Full screen.** Password field always; passkey button when the server reports registered passkeys and WebAuthn is available |

### `components/dev/`

| File | Export(s) | Props | Stores | Renders |
|---|---|---|---|---|
| `share-harness.tsx` | `ShareHarness` | `{ path?: string }` | — | Dev-only stand-in for the system share sheet; posts the same multipart body to the same SW path. Exported from `index.ts`, meant to be gated behind a DEV check by the shell |

### `components/files/`

| File | Export(s) | Props | Stores | Renders |
|---|---|---|---|---|
| `file-panel.tsx` | `FilePanel` | `{ open: boolean; onClose: () => void }` | `useFileStore` | The file-browser slide panel; tree + viewers load on first open |
| `file-tree.tsx` | `FileTree` | `()` | `useFileStore` | Lazy-expanding directory tree with per-extension icons |
| `file-viewer.tsx` | `FileViewer` | `()` | `useFileStore` | Header (path, preview/raw toggle, share menu) + dispatch to the four viewers below |
| `file-viewer-markdown.tsx` | `FileViewerMarkdown` | `{ content: string }` | — (**pure**) | Frontmatter panel + `BrainMarkdown` |
| `file-viewer-html.tsx` | `FileViewerHtml` | `{ content: string }` | — (**pure**) | `<iframe sandbox="" srcDoc={content}>` |
| `file-viewer-raw.tsx` | `FileViewerRaw` | `{ content: string; fileName: string }` | — (**pure**) | Monospace source with wrap toggle + copy |
| `file-viewer-binary.tsx` | `FileViewerBinary` | `{ content: FileContentResponse }` | — (**pure**) | Image / PDF / unknown-binary fallback |
| `frontmatter-panel.tsx` | `FrontmatterPanel` | `{ fields: FrontmatterField[] }` | `useFileStore` (collapse state only) | Collapsible key/value frontmatter table |

### `components/graph/`

| File | Export(s) | Props | Stores | Renders |
|---|---|---|---|---|
| `graph-page.tsx` | `GraphPage` | `()` | `useGraphStore`, `useUIStore` | **Full screen.** Mode tabs (clusters / discovery / local / maintenance) + body dispatch; mounts its own `FilePanel`/`SettingsPanel` copies because `ChatPage` is hidden |
| `graph-canvas.tsx` | `GraphCanvasProps` (exported interface), `default GraphCanvas` | see verbatim block below | — (**pure**) | **The only module importing sigma/graphology.** |
| `graph-canvas-lazy.tsx` | `GraphCanvas` | — | — | `lazy(() => import("./graph-canvas.js"))` — the one code-split boundary |
| `graph-controls.tsx` | `GraphControls` | `()` | `useGraphStore` | Per-mode option forms; floating card on desktop, slide-up sheet on mobile (≥44px targets) |
| `graph-empty-state.tsx` | `GraphEmptyState`, `Mono` | `GraphEmptyState: { icon?: "graph" \| "sync" \| "server" \| "warn"; title: string; children?: ReactNode }`<br>`Mono: { children: ReactNode }` | — (**pure**) | Full-canvas cards for server-too-old / not-computed / fetch-failed / nothing-here |
| `graph-maintenance.tsx` | `MaintenanceBody` | `()` | `useFileStore`, `useGraphStore`, `useUIStore` | Findings list ⇄ type-grouped radial canvas, linked both ways |
| `graph-scene.tsx` | `SceneBody`, `DiscoveryStart` | `()` | `useFileStore`, `useGraphStore`, `useUIStore` | Scene assembly: colors, legends, node/edge styling, refusal above a node ceiling |
| `graph-spinner.tsx` | `CenteredSpinner` | `()` | — (**pure**) | Centered spinner |
| `node-popover.tsx` | `NodePopover` | `{ node: GraphNodePayload; communityLabel?: string \| null }` | `useFileStore`, `useGraphStore`, `useUIStore` | Selected-node detail card docked bottom-left (bottom sheet on phones) |
| `use-graph-theme.ts` | `GraphTheme`, `useGraphTheme` | — | — | Resolves Tailwind tokens to concrete colors — WebGL cannot read CSS vars |
| `lib/graph-helpers.ts` | `buildQuery`, `mergeSubgraphs`, `RadialPoint`, `radialLayout`, `SizeBy`, `nodeSize`, `CATEGORICAL_SLOTS`, `OTHER_COLOR`, `ROOT_COLOR`, `DISTANCE_RAMP`, `mixColors`, `communityColor`, `distanceColor`, `topLevelDir`, `assignFolderColors`, `LegendGroups`, `groupCommunities`, `LabelPolicyInput`, `labelSet`, `matchScene` | functions | — (**pure**, unit-tested) | No sigma, no DOM, no fetch |

`GraphCanvasProps`, verbatim:

```ts
export interface GraphCanvasProps {
  data: GraphSubgraphResponse;
  layout: "fixed" | "radial" | "force";
  selectedId: number | null;
  hoveredId: number | null;
  matchIds: ReadonlySet<number>;
  sizeBy?: SizeBy;
  /** Radial mode: draw this many distance rings (with hop labels) under the graph. */
  rings?: number;
  /** Mode-specific node color (community, distance, …). */
  nodeColor: (node: GraphNodePayload) => string;
  /** Optional per-edge color override (e.g. backlinks into the local center). */
  edgeColor?: (edge: GraphEdgePayload) => string | undefined;
  onSelect: (id: number | null) => void;
  onHover: (id: number | null) => void;
}
```

### `components/images/`

| File | Export(s) | Props (verbatim) | Stores | Renders |
|---|---|---|---|---|
| `image-viewer.tsx` | `ImageViewer` | `{ src: string; alt?: string; filename: string; mime?: string; bytes?: number; onClose: () => void }` | — (**pure**) | Full-screen pan/zoom image over `ZoomViewer` with `maxFitScale: 1` |
| `zoomable-image.tsx` | `ZoomableImage` | `{ src: string; alt?: string; className?: string; mime?: string; bytes?: number; toolbar?: boolean; imgProps?: Omit<React.ComponentPropsWithoutRef<"img">, "src" \| "alt" \| "className"> }` | — (**pure**) | Inline image that opens the zoom viewer on tap |
| `mask-editor.tsx` | `MaskEditor` | `{ onSubmit: (requestId: string, maskPngBase64: string) => void; onCancel: (requestId: string, message: string) => void }` | `useMaskStore` | Paint-over-the-image mask editor; emits a PNG where painted pixels are transparent (OpenAI edit-endpoint convention). Renders nothing unless the agent asked. |
| `image-share.ts` | `buildImageShareOptions` | `(url, filename, opts?: { mime?, bytes? }) => ShareOption[]` | — | Original vs. optimized share actions |

### `components/layout/`

| File | Export(s) | Props (verbatim) | Stores | Renders |
|---|---|---|---|---|
| `app-shell.tsx` | `AppShell` | `{ children: ReactNode }` | `useChatStore` (streaming → filament) | The frame: `SideRail` + filament line + `<main>{children}</main>` + `MobileTabBar` + `OneTimeAgentCredentialDialog` |
| `side-rail.tsx` | `SideRail` | `()` | `useActivityStore`, `useChatStore`, `useConnectionStore`, `useUIStore` | Desktop left rail: view switch, panels, connection dot |
| `mobile-tab-bar.tsx` | `MobileTabBar` | `()` | `useActivityStore`, `useChatStore`, `useUIStore` | Bottom tab bar (`md:hidden`), with a "more" overflow |
| `slide-panel.tsx` | `SlidePanel` | `{ open: boolean; onClose: () => void; title: string; wide?: boolean; children: ReactNode }` | — (**pure**) | The shared sliding panel frame. A closed panel renders no children (the frame stays for the CSS transform) |
| `kbd.tsx` | `Kbd` | `{ children: ReactNode }` | — (**pure**) | A key cap |

### `components/quick-actions/`

All four are panels built on `SlidePanel`, all **pure except where noted**.

| File | Export | Props (verbatim) | Stores | Renders |
|---|---|---|---|---|
| `add-modal.tsx` | `AddPanel` | `{ open: boolean; onClose: () => void }` | — | Quick-capture form (title, type, body, comma-split tags) with `editing/saving/saved/error` states |
| `search-modal.tsx` | `SearchPanel` | `{ open: boolean; onClose: () => void }` | `useFileStore`, `useUIStore` | Debounced (250ms, min 2 chars, 25 results) brain search with snippets; opens results in the file viewer |
| `whatsup-modal.tsx` | `WhatsupPanel` | `{ open: boolean; onClose: () => void }` | — | Streams the briefing into `.whatsup-briefing` prose; abortable |
| `streaming-modal.tsx` | `StreamingPanel` | `{ open: boolean; onClose: () => void; title: string; endpoint: string; method?: string }` | — | Generic streamed-CLI-output panel (used for Brain Sync) |

### `components/settings/`

Every tab takes the same `{ active: boolean }` prop — "this tab is on screen" —
and reloads on becoming visible rather than on mount.

| File | Export | Props (verbatim) | Stores | Renders |
|---|---|---|---|---|
| `settings-panel.tsx` | `SettingsPanel` | `{ open: boolean; onClose: () => void }` | `usePrincipalStore`, `useUIStore` | Panel frame + tab strip (models / skills / security / devices); each tab body is lazily fetched on first open |
| `models-tab.tsx` | `ModelsTab` + pure helpers `createRequestGate`, `nextBillingOverrides`, `nextThinkingOverrides` | `{ active: boolean }` | `useProviderStore` | Server-supplied model roster with visibility, billing-mode and thinking-level overrides. Never hardcodes model names |
| `skills-tab.tsx` | `SkillsTab` | `{ active: boolean }` | — | Create/edit/enable/remove custom skills (written into the brain repo's `.agents/skills/`), plus read-only built-ins |
| `passkey-tab.tsx` | `PasskeyTab` | `{ active: boolean }` | — | Passkey registration/removal + sign out; RP-scoped entries from other hostnames are badged |
| `devices-agents-tab.tsx` | `DevicesAgentsTab` | `{ active: boolean }` | `usePrincipalStore` | Active devices and delegated agents; owner-only mint and revoke |
| `one-time-agent-credential.tsx` | `OneTimeAgentCredentialDialog` | `()` | `usePrincipalStore` | App-level portal for the unrecoverable mint value. **Mounted by `AppShell`, not by the settings panel.** |
| `pi-accounts.tsx` | `PiAccountsSection` | `{ active: boolean }` | `useProviderStore` | pi OAuth device-code sign-in (e.g. ChatGPT Plus/Pro). Renders nothing when the server reports no pi providers |
| `tool-permissions.tsx` | `ToolPermissionsSection` | `{ active: boolean }` | — | The remembered "always allow" grants, revocable. Renders nothing while empty |
| `web-search-settings.tsx` | `WebSearchSection` | `{ active: boolean }` | — | Ordered, cheapest-first provider chain for the pi web extension |

### `components/share/`, `components/viewer/`, `components/voice/`

| File | Export(s) | Props (verbatim) | Stores | Renders |
|---|---|---|---|---|
| `share/share-menu.tsx` | `ShareOption` (interface), `ShareMenu` | `ShareOption: { id: string; label: string; hint?: string; run: () => Promise<boolean> }`<br>`ShareMenuProps: { options: ShareOption[]; title?: string; className?: string; renderTrigger?: (props: { onClick: () => void; busy: boolean; status: Status; icon: React.ReactNode }) => React.ReactNode }` | — (**pure**) | Dropdown of share actions with busy/done/error feedback |
| `viewer/zoom-viewer.tsx` | `ZoomViewerProps`, `ZoomViewer` | `{ children: React.ReactNode; onClose: () => void; actions?: React.ReactNode; refitKey?: unknown; maxFitScale?: number; label?: string }` | — (**pure**) | Hand-rolled pointer-event pan/zoom stage; `touch-action: none` |
| `voice/dictation-sheet.tsx` | `DictationSheet` | `{ open: boolean; onStop: () => void; onCancel: () => void }` | `useVoiceStore` | Live dictation sheet: partial/final transcript, waveform from `audioLevel` |
| `voice/mic-button.tsx` | `MicButton` | `{ active: boolean; disabled?: boolean; onTap: () => void }` | — (**pure**) | The mic toggle |
| `voice/review-card.tsx` | `ReviewCard` | `{ text: string; onSend: () => void; onEdit: () => void; onDiscard: () => void; onAppend: () => void }` | — (**pure**) | Post-dictation review with four actions |

---

## 3. Store coupling

Eleven zustand stores. Ten in `src/stores/`, one in `src/voice/voice-store.ts`.
All are plain `create<T>()` module singletons — **no context provider anywhere**,
so a Storybook decorator cannot inject a mock store; it must `setState()` on the
real one (which is exactly what `render-smoke.test.tsx` already does).

| Store | Key state | Consumed by |
|---|---|---|
| `chat-store.ts` (705 L) | `buffers: Record<string, SessionChat>`, `draft: SessionChat \| null`, `pendingDraftId`, `activeSessionId`, `runStates: Record<string,"streaming"\|"queued"\|"idle">`, `backendIds: Record<string,string>`, `queueNotes`. Selectors `activeChat(state)`, `anyStreaming(state)`. ~30 mutators all keyed by `ChatKey = string \| null`. Persists `activeSessionId` to `localStorage["brain-sessionId"]` | `chat-page`, `composer`, `session-drawer`, `subagent-view`, `tool-call-timeline`, `use-chat-commands`, `app-shell`, `side-rail`, `mobile-tab-bar`, `activity-page` |
| `ui-store.ts` | `activeView: "chat"\|"graph"\|"activity"`, `subagentStack: string[]`, seven `*PanelOpen` booleans, `settingsTab: "models"\|"skills"\|"security"\|"devices"` | `chat-page`, `graph-page`, `graph-scene`, `graph-maintenance`, `node-popover`, `activity-page`, `digest-card`, `side-rail`, `mobile-tab-bar`, `settings-panel`, `search-modal`, `tool-call-timeline`, `subagent-view`, `brain-markdown-links`, `use-chat-commands` |
| `file-store.ts` (392 L) | `dirCache`, `loadingDirs`, `dirErrors`, `expandedDirs`, `currentPath`, `currentContent`, `contentLoading/Error`, `viewMode: "preview"\|"raw"`, `treeExpanded`, `frontmatterCollapsed`, `highlightedDir`, `wikilinkMap/Loaded/Loading`. Exports pure guards `isInternalRepoPath`, `isInternalRepoDir`, `classifyRepoPath`, `normalizeDirPath` | `file-panel`, `file-tree`, `file-viewer`, `frontmatter-panel`, `brain-markdown`, `brain-markdown-links`, `search-modal`, `graph-scene`, `graph-maintenance`, `node-popover` |
| `graph-store.ts` (358 L) | `mode`, `meta`, `metaState`, per-mode params (`local`/`discovery`/`clusters`/`maintenance`), `subgraph`, `findings`, `dataState`, `error`, `sceneQuery`, `clustersSizeBy`, `discoveryColorBy`, `maintenanceFilters`, `selectedId`, `hoveredId`. Module-level LRU `sceneCache` (40) + monotonic request tokens | `graph-page`, `graph-controls`, `graph-scene`, `graph-maintenance`, `node-popover` |
| `activity-store.ts` (+ `-types`, `-helpers`) | `supported`, `subscribed`, `connectionEpoch`, `spans: Record<runId, Record<spanId, ActivitySpan>>`, `events`, `highWater`, `deltaSeq`, `spanRun`, `inbox`. Selectors `spanForTool`, `childSpans`, `runSpans`, `subagentSpans`, `eventsFor`, `timingFor`, … | `activity-page`, `activity-run-detail`, `activity-run-list`, `span-bits`, `tool-call-timeline`, `subagent-view`, `side-rail`, `mobile-tab-bar` |
| `connection-store.ts` | `wsStatus`, `vpnStatus`, `handshakeFailures`, `lastCloseCode`, `socketOpens`, `lastError` | `connection-gate`, `composer`, `side-rail`, `use-chat-commands` |
| `provider-store.ts` | `available: ProviderInfo[]`, `selectedId` (localStorage-backed), `pinnedId`, `backends: Record<string, BackendInfo>`, `loaded` | `composer`, `models-tab`, `pi-accounts` |
| `mask-store.ts` | `request: MaskRequest \| null` (`{ requestId, imagePath, instruction?, turnId? }`) | `mask-editor` |
| `principal-store.ts` | `mintPending`, `mintError`, `oneTimeCredential: MintedAgent \| null` | `devices-agents-tab`, `one-time-agent-credential`, `settings-panel` |
| `share-store.ts` | `queue: StoredShare[]`, `busy`, `error`, `notes: string[]`. Selector `hasPendingShare` | `share-card` |
| `voice/voice-store.ts` | `mode: VoiceMode`, `connecting`, `draining`, `partial`, `finalText`, `audioLevel` (0..1), `reviewText`, `providerId`, `error` | `composer`, `dictation-sheet` |

### Pure / presentational (lift into Storybook as-is)

`AskUserCard`, `MessageBubble`, `ToolCallTimeline`'s view vocabulary
(`ToolInputView`, `EditDiffView`, `WriteFileView`, `BashCommandView`,
`KeyValueView`, `ToolOutputView`, `ClampedPre`, `FileRowsView`), `ShareBlock`,
`ShareCard` (the inner one), `ShareMenu`, `MermaidBlock`, `MermaidViewer`,
`ZoomViewer`, `ZoomableImage`, `ImageViewer`, `CommandPalette`, `WelcomeState`,
`CopyButton`, `Kbd`, `SlidePanel`, `GraphCanvas`, `GraphEmptyState`, `Mono`,
`CenteredSpinner`, `SpanStatusDot`, `SpanEventBlock`, `CountBadge`,
`RollupCards`, `RunRow`, `MicButton`, `ReviewCard`, `FileViewerMarkdown`,
`FileViewerHtml`, `FileViewerRaw`, `FileViewerBinary`, `MarkdownPre`,
`MarkdownTable`, `AddPanel`, `WhatsupPanel`, `StreamingPanel`, `PushToggle`,
`LoginScreen`, `ShareHarness`, the four `{ active }` settings tabs that hold no
store (`SkillsTab`, `PasskeyTab`, `ToolPermissionsSection`, `WebSearchSection`).

Caveat for several of these: they are store-free but **not network-free** —
`AddPanel`, `WhatsupPanel`, `StreamingPanel`, `SkillsTab`, `PasskeyTab`,
`ToolPermissionsSection`, `WebSearchSection`, `LoginScreen`, `PushToggle` all
`fetch` on mount or on action. Stories need MSW or a `fetch` stub.

`BrainMarkdown` / `MarkdownContent` are prop-driven but reach `useFileStore`
for `ensureWikilinks`; with `fileLinks={false}` (the default) that effect
doesn't fire, so plain markdown stories are effectively pure.

### Store-coupled (need a `setState` fixture in the story)

`ChatPage`, `GraphPage`, `ActivityPage`, `AppShell`, `SideRail`,
`MobileTabBar`, `Composer`, `SessionDrawer`, `SubagentView`,
`ToolCallTimeline` (reads `backendIds` + activity spans; degrades gracefully
when both are empty), `ConnectionGate`, `FilePanel`, `FileTree`, `FileViewer`,
`FrontmatterPanel`, `SearchPanel`, `SettingsPanel`, `ModelsTab`,
`DevicesAgentsTab`, `PiAccountsSection`, `OneTimeAgentCredentialDialog`,
`MaskEditor`, `DictationSheet`, `ShareIntake`, `DigestCard`, `GraphControls`,
`GraphScene`/`SceneBody`, `MaintenanceBody`, `NodePopover`, `SpanPayload`,
`LiveRow`, `RunDetail`, `FileLink`/`DirLink`/`WikiLink`.

Two more global inputs a story must set up:
- **`uiConfig`** (`src/config.ts`): a module singleton set once via
  `configureBrainUi()`. `MessageBubble`, `AskUserCard`, `ShareBlock`,
  `Composer`, `LoginScreen` read `appName`/`assistantName`/`shareTitle`/
  `composerPlaceholder`. A Storybook preview must call `configureBrainUi()`
  before the first render or components show the defaults ("Brain UI", "Brain").
- **`apiBase()` / `getWsUrl()`** (`src/lib/backend.ts`), derived from
  `uiConfig.backendUrl`.

---

## 4. Screens and routing

There is **no router dependency**. Navigation is three mechanisms:

1. **`useUIStore.activeView`** (`"chat" | "graph" | "activity"`) is the source
   of truth for which full screen is mounted. The *consuming shell* — not this
   package — does the switch. `index.ts` exports `AppShell`, `ChatPage`,
   `GraphPage`, `ActivityPage` and expects the shell to compose:
   `<ConnectionGate><AppShell>{activeView === "chat" ? <ChatPage/> : …}</AppShell></ConnectionGate>`.
2. **`useHashRoutes()`** (`src/hooks/use-hash-routes.ts`) two-way-syncs
   `window.location.hash` with the stores:
   - `#/files/<path>` → `setFilePanelOpen(true)` + `openFile(path)`
     (trailing slash → `openDir`)
   - `#/graph` (exact) and `#/activity` (**prefix match**, so
     `#/activity/<runId>` push deep links work) → `setActiveView`
   - Store→hash writes use `history.replaceState`. A `syncingFromHash` ref
     suppresses the echo, armed only on a real view change (the comment
     explains the Activity-suffix bug that motivated this).
3. **`useUIStore.subagentStack: string[]`** — the drill-in. `ChatPage` renders
   `<SubagentView spanId={stack.at(-1)} />` in a `fixed inset-0 z-40` overlay
   when the stack is non-empty. `pushSubagentView` / `popSubagentView`.

**Lazy loading** (`src/lazy-pages.tsx`): `GraphPage` and `ActivityPage` are
`React.lazy` wrappers with their **Suspense boundary inside this package** and a
deliberately `null` fallback, so the shell renders `<GraphPage />` unchanged.
`index.ts` re-exports the lazy wrappers, not the real modules. A Storybook that
imports `./components/graph/graph-page.js` directly bypasses the split (which is
what `render-smoke.test.tsx` does).

| Screen | Module | Notes |
|---|---|---|
| `ChatPage` | `components/chat/chat-page.tsx` | The residence. Hosts all seven panels (`SessionDrawer`, `SettingsPanel`, `StreamingPanel`, `WhatsupPanel`, `SearchPanel`, `AddPanel`, `FilePanel`), `MaskEditor`, the subagent overlay, the transcript window and `Composer` |
| `GraphPage` | `components/graph/graph-page.tsx` (lazy) | Mode tabs + `GraphBody`. Mounts its **own** `FilePanel`/`SettingsPanel` copies because ChatPage is unmounted while it's active |
| `ActivityPage` | `components/activity/activity-page.tsx` (lazy) | Live runs, history, rollups, push toggle |
| `LoginScreen` | `components/connectivity/login-screen.tsx` | Rendered by `ConnectionGate` instead of children when the server is in `password` auth mode |
| `SubagentView` | `components/chat/subagent-view.tsx` | Overlay, not a route |
| `SettingsPanel` | `components/settings/settings-panel.tsx` | `SlidePanel` frame, lazily-fetched tab bodies |
| `AppShell` | `components/layout/app-shell.tsx` | Frame only: `SideRail` + filament + `<main>` + `MobileTabBar` + `OneTimeAgentCredentialDialog` |

Responsive strategy: `SideRail` desktop / `MobileTabBar` (`md:hidden`, `<main>`
gets `pb-16 md:pb-0`) mobile. Graph controls become a slide-up sheet below `md`.

---

## 5. In-chat / tool-call rendering — **the extension seam**

### The registry lives in the SDK, not here

`packages/ui-sdk/src/client/renderers.ts` owns the contract. Its header states
the policy explicitly:

> Registration is BUILD-TIME: the client imports renderer packs in its entry
> module (one import line per pack); runtime plugin loading into a compiled PWA
> is deliberately not supported.

```ts
export interface ToolCallView {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  /** Raw input JSON as streamed; absent on history-loaded calls. */
  inputJson?: string;
  status?: "streaming" | "pending_approval" | "approved" | "denied" | "complete";
  startedAt?: number;
  endedAt?: number;
}

export interface ToolSemantics {
  command?(tool: ToolCallView): string | null;
  writePath?(tool: ToolCallView): string | null;
  unsandboxed?(tool: ToolCallView): boolean;
}

export interface ToolRenderer {
  /** string = exact tool name; function = scored predicate (return 0 to pass, higher wins). */
  match: string | ((tool: ToolCallView, backendId: string) => number);
  icon?: ComponentType<{ className?: string }>;
  summary?(tool: ToolCallView): string | null;
  meta?(tool: ToolCallView): string | null;
  label?: string | ((tool: ToolCallView) => string);
  touchedFile?(tool: ToolCallView): string | null;
  subagentRows?: boolean;
  semantics?: ToolSemantics;
  Input?: ComponentType<{ tool: ToolCallView }>;
  Output?: ComponentType<{ tool: ToolCallView }>;
}

export interface RendererPack {
  /** Restrict this pack's exact-name matches to one backend id. */
  backend?: string;
  renderers: ToolRenderer[];
}
```

API: `registerToolRenderers(pack)`, `resolveToolRenderer(tool, backendId)`,
`resetToolRenderers()` (test helper).

### Dispatch, end to end

1. **Stream → store.** `use-websocket.ts` + `websocket-handlers/chat.ts` build
   `ToolCall` objects into `chat-store`'s message `parts`.
2. **Message → groups.** `message-bubble.tsx`'s `groupParts()` walks
   `message.parts`. Consecutive `tool` parts collapse into **one**
   `ToolCallTimeline` run; `thinking` and `text` stay interleaved
   chronologically. **`ask_user` tool parts are pulled out of the timeline
   entirely** (`isAskUserTool(tool.name)`) and each maps in order to its
   `askUserExchanges[n]`, rendering as its own `AskUserCard` at that
   chronological spot. A safety net renders any exchange with no matching tool
   part trailing at the end, so a prompt is never lost.
3. **Backend scoping.** `ToolCallTimeline` reads
   `chatStore.backendIds[activeSessionId] ?? "claude"`.
4. **Registration.** `registerBuiltinRenderers()` is called **during render**,
   at the top of `ToolCallTimeline` — before any effect can run — and is
   idempotent via a module `registered` flag.
5. **Resolution order** (`resolveToolRenderer`):
   backend-scoped exact name → global exact name → highest-scoring predicate →
   `null`, and the timeline then falls back to `GENERIC_RENDERER`.
6. **Composition.** `ToolCallEntry` uses `renderer.icon`, `renderer.label`,
   `renderer.summary(timed)`, `renderer.meta(timed)`, then renders
   `<Input tool={toolCall} />`, risk hints (when pending), the approval
   buttons, and `<Output tool={toolCall} />` behind a `Copy output` button.
   `renderer.subagentRows` adds a live `SubagentEntryRows` line fed by the
   activity stream. `renderer.semantics` feeds `riskHints()`.
   `renderer.touchedFile` feeds the collapsed "N files touched" summary.

Timing note: if the activity stream carries this call's span, server-stamped
timing (`span.waitUntil ?? span.startedAt`, `span.endedAt`) **overrides** the
client stamps, which history-loaded messages don't have at all.

### Tools with a bespoke renderer today

**Claude pack** (`renderers/claude-tools.tsx`, `backend: "claude"`) —
`CLAUDE_TOOL_NAMES`, 13 entries:

`Bash`, `Edit`, `Write`, `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`,
`Agent`, `Skill`, `NotebookEdit`, `LSP`, and
`mcp__brain-ui__get_current_location` (`GET_LOCATION_TOOL_NAME`).

All 13 share one factory: `icon: getToolIcon(name)`, `summary/meta/touchedFile`
from `tool-views.tsx`, and `Input = ToolInputView`, `Output = ToolOutputView`
(both internal `switch (tool.name)` dispatches). Per-tool extras:

```ts
const CLAUDE_TOOL_EXTRAS: Record<string, Partial<ToolRenderer>> = {
  Bash: { semantics: bashSemantics },
  Edit: { semantics: writeSemantics },
  Write: { semantics: writeSemantics },
  NotebookEdit: { semantics: writeSemantics },
  Agent: { subagentRows: true },
};
```

**pi pack** (`renderers/pi-tools.tsx`, `backend: "pi"`) — 8 entries, each
written out individually: `bash`, `read_file`, `write_file`, `edit_file`,
`grep`, `brain_search`, `brain_context`, `brain_add`. They reuse the Claude
icons and the same view components, differing only in field mapping (pi uses
`path` where the views read `file_path`, so `withFilePath()` aliases it).

**Not renderers but special-cased upstream** (`src/lib/tool-names.ts`):
- `mcp__brain-ui__ask_user` (plus the pi bare name `ask_user`) —
  `isAskUserTool()` diverts these to `AskUserCard` before the timeline sees
  them.
- `normalizeToolName()` rewrites the legacy `mcp__brain_ui__` prefix to
  `mcp__brain-ui__` so old transcripts resolve to the same renderers.
- `getToolLabel()` displays `mcp__<server>__<tool>` as just `<tool>`.

### The generic fallback

`renderers/generic.tsx` registers `GENERIC_RENDERER` as a predicate scoring a
constant `0.1` — so it claims any tool no more specific renderer took — and is
also exported for the timeline's explicit `?? GENERIC_RENDERER`. It sniffs
**shape, not name**:

- Input: `{old_string, new_string}` → `EditDiffView`; `{file_path|path, content}`
  → `WriteFileView` (aliasing `path`); `{command|cmd}` → `BashCommandView`;
  else `KeyValueView` (one row per field, strings run through `linkifyPaths`).
- Output: `isError` → `ClampedPre isError`; ripgrep-ish `path:line:content`
  rows (≥ half of the first 20 non-empty lines match `splitGrepRow`) →
  `FileRowsView`; else `ClampedPre`.
- `icon: FileText`, `meta: getOutputMeta`, no summary, no semantics.

Note the fallback still gets risk advisories: `resolveSemantics()` in
`risk-hints.ts` has its own `sniffSemantics()` for renderers that declare none.

### What this means for "LLM-invoked in-chat components"

The seam already exists and is well-shaped, with one hard constraint: **the
pack list is compiled in**. Adding a component means adding an import +
`registerToolRenderers` call in `components/chat/renderers/index.ts`. So a
Storybook-developed in-chat component would be authored as a `ToolRenderer`
with `Input`/`Output` React components taking `{ tool: ToolCallView }` — which
is a clean, fully prop-driven story surface — and then wired into `index.ts`.

Three existing non-registry in-chat surfaces sit *beside* the registry and are
worth knowing when designing new ones:
- `AskUserCard` — diverted by tool name, rendered inline at its chronological
  position, collapses to a one-line summary once answered.
- `<share format="…" title="…">…</share>` — an **inline markdown tag**, not a
  tool call. `splitShareBlocks()` in `brain-markdown-share.ts` parses it out of
  assistant prose and `BrainMarkdown` renders `ShareBlock` for each segment.
  This is the existing precedent for "the model emits markup and the UI renders
  a component".
- ```` ```mermaid ```` fences → `MermaidBlock`, detected in `MarkdownPre`.

`MaskEditor` is a fourth pattern: a store-driven modal (`useMaskStore`) opened
by a server message rather than by a tool call in the transcript.

---

## 6. Existing test setup

`packages/ui-react/package.json`:

```json
"scripts": { "test": "bun test tests --timeout 30000" }
```

Root: `"test": "bun test packages tests --timeout 30000"`. CI runs
`bun run test` (the root script) on Bun `1.3.14`, plus `bunx tsc --noEmit` and
`bun run lint`. Test devDeps: `@happy-dom/global-registrator ^20.11.6`,
`@testing-library/react ^16.3.2`, `@testing-library/dom ^10.4.1`,
`react`/`react-dom` `^19`. **There is no jsdom, no vitest, no jest, no
`bunfig.toml` preload** — `bunfig.toml` only sets `[install] linker = "hoisted"`.

DOM bootstrap: `tests/render/dom.ts`, verbatim body:

```ts
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function unregisterDom(): void {
  if (GlobalRegistrator.isRegistered) {
    void GlobalRegistrator.unregister();
  }
}
```

Its header documents a containment contract that **all render tests live in one
file**:

1. Registration happens at import time (a `beforeAll` is too late — component
   module bodies touch browser globals while they load). The importing file
   must list `import { unregisterDom } from "./dom.js"` **first**.
   Caveat: Bun runs CJS deps during the link phase, before any ESM module body,
   so `@testing-library/dom`'s `screen` binds before the DOM exists. Render
   tests therefore **use the queries returned by `render()`, never `screen`**.
2. The file calls `afterAll(unregisterDom)` to restore pre-registration globals
   before the next test file loads (`bun test` runs everything in one process,
   and lots of code branches on `typeof window`).
3. Because the module cache means step 1 runs once per process, **all render
   tests live in `tests/render/render-smoke.test.tsx`** — a second file
   importing `dom.ts` after unregistration would get no DOM.

`render-smoke.test.tsx` imports `act, cleanup, fireEvent, render, renderHook,
waitFor` from `@testing-library/react`, mounts ~18 components/hooks, seeds
stores by `setState`, and stubs `framer-motion` with a `createMotionElement()`
factory (happy-dom rejects an animation's `finished` promise when a mounted
gate changes branches).

The other ~40 files in `tests/` are non-DOM unit tests of stores, helpers and
the tool renderers (`tool-renderers.test.ts`, `tool-views.test.ts`,
`risk-hints.test.ts`). `tests/registration-on-mount-harness.ts` is a re-export
barrel used to check that registries register on mount.

**Implication for Storybook**: the one-file constraint is a *Bun test-process*
constraint, not a React one. Storybook runs in a real browser and is not
affected. But if Storybook stories are also to be run as tests via
`bun test`, they'd collide with this contract.

---

## 7. Build

Built by the root `scripts/build.ts`, which iterates a hardcoded package list
(`ui-react` is 9th). Per package: `rm -rf dist`, then
`bunx tsc -p packages/<name>/tsconfig.build.json`.

`packages/ui-react/tsconfig.build.json` extends the root tsconfig with
`noEmit: false`, `declaration`, `declarationMap`, `sourceMap`, `outDir: "dist"`,
`rootDir: "src"`, `allowImportingTsExtensions: false`, `types: []`, and
`include: ["src/**/*.ts", "src/**/*.tsx"]`. Root sets `jsx: "react-jsx"`,
`moduleResolution: "bundler"`, `customConditions: ["bun"]`, `strict`.

So: **tsc only. No bundler.** `dist/` is a 1:1 transpiled mirror of `src/` with
`.d.ts` and maps. That's why `exports` can offer `bun → ./src/index.ts` and
`default → ./dist/index.js` from the same source.

The `ui-react` special case in `scripts/build.ts`:

```ts
if (packageName === "ui-react") {
  const cssEntry = resolve(packageDir, "src", "styles.css");
  const cssOut = resolve(distDir, "styles.css");
  const css = Bun.spawn(
    [bunx, "@tailwindcss/cli", "-i", cssEntry, "-o", cssOut, "--minify"],
    { cwd: packageDir, stdout: "inherit", stderr: "inherit" }
  );
  const cssExit = await css.exited;
  if (cssExit !== 0) process.exit(cssExit);

  cpSync(resolve(packageDir, "src", "theme.css"), resolve(distDir, "theme.css"), {
    preserveTimestamps: true,
  });
}
```

Two CSS outputs:
- `dist/styles.css` — `@tailwindcss/cli --minify` over `src/styles.css`, which
  scans `src/` for utility classes. Consumers without a Tailwind build import
  this.
- `dist/theme.css` — `src/theme.css` copied **verbatim**; consumers' own
  Tailwind builds process it. Shipping it from `dist` keeps a dist-only tarball
  working for both export targets.

`prepublishOnly` runs `bun ../../scripts/check-dist.ts`. CI additionally packs
the tarball and smoke-tests `import("@schlessera/brain-ui-react")` under both
Bun and Node on **React 18** (the peer floor), which is the constraint to
respect if Storybook pulls in React-19-only APIs.

**Storybook-relevant**: any Storybook needs its own Tailwind v4 pipeline
mirroring `src/styles.css` — `@import "tailwindcss" source(none)` +
`@source` pointing at both `src/` and the stories directory + `@import
"./theme.css"` — or the utility classes used only in stories won't be emitted.

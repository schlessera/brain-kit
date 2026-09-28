# @schlessera/brain-ui-kit

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

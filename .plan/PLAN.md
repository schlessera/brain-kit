# Brain Kit → Storybook — master plan

**Status file.** Update the checkboxes as work lands. A fresh session should be
able to read this plus `.plan/DECISIONS.md` and continue without re-deriving
anything.

- Decisions and their reasoning: `.plan/DECISIONS.md` (D1-D15, binding)
- Design source on disk: `.plan/FETCH-PROGRESS.md` says where and how
- Research: `.plan/research/{ui-react-inventory,stack-recon,storybook-2026}.md`
- Architecture: `.plan/architecture/state.md`
- Design analysis: `.plan/design/{runtime-to-react,catalog,screens}.md`
  (`runtime-to-react.md` §8 is the authoritative risk list; the summary below
  carries only the risks that change a plan decision)

## The shape of the work

Two steps, as the maintainer framed them:

1. **Build the kit in Storybook** — a new `packages/ui-kit` holding 56
   presentational components ported from the design system, with `.storybook/`
   inside it. Storybook becomes the surface for iterating on design, copy,
   layout and screens.
2. **Rewire the existing packages onto it** — `ui-react` consumes `ui-kit`, and
   the state architecture is reshaped along the way (D5, D13, D15).

Step 1 is where the design risk lives; step 2 is where the regression risk
lives. They are sequenced, not interleaved.

## What we are porting

56 components, one `.dc.html` file each. Every file is three parts: an HTML
template, a `class Component extends DCLogic` whose `renderVals()` returns plain
style objects and data, and a `data-props` JSON block that already describes the
prop table (editor type, default, `tsType`). The design's own README documents
the port:

- `renderVals()` is a pure function of props — copy it into a React component
  body; the objects it returns are already React `style` objects.
- Template → JSX: `{{ x }}` → `{x}`, `<sc-for list>` → `.map()`, `<sc-if>` → `&&`.
- `data-props` maps 1:1 onto Storybook `argTypes` (enum → `select`, range →
  `range`). **This is why the Storybook is cheap: the prop tables already exist.**
- The tone/state maps at the top of each class (`T`, `C`, `S`, `K`) are the only
  colour literals worth hoisting into a shared theme.

### The 56, by group

| Group | Components | Count |
|---|---|---|
| Primitives | Icon, StatusDot, Chip, Label, Meter, Button, Toggle, Surface, Callout, PathRef, DiffBlock | 11 |
| States | Placeholder | 1 |
| Evidence & data | Receipt, TraceSteps, DataTable, BarList, SearchResultCard | 5 |
| Rows & lists | ListRow, ChoiceOption, FileRow, QueueItemRow, FilterRow | 5 |
| Decision surfaces | ActionCard, AskUserCard, ApprovalCard, NotificationCard | 4 |
| Agent & corpus | AgentRunCard, AgentOrbit, LaneChart, GraphView | 4 |
| Chrome | PhoneFrame, ScreenHeader, Composer, TabBar, BottomSheet, MessageBubble | 6 |
| In-chat blocks (§08) | StepList, MapView, TimelineList, ScheduleList, QuoteCard, CodeBlock, LinkPreviewCard, ContactCard, StatTiles, TrendChart, Disclosure, FeedbackRow | 12 |
| Conversation lifecycle (§10) | StreamingAnswer, SuggestionChips, AttachmentRow, InlineToast, ComparisonTable, RelatedFiles, DigestCard, EmptyState | 8 |

The last two groups — **20 components** — are the D3 surface: the shapes an
answer can take inside a transcript. Those are what an LLM will drive by tool
call.

## Porting hazards already identified

Read from the source, not assumed:

1. **`Icon` is imperative, and is the only component whose output does not
   follow from its props.** It emits `<i data-lucide>` and calls
   `window.lucide.createIcons()` on mount, on a 300 ms timer and on every
   update; Lucide *replaces* the `<i>` with an `<svg>` behind React's back. The
   Lucide UMD script arrives through `Icon`'s own `<helmet>`. **Do not port this
   behaviour** — use `lucide-react` components and keep `Icon.tsx` as purely the
   semantic-key → glyph map, which is what the design's own swap instructions
   intend. The React version is strictly better. The map is load-bearing and
   ports verbatim: it is the only place in the kit that names an icon.
   **Counted from source: 77 keys mapping to 75 distinct Lucide glyphs** — two
   pairs are aliases (`dismiss`/`deny` → `x`, `settings`/`filter` →
   `sliders-horizontal`). Keep all 77. They render identically today but mean
   different things, and collapsing them would make a future icon-set swap
   unable to tell them apart. `Icon` is imported by 45 of the 56 components.
2. **`Disclosure` is the one stateful component** (`state = { open: null }`,
   `toggle` calls `setState`), with the idiom "local state unless `open` is
   passed". Port as uncontrolled-with-controlled-override.
3. **No focus or hover states anywhere.** The design says so outright: "the
   mockups are touch-only screens" — it is on its own known-gaps list. We have
   to design these; the design does not contain them. Per D17 that happens in
   wave 1b, not inline during the port, and **a11y is not actually gated in CI
   until that wave lands**. Also: ~17 components attach `onClick` to a plain
   `<div>`/`<span>` and need real button/role semantics.
4. **`PhoneFrame theme="paper"` is the only light surface** and the component
   tones are dark-first. The design's own "known gaps" calls a second tone table
   the port-time work if paper becomes a real theme. This decides whether D9's
   two-theme test matrix is real or collapses to one.
5. **Three components carry real algorithms**, all pure and all needing exact
   ports: `MapView` (Web Mercator projection, graticule on rounded intervals,
   metres-per-pixel scale bar), `AgentOrbit` (polar placement from
   `orbit`/`angle`), `AttachmentRow` (deterministic `Math.sin` waveform, so a
   clip always draws the same shape). None use randomness or `Date.now`.
6. **`prop name` is reserved** by `<dc-import name="…">`, so no component
   exposes a prop called `name` — `FileRow` uses `label`, `AgentRunCard` uses
   `agent`. In React that constraint evaporates, but **keep the design's names**
   so the catalog and the code stay comparable. (Note `AgentRunCard`'s
   `data-props` still declares `name` while `renderVals` reads `p.agent` — a
   real inconsistency in the source; resolve to `agent`.)
7. **Defaults are runtime, not editor-only.** A `data-props` default only seeds
   the Tweaks panel. Where a prop carries content the component cannot be
   understood without, `renderVals()` falls back with `p.x ?? …`. Genuinely
   optional props (`meta`, `badge`, `tag`) stay bare. Preserve that distinction
   exactly — a fallback on an optional prop injects content the caller
   deliberately omitted.
8. **The DC runtime wraps every component in an extra `<div class="sc-host">`,**
   a plain block div with no `display:contents`. So inside a flex column, a
   `<dc-import>` is a *div flex item* whose child is the component root — the
   `flex`, `gap` and `min-height:0` apply to the wrapper, not the component.
   Drop it naively in React and layouts shift. **This is the top layout risk**;
   catalog §11's Weekly review is the test case. Decide once, globally, whether
   ported components render their own root as the flex item or keep a wrapper.
9. **`{{ scalar }}` inside text emits an extra `<span class="sc-interp">`.**
   Harmless for `gap`/`align-items`, not for `flex`, `overflow`,
   `text-overflow` or `white-space` — and seven components interpolate directly
   inside a flex row.
10. **`<helmet>` injects into the live `<head>` per component.** Every one of the
   56 sets `body{margin:0;background:#0c0e12}` there, 13 declare their own
   `@keyframes breathe`, and each carries its own Google Fonts link. `<style>`
   is keyed by component and *not* content-deduped, so all 13 copies land. In
   React this collapses to one global stylesheet owned by no component.
11. **`Disclosure` is uncontrolled after first interaction** —
   `state.open === null ? p.open === true : state.open`, so once toggled the
   `open` prop is ignored forever. `useState(p.open === true)` reproduces it
   exactly. **A Storybook story that flips the `open` arg will look broken, and
   that is the design's behaviour, not a port bug.** Decide deliberately whether
   the React version should instead be controllable (`open` + `onOpenChange`).
12. **DC warns on unresolved holes; React is silent.** `walkText` logs
   `"{{ x }} never resolved — rendered as empty"` once per component+hole, and
   `sc-for` logs a non-array list. That dev signal is worth re-creating —
   required props in TS plus a dev-mode assert covers most of it.
13. **The runtime supports `style-hover=` / `style-before=` and zero kit files
   use it.** Together with the README's "no focus/hover states yet", this
   confirms every interaction state in `ui-kit` is net-new design work rather
   than something to port (see D17 and wave 1b).
14. **Nothing to port from the authoring machinery.** `registry.bump`, `subs`,
   `__reconcileLogic`, streaming, `setStreaming`, `dcUpdate`, `__dcSetProps`,
   the postMessage editor bridge, `sc-shine` and the placeholder system all
   serve the DC editor. `x-import` is unused by every kit file, so **there are
   no third-party React dependencies hiding in the design**.
15. **Four components delegate their loading/empty/error to `Placeholder`**
   (`ActionCard` via `state`, and `QueueItemRow`/`SearchResultCard`/`FileRow`
   via `view`), supplying their own copy, overridable through
   `stateMessage`/`stateDetail`. `Placeholder` must land before them.

## How to tell a port went wrong

Ported components can look right and be wrong. These are the specific tells,
from `.plan/design/runtime-to-react.md` §8 — put each into a story or a test
rather than trusting review:

| Symptom | What it means |
|---|---|
| Icons are empty boxes of the correct size, or a story that swaps `icon` shows the previous glyph | The `<i data-lucide>` was ported instead of replaced with `lucide-react`. DC's 300 ms retry timer papers over a late Lucide load; React has no such window, so this fails loudly — which is better |
| Flipping `Disclosure`'s `open` control after clicking the summary does nothing | Correct, actually — that is DC's behaviour (hazard 11). Decide on purpose whether to keep it |
| A component looks plausible but is short a row | A silently missing array prop. DC logged it; React does not |
| A story renders on white, or a component repaints the whole Storybook page | The `<helmet>` body rule either moved to the preview stylesheet or did not |
| `breathe` animations do not run | The keyframe was centralised but a reference was not |
| A component has a `min-width` or `min-height` nobody can explain | A `hint-size` number was read as design intent. Those are eyeballed editor placeholder sizes and carry no meaning — delete them |
| Two block components in a flex ROW overflow their container | The `sc-host` decision, biting where wave 1 did not look. `width: 100%` on a component root was INERT under DC — the wrapper was the flex item, so the root resolved 100% of a shrink-to-fit box. Without the wrapper it is live, both items claim the whole row, and `flex: none` stops either yielding. NOT a `hint-size` artifact: `hint-size` is dead on a settled render, in the source and measured. Give the row `block={false}` or a `style` of `flex: 1 1 0` |

## Kit-wide constraints, measured

Not porting hazards — properties of the kit as built, which bind anything that
picks a width or a breakpoint later. Each was measured, not derived.

- **The tab bar has a 276px floor.** `TabBar`'s slots expand their hit target
  with `padding: 9px 14px` cancelled by an equal negative margin, so each item
  reaches 14px past its own paint and two neighbours need 28px of clear space
  between their visuals. With `justify-content: space-around` the clear gap is
  `(bar width - content width) / slot count`, so for the five default slots
  (135.08px of content) it reaches 28px at **276px**. Measured at the boundary:
  275px touches at -0.02px, 276px separates at +0.19px. **Below 276px a
  five-slot tab bar steals its own clicks** — the later sibling's invisible
  padding sits on the earlier one's label and wins the hit test, which is the
  `FeedbackRow` bug in a tab bar.

  This is a constraint on the KIT, not a note about one component. D16 says
  mobile-first and fluid, so the smallest supported viewport has to clear it,
  and the floor MOVES: it rises with the slot count and with longer labels. A
  six-slot bar, or a localisation with wider words, needs more than 276. Anyone
  choosing a minimum width or adding a sixth destination should re-measure
  rather than assume 276 still holds. `TabBar.stories.tsx` has both the
  measurement and a story that reproduces the theft at 240px on demand.

- **A story that measures geometry must state its own width** (D28). The
  preview's `layout: "centered"` shrink-wraps `#storybook-root`, and the stage
  is `width: 100%; max-width: <stageWidth>` — so a component that does not force
  a width renders at its CONTENT width and the cap never binds. Measured:
  `LaneChart` renders at 212.23px inside a 244.23px root, not the 360 its
  parameter names. This does not invalidate any earlier assertion, for a
  specific reason recorded in D28.

Dev-mode asserts are worth adding on the array props specifically, since that is
the failure with no visible symptom: `items`, `rows`, `steps`, `tiles`, `groups`,
`columns`, `pins`, `lanes`, `nodes`, `options`, `actions`.

**And measure the laid-out boxes, not just the props.** The `hint-size` row above
is a bug that typechecked, passed every unit test, passed a11y, and came back
IDENTICAL from the DC parity harness — because the harness compares computed
style per node and never asks whether a node fits inside its parent.
`stories/_stage.tsx`'s `overflowing()` is the check that catches it, and it
catches the class rather than the instance: any content wider than its box, and
which element escaped. The desktop catalog's four-button action bar carries four
different `hint-size` widths, so this recurs in a later wave.

## Waves

Each wave leaves the tree green: `bun run test`, `tsc --noEmit`, `bun run lint`.

### Wave 0 — scaffolding
- [x] `packages/ui-kit` created; **added to `scripts/build.ts` AND
      `scripts/publish.ts` in the same commit** (`tests/release-manifest.test.ts`
      asserts both; a package missing from them is silently skipped at release)
- [x] Storybook 10.6.0 + Vite builder + CSF Next, vitest pinned 4.1.11 (D6, D7)
- [x] Tokens: 12 named colours **plus the two load-bearing ones hidden in row
      labels** — `#2a2d35` (border, distinct from the `#1f2229` hairline) and
      `#8a8691` (machine meta). Type scale, radius scale (5·8·11-12·13-14·16-18·
      26·42·999), and the spacing set (2·4·6·8·10·12·14·16·18·20·26 — gaps are
      stated as ranges, deliberately **not** a 4px grid; do not "regularise" it)
- [x] The single `breathe 2s` keyframe defined **once** — the source redeclares
      it in 13 separate component files and relies on runtime dedup
- [x] Colour rule encoded, not just documented: tints are the accent at 4-10%
      alpha, borders at 30-50%, and **ink never comes from alpha** — the ramp
      `#e8e4df` / `#c0bcb5` / `#8a8691` is the only source of ink
- [x] `preview-head.html` loads DM Serif Text / Plus Jakarta Sans / JetBrains
      Mono — Storybook has no deployment shell to do it
- [x] a11y at `test: 'todo'` for now (D17 amends D8 — **this is silent in CI**;
      flipping it to `'error'` is the a11y wave's definition of done);
      `addon-mcp` + `componentsManifest` (D11)
- [x] `scripts/check-kit-purity.ts` lint gate: no zustand, `fetch`, `uiConfig`,
      `localStorage` or `window.location` inside `ui-kit`
- [x] Verify Tailwind emits real utilities by grepping the built CSS, not by a
      green build

### Wave 1 — primitives + Placeholder (12)

**Icon prerequisites, verified 2026-09-15 against the installed packages:**
- `ui-kit` has **no runtime dependencies at all** right now. `lucide-react`
  becomes its first one when `Icon` lands. Add it as a real dependency at
  `^0.460` to match `ui-react`, and re-run `bun test tests/release-manifest.test.ts`.
- The design pins **lucide 0.454.0**; `ui-react` and the installed tree are on
  **lucide-react 0.460.0**. All 77 semantic keys resolve against 0.460 — checked
  by importing `lucide-react` and probing every mapped name, not by reading
  types (a `.d.ts` scan misses the alias exports and gives two false negatives).
- Two of the 77 resolve only through **deprecated aliases**: `more` →
  `more-horizontal` (canonical `Ellipsis`) and `health` → `bar-chart-3`
  (canonical `ChartColumn`). Both work today. Map them to the canonical exports
  so a future lucide major that drops aliases cannot silently blank two icons —
  and keep the design's semantic keys (`more`, `health`) unchanged, since those
  are the kit's vocabulary and only the right-hand side is an implementation
  detail.
- Add a test that every key in the map resolves to a real `lucide-react` export.
  It is three lines and it turns a whole class of silent blank-icon failures
  into a red build.
- [x] Icon (port `SET` verbatim; swap to `lucide-react`), StatusDot, Chip,
      Label, Meter, Button, Toggle, Surface, Callout, PathRef, DiffBlock,
      Placeholder
- [x] Stories per component covering every variant × tone in `data-props`

### Wave 1b — accessibility (blocking prerequisite for step 2, D17) — DONE
Sequenced after the component waves but **before** step 2. Not optional.
- [x] One focus-ring token applied across every interactive component
- [x] Real semantics for the ~17 components that put `onClick` on a plain
      `<div>`/`<span>`: button/role, keyboard activation, accessible name
- [x] Contrast re-check of the ink ramp with axe — the design claims `#8a8691`
      is 5.10:1 on surface and calls it "the floor"; verify rather than trust,
      especially at the 9-10px mono sizes it is used on
- [x] Flip `parameters.a11y.test` to `'error'`, with CI shown failing on a
      seeded violation first so we know the gate is real

### Wave 2 — rows, evidence, decisions (14)
- [x] ListRow, ChoiceOption, FileRow, QueueItemRow, FilterRow
- [x] Receipt, TraceSteps, DataTable, BarList, SearchResultCard
- [x] ActionCard, AskUserCard, ApprovalCard, NotificationCard
- [x] loading/empty/error stories for the four `Placeholder` delegators

### Wave 3 — in-chat blocks (20) ← the D3 surface
- [x] §08: StepList, MapView, TimelineList, ScheduleList, QuoteCard, CodeBlock,
      LinkPreviewCard, ContactCard, StatTiles, TrendChart, Disclosure,
      FeedbackRow
- [x] §10: StreamingAnswer, SuggestionChips, AttachmentRow, InlineToast,
      ComparisonTable, RelatedFiles, DigestCard, EmptyState
- [x] MapView projection verified against known coordinates, not eyeballed

### Wave 4 — agent views + chrome + the first desktop components (13)
- [x] AgentRunCard, AgentOrbit, LaneChart, GraphView
- [x] ScreenHeader, Composer, TabBar, BottomSheet, MessageBubble
- [x] **`ScreenBody` — a component the design does not have.** Every screen
      retypes the same container (`flex:1; min-height:0; overflow:hidden;` plus
      padding and a 9-11 gap). The catalog offers it as no component, so each
      screen is a chance to get it subtly wrong. This is the one addition to the
      component set we make on purpose, and it is why D4's "no more than the
      design" is a scope rule, not a prohibition on fixing an omission
- [x] **SideRail and CommandPalette** — the two desktop components D22 brought
      into the kit. Not in the original wave list, which predates the design
      drop that added them
- [x] PhoneFrame **as a Storybook decorator, not a shipped component** (D16)
- [x] `AgentOrbit`'s polar placement verified numerically, not eyeballed

### Wave 4b — roving tabindex (design-feedback §11)
- [x] `src/internal/roving.ts`: `useRoving` + `focusSibling`, the latter
      replacing four copies of the same DOM walk
- [x] `TabBar`, `SideRail`, `FilterRow` hold their own group's state; the stop
      is last-focused → selected → **first eligible**, and the third clause is
      the one that keeps a group with nothing selected reachable at all
- [x] `ChoiceOption` takes a `tabStop` prop instead, because it is one option
      inside its caller's `radiogroup` and cannot see its siblings.
      `AskUserCard` computes it. Omitting it leaves the option a stop — the
      only safe default for a component that cannot see its group
- [x] Ten tab presses past the navigation became **two**, asserted as a list of
      names in `stories/rules/Keyboard.stories.tsx`
- [x] Four "does not strand the group" stories, each proven by seeding the naive
      implementation
- [x] Fixes a real bug: `FilterRow` fired `items[n]` with an index from the DOM
      walk, which only visits interactive pills
- [ ] `Home` / `End` deliberately NOT added — ARIA recommends them, the design's
      role-and-keys table does not list them, D4 says no more than the design.
      A question for the designer

### Wave 5 — assembly (the acceptance test)
- [x] **Done.** All four screens rebuilt from `ui-kit` alone; the component set
      held — no screen needed a new component. What assembly DID surface was six
      defects in components that each passed their own stories, because a
      component's own stories put it in a container built for it and a screen
      does not. Four were kit bugs and are fixed (`ScreenBody` crushing its
      children; a screen rendering content nobody could reach, and the
      keyboard-unscrollable region that fix exposed; a centred `Button` spilling
      its content; `ActionCard`'s children having no band). Two need the
      designer. `.plan/design-feedback.md` §14
- [x] `tests/screens-are-assembly.test.ts` — the acceptance test as a GATE, over
      the source rather than the DOM: every capitalised JSX tag imported from
      `src/`, every inline style layout-only, no colour literal. Screens 2-4
      inherited it by existing
- [x] `unreachable()` in `stories/_stage.tsx`: a screen may not render more than
      it can reach
- [x] `fixtures/week.ts` for the weekly review, with its own invariants
- [ ] The twenty source screens as stories, grouped by flow
- [x] The **four** assembled screens from catalog §11 rebuilt from `ui-kit`
      alone — Morning digest, Chat answer fully structured, Weekly review, Run
      detail stalled mid-flight. (The kit README says two; the catalog has four.
      Compositions in `.plan/design/catalog.md`.) The design calls these "the
      test that a new surface is assembly work, not design work" — if any needs
      a new component or a one-off style, the component set is wrong and we fix
      the set, not the screen.
- [ ] **Do Weekly review first** — deepest nesting (`PhoneFrame > Surface >
      Meter/BarList`, `PhoneFrame > ActionCard > Button`), so it exercises the
      `sc-host` layout risk hardest
- [ ] §11 predates §10, so none of the four use `SuggestionChips` or
      `InlineToast`. Rebuilt as designed; where §10 components should now appear
      is still open, and is design iteration rather than port work

### Wave 6 — D3 tool contracts
- [x] `ToolComponentContract { name, description, input, payload }` in
      `ui-sdk/src/tool-contracts/`, React-free and server-importable, on its own
      `./tool-contracts` export path and re-exported from `/server` and
      `/client`. The four bridge tools are declared there; the handlers stayed
      in `/server`, so no backend import site moved
- [x] Components typed `z.infer<contract["payload"]>`; `bind(contract, Component)`
      in `ui-react` makes drift a `tsc` error — BOTH directions seeded: a
      component bound to the wrong contract, and a component reading a field
      the payload does not carry
- [x] `z.toJSONSchema(schema, { io: "input" })` moved into the SDK
      (`toolInputJsonSchema`), so both backends advertise the same JSON Schema
      for the same tool rather than each converting its own copy
- [x] `BRAIN_UI_SYSTEM_PROMPT_APPEND` generated from the contract list. The
      contract-to-`SurfaceTools` map is keyed by `BridgeToolName`, so adding a
      contract without deciding how a backend declares it is a `tsc` error —
      seeded and confirmed. Prompt text is byte-identical to before
- [x] `CONTRACT:` commit + `docs/integration-contract.md` in the same commit,
      with the payload table and the rules a consumer may rely on
- [x] The convention is now FOLLOWED, not just described: pi's
      `request_image_mask` serialises its payload into `output` like the other
      payload tools instead of reporting a sentence (and stops dropping `note`).
      `tests/bridge-tools.test.ts` parses every payload tool's real output
      through its contract, on both adapters — seeded by restoring the sentence
- [x] The renderer registry bug D13's verification found: `registerBuiltinRenderers`
      latched behind a module boolean `resetToolRenderers()` could not clear.
      Idempotence moved into the registry (pack identity), which reset clears;
      the registry is also instance-scoped now with a module default. The ASR
      registration had the identical latch and lost it too
- [x] First binding: `get_current_location` → a location card. It closes a real
      gap — the result had a renderer only under Claude's MCP-prefixed name, so
      the same tool on pi rendered as raw JSON, as did a resumed transcript
      carrying the pre-rename prefix. A bound contract registers every spelling,
      globally
- [ ] Nothing renders `ask_user` or `request_image_mask` through their contracts
      yet. `ask_user` is special-cased out of the timeline by `message-bubble`
      and needs the exchange UI rather than a tool card; the mask result is a
      one-line path today. Both are bindings waiting for a component, not for
      machinery

### Wave 6b — MapView coastline geometry (D25)
- [x] Generation script: Overpass → `mapshaper -clip -simplify dp` at 1 px of
      the target render → `[lon,lat]` arrays at 4 dp. Committed and re-runnable,
      run by hand, never in CI. Two traps it hit: Overpass returns its OWN JSON
      and mapshaper rejects it as invalid GeoJSON, and mapshaper writes a bare
      `GeometryCollection` back when the features carry no properties — reading
      only `features` yields zero vertices, silently
- [x] `packages/ui-kit/fixtures/geo/` with the five Mediterranean locations —
      **2,611 vertices, 11.6 KB gzipped**, against D25's predicted 12.6 — and a
      `LICENSE` naming OSM + ODbL
- [x] Attribution in `MapView`'s foot row, as a PROP: the component cannot know
      where a caller's paths came from, so the check that makes forgetting loud
      is in `tests/geo-fixtures.test.ts`
- [x] Roads for Troy, where coastline alone is ambiguous — 134 road lines, drawn
      a step quieter than the coast
- [x] `bun pm pack --dry-run` shows zero fixture files, asserted rather than
      trusted, so the published package stays pure MIT
- [x] **Three MapView bugs the coastline made visible**, all fixed: every
      overlay was positioned at the projected SVG pixel on a drawing that scales
      (30% of the box out on a 232px card); the SVG was letterboxing while the
      projection assumed it filled the box; and `translate(-50%,-50%)` put the
      pin's DOT half a label away from its own coordinate. `.plan/design-feedback.md` §16
- [x] **Fill, for islands.** `MapView` takes a `land` prop drawn as one
      even-odd `<path>` at 6% white. Closed rings only — verified first that
      OSM's land-on-the-left winding holds (**486 of 486 rings CCW** across
      Gozo, Corfu and Ithaca), so viewport closure is tractable rather than the
      inherent trap D25 read it as
- [ ] Fill for MAINLAND still deferred: closing an open shore against the
      viewport is the operation that got 3 of 5 wrong. The winding rule makes it
      a determinate problem now, so this is a contained second step rather than
      a research one
- [ ] `troy` and `messina` were generated before `land` existed and carry no
      `land` key; the loader treats that as "no fill", which is also the right
      answer for a mainland bbox. Regenerate when Overpass is healthy — it was
      returning 504s throughout
- [ ] Pin-label collision needs a design answer: two pins 6 km apart at a 9 km
      span overlap, and a long label clips at phone width

### Wave 7 — visual regression (D10)
- [x] `toMatchScreenshot` against 16 committed baselines, generated and compared
      **only** inside `mcr.microsoft.com/playwright:v1.63.0-noble`. Not a
      precaution: a host-generated baseline compared inside the container did
      not merely differ, it made the matcher retry until the test timed out, so
      the failure did not even look like a visual diff
- [x] **A second Vitest project, not a call inside `play`.** `toMatchScreenshot`
      comes from `@vitest/browser`'s `expect.element`, and the `expect` a story
      imports is `storybook/test`'s, which does not have it; importing `vitest`
      into a story would break `storybook dev`. The visual project imports the
      REAL stories and renders them through CSF Next's `run()`, so a baseline is
      of the story rather than of a copy of it that can drift
- [x] **`expect(...)`, not `expect.element(...)`.** The latter polls, so a
      screenshot that will never match is re-captured until the TEST times out.
      Measured on the same seeded defect: **15.1s reported as "Test timed out"
      with no mismatch count and no diff image, versus 232ms reported as "408
      pixels (ratio 0.01) differ"** naming the expected, actual and diff files
- [x] Subjects are CURATED, and that is a decision: the four screens, the
      components that paint, two dense cards. 536 baselines would be
      unreviewable and would churn on every spacing change, which is how a
      visual suite becomes a rubber stamp
- [x] **A baseline only catches what its story renders** — the same blind spot
      the a11y gate has. Proved on this suite: reintroducing the `GraphView`
      collapse did NOT fail `paints: graph view`, because `Default` now renders
      in a stated-width wrapper. The subject that catches it is the story that
      reproduces the condition, and it is in the set separately
- [x] `scripts/visual.mjs` — ONE file for the local `docker run` and the CI
      step, so they cannot drift. Plain node ESM, the one exception to this
      repo's bun-TypeScript scripts, because the image has no bun and putting
      one in would make the image's pin a lie about what produced the pixels
- [x] **The 536 Storybook tests now run in CI at all.** They did not before:
      only `bun test` ran, so the accessibility gate wave 1b proved with a
      seeded violation was, from the moment it landed, enforced by nobody. The
      same CI job carries both projects
- [x] Both original wave-4 defects re-seeded against the finished suite and
      caught, in under 250ms each, with diff images

### Step 2 — rewire `ui-react` (from `.plan/architecture/state.md`, as amended by D15)
- [x] S1 registry instancing — completed in wave 6, including the renderer
      reset/re-registration bug and the matching ASR registration latch
- [x] S2 root + all 11 store factories, provider hooks, namespaced persistence
      and root-owned caches/registries; StrictMode and side-by-side roots tested
- [x] S3 connection factory closes over its root; delta queues, handlers,
      resync bookkeeping and subscriptions are isolated. Connection leases
      share one socket within a root; release/dispose ignores late callbacks
- [x] S4 api/config injection — independent config/REST factories and explicit
      URL helpers and provider hooks are implemented and tested. Store and
      connection callers migrated. Search, capture, sync and briefing now use
      root services and reject stale completions after root replacement.
      Activity lists/details/digests, device management and tool grants also
      use root services and reject late responses. Skill management and web-search
      settings now isolate drafts and async completions as well. Model catalog
      writes use separate queues per root; pi account flows and polling retain
      their owner. Login and passkey management now use root services and guard
      ceremony stages and late callbacks. Push uses root APIs and guards browser
      steps; gate retry/probe state resets per instance. Media/share uploads,
      exports, URLs and branding now use the root; session/graph lookups
      reject stale results and mask/share UI resets per root
- [x] S5 kit dependency and stylesheet wiring. The kit's stylesheet is split:
      `tokens.css` (values, `color-scheme` switch, keyframe, interaction
      rules — plain CSS) and `theme.css` (imports it, adds the `@theme static`
      scales). `ui-react` imports `tokens.css` only, so the kit's
      `--spacing-2: 2px` never reaches the app's `p-2` — verified on the
      compiled CSS. Dependency and allowed edge added with the first consumer:
      `MobileTabBar` is the kit `TabBar` (More menu stays app-owned). Theme
      preference (system / paper / dark) in the UI store, persisted per root,
      toggled in Settings, written to `<html data-theme>` by `AppShell`
- [x] S6 the six fetch-on-mount splits — `PushSwitch`, `LoginForm`,
      `WebSearchChain`, `PasskeyList`, `SkillsList` + `SkillEditor`, `AddForm`,
      and `StreamingOutput` / `BriefingOutput` for the two streaming panels.
      Every container keeps its guards untouched (`AddPanel`'s epoch,
      `SkillsTab`'s `active`-gated reload, the stream abort controllers); the
      views are assembled from kit `Button` / `Toggle` / `Callout` /
      `Placeholder` / `StatusDot` / `Chip` and have props-only tests beside
      the container tests. Text fields stay native — the kit has no text
      input — and titled icon buttons stay native where the kit has no
      icon-only button
- [x] S7 store-coupled component splits — one directory at a time. Done:
      `files/` (`FileTree` renders `TreeRow`/`FileTreeView` on the kit
      `FileRow`, per-node store subscriptions kept; `FileViewer` renders
      `ViewerToolbar` with a kit `FilterRow` mode switch plus
      `ViewerLoading`/`ViewerError`/`ViewerEmpty`; `FrontmatterPanel` renders
      `FrontmatterChips`, kit `Chip kv` behind a controlled `Disclosure`);
      `activity/` (`LiveRow` renders a `LiveRunCard` — kit `AgentRunCard`
      with the tool strip from the run's child spans; `RunRow` a `HistoryRow`
      on `ListRow plain`; inbox intents an `IntentCard` on `ActionCard`; the
      detail's rollup a `RunRollupReceipt` on `Receipt`; the digest a
      `DigestSummary` on the kit `DigestCard`); `chat/` in part
      (`SessionDrawer` renders `SessionList` — card `ListRow`s with
      `selected` for the session in view and the run state as the value;
      `WelcomeState` is the kit `EmptyState` + `SuggestionChips`;
      `Composer` renders `ComposerView` — the design's field drawn from kit
      `Icon`/`Button`/`Chip`/`Callout` on kit tokens around the app's
      CSS-grown textarea, since the kit `Composer`'s API stops at
      attach/mic/send and the app's field needs camera, stop, recall, the
      provider picker, paste-to-attach and a connection-aware placeholder;
      `MessageBubble` renders `TurnHeader`, `UserTurn` (kit `MessageBubble
      role="user"`), `ThinkingBlock` (kit `Disclosure`, controlled so it
      auto-collapses when the stream ends), `ThinkingIndicator` and
      `AttachmentCount`; the brain turn keeps no bubble and the app's real
      share menu instead of the kit's decorative action row); `graph/`
      (`GraphControls` composes `Field`/`Segmented`/`SwitchRow` from
      `graph-form.tsx` — kit `Label`, `FilterRow`, `Toggle`; `NodePopover`
      renders `NodeCard` on `Surface` + `Chip` + `PathRef` + `Button`; the
      canvas is WebGL and stays); `settings/` remainder (`ToolPermissionsList`
      — grouped `ListRow`s in a `Surface(pad=0)`, tap-to-revoke since the
      kit's trailing action is decorative; `PrincipalList` — a `Surface` per
      device/agent with a kind chip and the timestamp `<dl>` the tests read;
      `AccountsList` — card `ListRow`s with Connect/Disconnect `Button`s and
      the device code in an amber `Callout`; `ModelsCatalogView` — the
      roster with native selects kept for their accessible names, a hidden
      model chipped rather than faded, kit `Refresh`/`Add`/`Callout`s); `layout/` (the desktop `SideRail` on
      the kit's, five destinations with ⌘1–⌘5 and the socket state on the
      wordmark's line, collapsed below 900px per D22; the actions the old
      rail carried — New chat, Sessions, Sync, Whatsup, Search, Add, Stats —
      are a ⌘K `DesktopPalette` on the kit's `CommandPalette`, typed on the
      overlay since the kit's query is display text; the kit gained
      `statusTone` and `null` for `spendPct`/`hint`, so the app draws no
      meter it cannot back and no key that opens nothing). The rail still
      appears at `md` (768px) rather than D22's 480px: every pane keys on
      `md:`, so moving the boundary is a shell-wide change that waits for
      the desktop screens the design has not drawn (Files, Activity,
      Settings)
- [x] S8 AST lint gate rejects internal default-store statics, including
      renamed imports, namespace imports, brackets, destructuring and aliases
- [ ] S9 first real in-chat component end to end
- [x] S10 superseded by D31: no compatibility shim or separate 1.0 removal
      step is required

### Wave 8 — the light theme and the second design drop (D32, D33, D34)
- [x] Second drop imported (`FETCH-PROGRESS.md`); three new digests under
      `design/` (`light.md`, `desktop.md`, catalog §1.1b / §1b / §11.1 notes)
- [x] Every `--bk-*` token is `light-dark(<paper>, <dark>)`; `color-scheme`
      switches it; `[data-theme="light|dark|system"]` is the public attribute
      (D32). `tools/theme/derive-light.ts` generates the light half from the
      design's contract plus one rule per family; `tests/light-theme.test.ts`
      pins both files to it. 55 values are the design's, 264 derived and
      flagged (design-feedback §18)
- [x] `on-fill` / `on-ink-solid` replace every foreground use of `canvas`;
      the count badge takes near-black (§6 resolved); `neutral` is the grey
      accent everywhere and `ink` / `dim` / `edge` are named (D33, §4 resolved);
      `ContactCard` facts take the full set (§2 resolved)
- [x] Hit targets per D34: `FeedbackRow` 46×44 with an inset-shadow hairline,
      `InlineToast` undo 45.65 with a `text-decoration` underline, both
      measured by their stories and both asserting the border is gone (§1
      resolved)
- [x] Storybook: `withThemeByDataAttribute` decorator, dark by default; the
      paper `PhoneFrame` is a real light subtree and its contrast exception is
      gone (§8 resolved); a second Vitest project (`storybook-light`) runs
      every story on paper — D9's matrix, real
- [x] **The light suite found the palette's canvas problem** (design-feedback
      §19): the first light inks were stated against the surface and had no
      headroom on the canvas — 141 stories failed `color-contrast` on paper.
      The design revised five inks the same day; regenerated, and the light
      project runs the full gate: 543 + 543 stories green, one recorded
      exception for stacked same-hue tints (§20)
- [x] Visual baselines regenerated in the pinned container after the drop
      (count-badge ink, thumb hairline, `neutral` values, the three-tile
      digest, the red/gold facts); the four screens gained light baselines
      (`screen-*-light`), and the container runner and CI run the
      `storybook-light` project too
- [x] The two `ContactCard` fixtures §2 weakened are red / gold again, and
      the digest carries three tiles as the catalog now does (§14)
- [x] The app's three-way toggle (system / paper / dark) with a persisted
      choice — landed with S5. The pre-paint inline script is the host's
      (it owns the HTML); `ui-react`'s README gives the one line
- [x] **The fourth drop — the answers** (D35, D36; design-feedback "The
      fourth drop"): dark floor `#9a96a1` (§5), no row opacity (§4), the white
      well and opaque subtitle on a solid button (§7), teal/purple/red for
      stacked tints and all seven dots (§18, §20), toned-`Surface` hover
      confirmed with three paper overrides (§13), `Home`/`End` in every
      roving group and ↑↓ in `FileRow` (§11), `ListRow`'s toggle named by its
      title (§12), MapView clustering with `clusterPx` (§16), `EmptyState`'s
      focusable heading (§10). `contrast.test.ts` asserts §4/§5/§7/§20 as
      resolved; no `knownContrastGap` caller remains; 544 + 544 stories green
      under the full gate; all twenty baselines regenerated in the container
- [ ] D36's app rules — ⌘1–⌘5 and ⌘K landed with the rail (S7 `layout/`);
      still open: focus-scoped `a/d/s`, `j/k`, the Settings off switch for
      single-key shortcuts, focus after a decision — these need the in-chat
      decision list, so they come with S9

## Open questions

- [x] Does the catalog's foundations section introduce a light theme beyond
      `PhoneFrame theme="paper"`? **Not in the first drop; yes in the second.**
      The 2026-08-26 drop had one palette table and twelve dark rows, so D9's
      matrix collapsed to one project. The 2026-09-18 drop shipped
      `Brain Kit Light.dc.html` with the full paper contract, and wave 8 made
      the decorator and the second Vitest project real (D32).
- ~~Mobile-only or desktop?~~ Answered: D16, mobile-first responsive up.

## Wave 0 notes

Everything the research predicted held: Storybook 10.6.0 on the Vite builder,
CSF Next end to end, Bun as the package manager, `@storybook/addon-mcp` needing
its own `storybook add`, and the vitest-4 pin. Four things it did not cover
turned up, and three of them changed a decision.

**1. Stories cannot live inside `src/`, which contradicts the research's
recommended layout.** `tests/dependency-edges.test.ts` refuses any bare
specifier in a package's `src/` that is not a declared runtime dependency —
"tests may lean on devDependencies; src may not" — because `src/` ships in the
tarball. Every story imports `storybook/test`, a devDependency. So stories live
in `packages/ui-kit/stories/`, mirroring `src/` one-for-one, and
`.storybook/main.ts` globs `../stories/**`. Two consequences worth knowing
before wave 1: `packages/*/stories/**` had to be added to the root
`tsconfig.json` include (stories are typechecked — CSF Next's inferred prop
types are most of its value, and a story outside the program gets none), and
stories are automatically excluded from the published tarball, which is the
right outcome anyway. Verified with `bun pm pack --dry-run`: 18 files, no
`stories/`, no `.storybook/`.

**2. A local `storybook build` turns the leakage gate red.** The components
manifest (`storybook-static/manifests/components.json`, which
`features.componentsManifest` exists to produce) records each component's
`definedInFile` as an **absolute** path. On any machine whose home directory is
named after its owner, that is a personal string in the working tree, and the
gate scans untracked files with no exempt directories — so one Storybook build
made `bun run lint` **and** `bun run test` fail, via
`tests/leakage-gate.test.ts`. Fixed by adding `storybook-static` to
`EXCLUDED_DIRS` in `scripts/check-leakage.ts`, alongside `node_modules` and
`dist`: it is build output, which is a different category from the authored
directories the public cut deliberately stopped exempting. Gitignoring it is
not sufficient, because the scan does not read `.gitignore`. Also note for
later: if the Storybook is ever deployed anywhere public, that manifest carries
the builder's home path into the deployment.

**3. Adding a package touches eleven enumerations, not the two the brief
named.** `scripts/build.ts` and `scripts/publish.ts` are the two with a named
guard, but `tests/release-manifest.test.ts` and `tests/dependency-edges.test.ts`
between them also assert: the CI pack loop, the CI smoke-test `file:` override
map, the CI bun import list, the CI node import list, the changesets `fixed`
group, the `README.md` repository-layout block, the `ROADMAP.md` package table,
the prose package COUNT in three separate documents (the word "Thirteen" became
"Fourteen" in `ROADMAP.md`, `CONTRIBUTING.md` and the release skill), the
`ALLOWED_EDGES` table, a `LICENSE` file in the package directory, and a `test`
script carrying `--timeout 30000`. `api-report/ui-kit.txt` needs
`bun run api-report`. All of them are asserted, so none of this is discovered
at release time — but budget for it rather than being surprised.

**4. `oxlint` rejects triple-slash references.** The ambient `declare module
"*.css"` that `.storybook/preview.ts`'s stylesheet import needs cannot be pulled
in with a `reference path` directive. It lives at
`packages/ui-kit/src/css.d.ts` instead, where the root tsconfig's own glob finds
it. `vite/client` would also supply it, at the cost of dragging every Vite
global — `import.meta.env` included — into a program that typechecks all
fourteen packages at once.

Two smaller ones: `vitest.config.ts` must import `./vite.config.ts` **with** the
extension or Vite 8 warns about `configLoader: 'native'`; and an empty `*.mdx`
glob makes Storybook print "No story files found for the specified pattern" on
every run, which is why `stories/Introduction.mdx` exists.

### The commands later waves need

All from `packages/ui-kit`:

```
bun run storybook            # dev server :6006; MCP endpoint at /mcp
bun run build-storybook      # static build into storybook-static/ (gitignored)
bun run test-storybook:ci    # every story: render + play, in real Chromium
bunx playwright install chromium   # once, before the first test run
```

From the repo root, unchanged: `bun run build`, `bun run typecheck`,
`bun run lint`, `bun run test`.

### Verification actually run

- `bun run build` — green; `packages/ui-kit/dist` holds `index.js`,
  `index.d.ts`, `smoke/Smoke.js`, `styles.css`, `theme.css`.
- `bunx tsc --noEmit` — clean, with the story file confirmed inside the program
  (`--listFiles`) and confirmed type-safe: seeding `active: "yes"` produced
  `TS2322: Type 'string' is not assignable to type 'boolean | undefined'`, so
  CSF Next's inference really is flowing.
- `bun run lint` — all six gates clean, including the new one.
- **The purity gate proven to fail**, once per rule: seeded `localStorage`,
  `fetch` and `window.location` in the smoke component (rules 4, 2, 6) and a
  fixture importing `zustand`, `zustand/middleware`, `sessionStorage` and
  `uiConfig` (rules 1, 5, 3). All reported with file, line and symbol, exit 1;
  removed, exit 0. `tests/kit-purity-gate.test.ts` keeps that proof durable
  rather than leaving it in a transcript.
- `bun test tests/release-manifest.test.ts` — 24 pass.
- `bun run test` — 2586 pass, 24 skip, 0 fail.
- `bunx storybook build` — succeeded.
- **The Tailwind trap checked by grep, not by a green build**: 22 of 22
  utilities the smoke component uses are present in `dist/styles.css`
  (`.rounded-card{border-radius:var(--radius-card)}`,
  `.p-14{padding:var(--spacing-14)}`, `.bg-amber-tint{…}`,
  `.animate-breathe{animation:var(--animate-breathe)}` …) and 6 of 6
  spot-checked in the Storybook's own `storybook-static/assets/iframe-*.css`,
  which is a separate Tailwind pass through `@tailwindcss/vite`.
  `@keyframes breathe` appears exactly once. Note the named spacing set really
  does override Tailwind's default scale — `p-14` compiles to 14px, not 3.5rem.
- `bunx vitest run --project=storybook` — 3 tests pass against real Chromium.
  **Proven to have teeth**: changing the play function's accessible name to one
  that does not exist failed the run.
- `bunx storybook dev` — up in 3s; `/index.json` serves the four entries, and
  `POST /mcp` returns the tool list (`stories-preview`, in 10.6's
  `toolset-method` naming), so the agent surface works.
- `bun scripts/check-leakage.ts` — clean (see note 2 for what it caught first).
- `bun scripts/check-dist-types.ts` — ui-kit's consumer type surface is clean.
- `bun pm pack --dry-run` — 18 files, `dist/index.js` present (the shape CI's
  pack job greps for), no stories, no Storybook config.

### Deliberately not done in wave 0

- `@storybook/addon-themes` is registered with no decorator — see the answered
  open question above.
- No viewport globals yet. D16 wants a mobile default plus a desktop story, but
  that is a per-story decision the ported components make; wiring a project-wide
  default before any real component exists would be guessing.
- No `.storybook/vitest.setup.ts` (D12) — confirmed still correct: the 10.6
  scaffold emits no `setupFiles` and the addon applies `setProjectAnnotations`
  itself.
- `Smoke` is scaffolding, not design. Wave 1's first act is to delete it,
  together with `packages/ui-kit/src/smoke/` and
  `packages/ui-kit/stories/smoke/`.

## Fixture world

`packages/ui-kit/fixtures/` — the Odyssey, per D19, scoped per D18. Twelve
TypeScript data modules plus
[`README.md`](../packages/ui-kit/fixtures/README.md), which is the operational
doc; this section records only what exists and what is now guaranteed.

**Modules.** `types.ts` (vocabulary), `time.ts` (the pinned clock),
`people.ts` (16), `places.ts` (20 coordinates + the polylines + three
`MapScene`s), `projects.ts` (1 goal, 4 projects, 5 threads), `notes.ts` (18
documents, six kinds), `events.ts`, `runs.ts`, `actions.ts`, `files.ts`,
`money.ts`, `search.ts`, `index.ts`.

The split between `runs.ts` and `actions.ts` is not in the brief's suggested
list and was added deliberately: Flow I is eight of the twenty screens and six
components that exist only to serve it, and folding its seven action kinds,
six queue states and five empty states into `runs.ts` would have made the
largest module the one nobody could find anything in. `search.ts` likewise —
the design's search screen is one query with three views, so its results,
graph and timeline fixtures have to be answers to the same question and
therefore live together.

**The pinned clock.** `REFERENCE_DATE = 2026-07-12`, the same date
`packages/core/fixtures/corpus/` pins. Sharing it is the point: two "now"s in
one repo is a screenshot and a test disagreeing about what is stale. The
pinned instant is 06:40 on Ogygia (UTC+2), the hour the digest lands.

**D19's day count moved, and it is worth recording why.** The brief's `2,914`
cannot host the two durations Homer states — seven years on Ogygia (2,557
days) plus a full year on Aeaea (365) is 2,922 before any sailing. The world
uses `3,652`: ten years since Troy, which lets both stand, makes "Call
Penelope — overdue by 10 years" arithmetically true of the return leg, and
earns the line the world most wants to say. `journal/day-2914.md` survives as
a real entry from year five on Ogygia.

**Invariants**, all asserted in `packages/ui-kit/tests/fixtures.test.ts` (38
tests):

- *Determinism.* No fixture module contains `Date.now()`, `new Date()`,
  `Math.random(` or `fetch(` — scanned with comments stripped, resolved from
  `import.meta.dir` rather than the cwd, because a cwd-relative glob matches
  nothing and passes by default. All ids hand-written; all times of day are
  literal strings, never `Intl`-formatted.
- *Geography.* Every coordinate was read from the English Wikipedia article
  named in its `source` field via the MediaWiki `prop=coordinates` API, and
  every one is inside the Mediterranean basin. Both polylines are checked
  point by point, which is what catches a `[lat, lon]` transposition — at
  these latitudes the ranges overlap, so a spot check does not.
- *Cross-references.* Ids unique across every table; the link graph closes
  with zero unresolved links and zero orphans (the deliberate opposite of the
  core corpus); a path shared by a person and a note must be the same
  document, same `staleDays`.
- *Ledgers.* 600 men out of Troy in 12 ships, `crewLosses` sums to 600, 1
  survivor; spend bars and daily totals both sum to the week's total;
  `folderCounts` sums to 4,812 and `journal/` holds one entry per day since
  Troy.
- *Coverage.* All 7 `ActionCard` kinds, 6 `QueueItemRow` states, 5
  `EmptyState` variants, 4 run states, 4 attachment kinds, 3 notification
  densities.
- *Reserved identifiers.* 555-01xx phones, `example.com` mail, `.invalid`
  hosts, no IBAN anywhere.

**Typecheck scope changed.** The root `tsconfig.json` `include` did not cover
`packages/*/fixtures/**`, so the fixtures would have been invisible to
`bunx tsc --noEmit`. One line was added — `packages/ui-kit/fixtures/**/*.ts`,
scoped to this package rather than `packages/*/fixtures/**`, which would have
dragged `packages/core/fixtures/corpus/brain.config.ts` into the root
programme and broken D18's zero-churn promise.

**The kit-purity gate stays on `src/` only.** `scripts/check-kit-purity.ts`
enforces D13, a claim about *components*. Widening its glob to `fixtures/`
would conflate that with determinism while still missing the three bans that
actually matter for a fixture, none of which it checks. The fixture test
covers those plus `fetch(`, so the one purity rule that transfers is not lost.

**Not published.** `fixtures/` is absent from the package's `files` array, so
it ships in neither the tarball nor `dist` — same status as `stories/`. If a
consumer ever wants the world for their own demos that becomes a deliberate
decision (and a compatibility surface), not a side effect.

## Wave 1 notes

Twelve components, 92 stories, 80 interaction tests in real Chromium. The port
came out closer to the source than expected — see the parity measurements at
the end, which are the evidence for that claim rather than an impression of it.

### The `sc-host` decision (hazard 8, the top layout risk)

**Ported components render no wrapper. The component's own root element is the
flex or grid item in its parent's layout.** Applied uniformly, no exceptions.

The reasoning. `div.sc-host` was a plain block div, so in DC a component root
inside a flex column was a *block child of a block flex item*. Every `flex`,
`width: 100%` and `boxSizing: border-box` the design wrote on a component root
was therefore inert — decoration on an element that was not the flex item. Drop
the wrapper and those declarations become live, doing exactly what their author
wrote them to do. Reproducing the wrapper would mean shipping a DOM node whose
only purpose is to keep the design's own layout intent switched off.

Three consequences, all of them decided here so no later wave re-litigates them:

1. **`inline-flex` roots blockify.** `Icon`, `StatusDot`, `Chip` and `PathRef`
   declare `display: inline-flex`; as direct flex items they compute to `flex`.
   Measured and confirmed: visually identical, because all four are either
   fixed-size or shrink-wrapped. What *does* change is intrinsic sizing inside a
   flex **column** — DC's block wrapper shrink-wrapped them, a bare flex item
   stretches. The design puts chips in flex rows everywhere, so this does not
   bite in practice; where a column is genuinely wanted the container sets
   `alignItems`, which is what `stories/_stage.tsx` does. **We do not add a
   wrapper to paper over it.**
2. **`hostPositionStyle` has no successor yet.** DC filtered a `style=` on a
   `<dc-import>` down to position/size and put it on the wrapper. When wave 4 or
   5 needs that (`AgentOrbit`'s polar placement is the likely first), the
   component gains a `style` prop merged onto its own root — never a wrapper.
3. **It was verified, not assumed.** `Surface > Meter x2` — the deepest nesting
   wave 1 can build — was rendered in the DC runtime and in the Storybook and
   compared node by node: **15 nodes each, identical on all 37 probed computed
   properties.** The `sc-host` levels vanish and nothing moves.

### Where `renderVals()` did not port cleanly

- **`Icon` was not ported at all, by instruction and on the evidence.** The
  original called `window.lucide.createIcons()` on mount, on a 300 ms timer and
  on every update, letting Lucide replace the `<i>` behind React's back.
  `Icon.tsx` is now the 77-key semantic map plus the sizing box, rendering
  `lucide-react` components. 77 keys, 75 glyphs, both alias pairs kept. `more`
  and `health` are repointed from the deprecated `MoreHorizontal`/`BarChart3`
  to the canonical `Ellipsis`/`ChartColumn`; the semantic keys are unchanged.
  `packages/ui-kit/tests/icon-map.test.ts` asserts every key resolves, and was
  proven to fail when one key was pointed at a non-export.
- **Every colour resolves through a namespaced CSS custom property, with no
  fallback: `var(--bk-amber-ink)`.** Each component
  keeps its own `T`/`C` tone table, still speaking the design's vocabulary
  (`amber`, `teal`, `fg`, `border`, `tint`) — but every value in it comes from
  `src/tokens.ts`, which is the only file in `src/` permitted to contain a
  colour literal.

  The custom property is what makes the light theme possible at all: the design
  routes its paper palette "through custom properties on a `[data-theme]` root",
  and hex baked into JavaScript cannot be switched by an attribute — it would
  need a runtime theme context, which is heavier and worse. The `--bk-` prefix
  is not decoration either: a consumer defining their own `--color-red` would
  otherwise silently restyle the kit.

  **DECIDED, after going both ways: no `var(--bk-x, #fallback)`.** A fallback
  looks free — a consumer who forgets the stylesheet still gets a rendered page
  instead of a colourless one — and the light theme is what makes it expensive.
  With a fallback, that consumer renders in the DARK palette whatever theme they
  asked for: a failure that looks deliberate, survives review, and ships.
  Without one they get no colour at all, which is loud and gets fixed in
  minutes. Between a bug that announces itself and one that does not, take the
  loud one. Two smaller reasons agree: a fallback puts every literal back into
  the component bundle, and it masks a missing stylesheet rather than reporting
  one.

  **The cost is real and is the price of the above:** `styles.css` (or
  `theme.css` into the consumer's own Tailwind build) is MANDATORY, not
  recommended. Documented at the top of `src/index.ts`, `src/tokens.ts` and the
  changeset — that documentation is the mitigation, so do not quietly drop it.

  **Verified, not assumed.** With every stylesheet disabled in a live browser, a
  primary Button's background goes `rgb(224,159,62)` -> `rgba(0,0,0,0)` and its
  ink `rgb(12,14,18)` -> `rgb(0,0,0)`. Nobody ships that page by accident.

  **An accent is three tokens, not one.** `ink` for text, icons and borders;
  `fill` for solid surfaces that take near-black text on top; `mark` for 6-8px
  marks. In the dark theme all three are the same colour, because an accent
  chosen to glow against `#0c0e12` works as all three. On paper they diverge —
  fill-as-text is illegible, ink-as-fill turns the primary button to mud, and
  at dot size a darkened accent reads black. Every call site therefore picks a
  role rather than "the amber one", and `StatusDot` takes `mark`, `Meter`'s
  track takes `fill`, `PathRef` and `Label` take `ink`. Choosing wrong costs
  nothing today and breaks the light theme later, which is the kind of mistake
  worth making impossible early.

  **The alpha ramps are written out, not derived.** An earlier revision derived
  them with `rgb(from var(--color-amber) r g b / 0.1)`, which was wrong twice
  over. First on compatibility: that revision claimed relative colour syntax
  sat inside the browser baseline this package already requires, and it does
  not — Tailwind v4's floor is Chrome 111 / Safari 16.4, while relative colour
  syntax shipped in Chrome 119 and was not fully supported until Chromium 125
  and Safari 18. Small exposure, but this is published CSS in an npm package
  rather than an app we control, and a package should not depend on a feature
  outside its own stated baseline. Second, and worse, on the merits: the
  light theme hand-tunes these — its tints use the *fill* hue at 8-14%, never
  the ink hue, and each accent was tested on its own tinted ground rather than
  on plain surface, so teal and gold both had to come down a notch. A
  derivation produces the wrong value for exactly the cases somebody tuned by
  hand — and since the light theme overrides the derived tokens anyway, "change
  14 base colours and everything follows" does not survive contact with the
  second theme. Three ramps, one per surface, preserving the design's own points
  in the 4-10% / 30-50% band: Chip tints at 9-10% (a small dense mark), Surface
  at 5-6% (a large field), Callout at 6-8%.

  **A token is named for what it is, not where it was first needed.** Most of
  the eighteen hover values turned out to be an existing colour under a second
  name, so they say so — `--bk-button-hover-bg-ghost: var(--bk-color-raised)` —
  and a theme that moves `raised` moves the quiet hovers with it. `primary`
  lifts to a new `--bk-color-amber-lift`, NOT to gold: the two are the same
  value in this palette, but "amber one step up" is what the hover means, and a
  theme that moved gold must not drag the primary button's hover behind it. It
  is the `--bk-color-teal-lift` rename generalised, and free while each has one
  call site. `--bk-hover-surface` was deleted outright, being a second name for
  `raised` — a second name for one colour is how two colours start. A test
  asserts every token that refers to another names one that exists, because an
  undefined reference inside a token renders nothing and the element quietly
  inherits.

  115 tokens in all. `tests/tokens-match-theme.test.ts` pins `tokens.ts` and
  `theme.css` together in **both** directions — a token declared and never
  referenced is as much a defect as one referenced and never declared — and
  refuses a colour literal in any other source file.

  **The light theme is not authored, deliberately.** The names and the dark
  values are what make the next wave a token file rather than 58 component
  edits; `theme.css` carries the `[data-theme="light"]` stub and the design's
  published paper values in a comment beside it.

- **The mono font stack was normalised.** The source spells it
  `'JetBrains Mono',monospace` in some components and
  `'JetBrains Mono',ui-monospace,monospace` in others. One constant now, the
  longer form. Same first family, so nothing renders differently.
- **`PathRef` has unreachable code in the source.** Its `skins` table builds a
  `link` entry via `fg.replace('#','rgba(')`, producing a malformed colour —
  but a separate ternary overrides `link` before the table is consulted, so the
  broken value never rendered. Only the reachable branch is ported.
- **Four props are read by `renderVals()` and absent from `data-props`.**
  `Placeholder`'s `iconSize`/`barHeight`/`gap`/`radius`, plus `Chip.radius`,
  `Chip.fontSize`, `Chip.iconSize`, `Label.metaRight`, `Meter.labelWidth`,
  `Button.radius` and `DiffBlock.radius`. They are real props with no editor
  control; all kept, since dropping them would narrow the API during a port.
- **Two components have a `data-props` default that contradicts their runtime
  fallback.** `Button.size` seeds the editor at `lg` while `renderVals()` falls
  back to `md`; `Meter.variant` seeds `row` while the fallback is the stacked
  `bar`. The fallback is the React default and the `data-props` value is the
  story arg — which is the general rule, but these two are where it is visible.
- **`StatusDot.pulse` has no fallback at all**, so an unset dot does not
  breathe even though `data-props` seeds `true`. Kept bare. A dot that breathes
  when nobody asked says an agent is working.
- **Icon props are typed `IconName`, not `string`.** `data-props` declares
  `string` on six components' `icon` props, and the source's
  `SET[key] || key` passthrough means a raw glyph name worked. That escape
  hatch is exactly what an icon-set swap cannot survive, so it is closed at the
  type level; an unknown key at runtime renders an empty box and warns once.
- **`hint-size`, `hint-placeholder-count`, `hint-placeholder-val` and
  `$preview` are gone**, with nothing traceable to them left behind. All six
  `minWidth`/`minHeight` declarations in `src/` come from `renderVals()`: four
  are `minWidth: 0` flex-shrink enablers, one is the count badge's 15px, one is
  the meter track's height.

### The design drop moved mid-wave, and brought interaction states with it

The kit files were re-fetched after the port was written. Diffed all twelve
against `design-v1`: **nine are byte-identical.** Three moved, and D17 was
reversed for exactly those three — its purpose was to stop us inventing states
the design did not have, and the design now has them.

- **`Icon`** — the `SET` map is unchanged, 77 keys, same glyphs. Everything that
  grew is inside the `<helmet>`: the imperative upgrade path gained a
  `MutationObserver` and a bounded 80-try poll on top of the old 300 ms timer,
  because the icon-set script is injected from the component's own helmet and
  can resolve after any fixed timeout. **The design reached the same conclusion
  the port did** — that the lifecycle approach was unreliable — and solved it
  with more machinery. `lucide-react` makes the problem not exist. No change.
- **`Button`** — hover, pressed and focus; `role="button"`, `tabIndex`,
  `aria-disabled`; a new `disabled` prop; and a per-tone `hovers` table emitted
  as `--hv-bg` / `--hv-bd` / `--hv-fg`. Its `icon` `tsType` also went `string`
  -> `IconName`, which is the tightening this port had already made ahead of it.
  All ported.
- **`Toggle`** — `role="switch"`, `aria-checked`, `tabIndex`, hover, focus, and
  a `style-before` pseudo-element extending the 38x22 visual to a 44x44 hit
  target. All ported.

**Four states, one implementation each**, which is the only reason they stay
consistent across components — so they are CSS rules in `theme.css`, not inline
styles, because a pseudo-class cannot be expressed in a React `style` object at
all. Hover lifts the same surface one step and **never changes the tone** (a
control that looks like something else on hover has lied about what it does);
pressed is `translateY(1px)` plus `brightness(.94)` with no colour change and no
ripple; focus is a 2px **ink** outline at +2 offset, because focus says *where
you are*, not what a thing means; disabled is `opacity .45` plus
`pointer-events: none` plus `aria-disabled`.

`:focus-visible`, never `:focus` — a pointer tap must not leave a ring behind.
The stylesheet is asserted to contain no bare `:focus`.

**The `--hv-*` indirection was kept even though React does not need it.** The
design uses it because its template engine compiles a bound hole to an empty
rule; React has no such constraint. It is kept because it is what lets the hover
palette be tokens like everything else — eighteen of them — instead of a second
stylesheet nobody can theme.

**Every state is gated on a class the component adds only when it was given a
handler.** No `onClick` means no role, no tab stop, no hover and no hit-area
expansion, so a static row never pretends to be clickable. Note the `Button`
source sets `role` and `tabIndex` unconditionally while its own README states
the handler rule outright and `Toggle` follows it; the rule won, and `Static`
and `Decorative` stories assert it. Keyboard activation was added too — Enter
and Space on `Button`, Space on `Toggle`, per the design's own key table —
because a `role="button"` that cannot be operated from the keyboard is worse
than no role at all.

#### The hit target, which is where this gets dangerous

A 44px *target* is not a 44px *box*. The switch stays 38x22 and extends its
target with a transparent `::before` at -11px top and bottom, -3px either side.
The constraint that makes that safe: **expansion per side must be no more than
half the distance to the nearest interactive neighbour** — so a column of
switches needs at least 22px of vertical gap. Get it wrong and a neighbour's
invisible pseudo-element sits on top of your visual and takes the click, because
the later sibling wins the hit test. The design records this happening for real:
`FeedbackRow` briefly recorded thumbs-down for a thumbs-up.

`Toggle.stories.tsx`'s `HitTargets` asserts it with `elementFromPoint` at six
points around each switch's **edges** — centres always pass, and the edges are
where it fails — plus one probe 12px above the paint that must belong to
nothing, so the expansion stops where the design says it stops. **Proven to have
teeth**: narrowing the story's gap from 24px to 14px fails it with
`first bottom-left -> STOLEN`, which is precisely the `FeedbackRow` bug
reproduced.

The expansion is also gated on the handler class, so a decorative switch grows
no invisible target that could steal a real neighbour's click.

One thing the story had to learn: an expanded target near a container edge
reaches outside it, and `elementFromPoint` off the viewport returns `null`. The
story pads its wrapper for that reason, which is a real property of expanded
targets rather than test scaffolding.

#### `Button.disabled` is complete, and that is a correction worth reading

An earlier round ported only the VISUAL half of `disabled` — `opacity .45`,
`cursor: not-allowed`, `pointer-events: none` — while D17 still held states
back, and it was right to flag that as incomplete: a control that looks disabled
with no programmatic signal is exactly the bug an accessibility wave exists to
prevent.

**That is no longer the state.** Porting the interaction states in the same wave
brought the other half with it: `aria-disabled`, `tabIndex={-1}`, and a `role`
for the attribute to sit on. `Disabled` asserts both attributes. So the wave-1b
checklist should NOT carry `disabled` as outstanding — it carries the nine
components that have no states at all, which is a different list.

One nuance the code states and this should too: `aria-disabled` appears only
when a handler was passed, because without one there is no `role="button"` for
it to qualify. A disabled decorative div is a div.

#### Still open, and deliberately not done

- **The other nine components have no interaction states**, because the design
  does not give them any yet. Not extended to them — that is what D17 was
  protecting against.
- **`prefers-reduced-motion` is not implemented.** The design's non-negotiable
  list requires `breathe` to drop to a static dot and skeletons to still bars.
  It needs `StatusDot` and `Placeholder` to animate via a class rather than an
  inline `animation`, which means touching two of the untouched nine. Left for
  the a11y wave along with axe and flipping the gate to `'error'`.
- **Focus offset is +2 everywhere.** The design also specifies -2 on full-width
  rows so overflow cannot clip the ring; no such row exists in this wave.

### What a later wave needs to know

0. **The tone maps are the theming seam.** Wave 2 onward: a component's
   `T`/`C`/`S`/`K` map ports to a `Record<Tone, …>` built from `tokens.ts`, and
   any value it needs that is not already a token becomes one in `theme.css`.
   Pick the accent ROLE the value is doing — `ink` for text and borders, `fill`
   for a solid surface, `mark` for a 6-8px mark — rather than reaching for "the
   amber one"; that choice is invisible in the dark theme and decides whether
   the light one works. Reuse an existing
   `--bk-{chip,surface,callout}-{tint,border}-{tone}` when the source's alpha
   matches; add a named ramp when it does not, and never average two. A colour
   literal in a `.tsx` fails the test, which is the point.

0b. **Interaction states, for a component the design has given them to.** Add
   `.bk-control` (or a new class) rules to `theme.css` — never inline styles,
   which cannot express a pseudo-class — put per-tone values behind
   `--hv-bg`/`--hv-bd`/`--hv-fg` on the element's own style, and gate the class,
   the role, the tab stop and any hit-area expansion on a handler having been
   passed. An expanded hit target needs a matching minimum gap and a test like
   `Toggle`'s; an unbounded one steals a neighbour's clicks.

1. **Components are styled by inline style objects, not Tailwind utilities.**
   `renderVals()` ports verbatim and its output is already a React style object;
   re-expressing the computed geometry (`geo.pad`, percentage fills, `font`
   shorthands with computed sizes) as utilities would have been a rewrite, not
   a port. The consequence for **wave 1b**: inline styles cannot express
   `:focus-visible`, so the focus ring arrives as a `className` on the
   interactive roots plus one rule in the stylesheet. That is additive — no
   component needs converting.
2. **`@theme` had to become `@theme static`, and this was found by grepping the
   built CSS rather than trusting a green build.** Tailwind v4 prunes theme
   variables no generated utility references. Deleting the wave-0 smoke
   component — the only thing in the package using utility classes — silently
   emptied `dist/styles.css` of every design token, leaving preflight alone.
   That export exists for consumers with no Tailwind build, so it would have
   shipped a kit with no palette, no radii and no spacing. Fixed, and
   `tests/theme-tokens.test.ts` now asserts the `static` keyword with the
   reason next to it.
3. **`dist/styles.css` carries a handful of accidental utilities.** Tailwind
   scans `src/` for candidate strings and finds CSS *values* and icon keys —
   `block`, `absolute`, `flex`, `hidden`, `border`, `filter`, `collapse`,
   `break-all`, `ease-in-out`. Harmless, a few hundred bytes, but they are
   generic class names in a published stylesheet and could collide with a
   consumer's own. Worth a decision before 1.0; not worth churning the
   `@source` line the wave-0 token test pins.
4. **Tailwind preflight is a real, if tiny, divergence.** It sets
   `box-sizing: border-box` and `border-style: solid` globally, which the DC
   pages did not. It changes nothing wherever a border width is 0 or a box is
   auto-sized — which is everywhere in wave 1 except `Chip variant="count"`,
   whose fixed 15px box is 2px larger under `content-box`. The kit therefore
   renders very slightly differently for a consumer who imports `styles.css`
   than for one who does not.
5. **Stories carry a `stage` decorator** (`stories/_stage.tsx`) that constrains
   to a phone-ish column by default and widens on
   `parameters.stageWidth`. Every block-level component has a `Wide` story, so
   D16 is a story that fails rather than a claim. Width comes from a parameter
   because `Story.extend()` deep-merges parameters but *concatenates*
   decorators — a second decorator can only wrap the first, never replace it.
6. **Fixture content is inline, not imported.** `packages/ui-kit/fixtures/`
   was still being built while this wave landed and has no entry point yet, so
   the stories use inline Odyssey strings (D19) rather than coupling to a
   module whose shape was moving. **TODO for wave 2: re-point the wave-1
   stories at the fixtures once they settle.** No string anywhere came from the
   design's own mock content, which carries four real brands.
7. **`a11y.test` is still `'todo'` and every component here earns it.**
   `Button`, `Toggle`, `Surface` and `Placeholder`'s retry all attach `onClick`
   to a plain `<div>`/`<span>`, with no focus ring, no keyboard path and no
   accessible name. That is the design, faithfully. The interaction tests are
   deliberately pointer tests, not `userEvent.tab()` tests, so they do not
   quietly assert an accessibility the kit does not have.

### Parity, measured

Four components were rendered side by side in headless Chromium — the real
`.dc.html` running the real DC runtime on one port, the built Storybook on the
other — and compared node by node on 37 computed properties, with `div.sc-host`
and `span.sc-interp` made transparent on the DC side.

| Component | Result |
|---|---|
| `Button` (defaults) | 6 nodes each; identical except preflight `box-sizing`/`border-style` on zero-width borders, the mono-stack normalisation, and `inline-flex` → `flex` on the nested `Icon` (the sc-host decision, visually identical) |
| `Chip` (defaults) | 1 node each; identical but for the same two |
| `Placeholder` (loading) | 5 nodes each; every authored property identical — padding, radius, border, background, gap, the three bar widths, and all three `animation-delay`s |
| `Surface > Meter x2` | 15 nodes each; **identical on every probed property**, including the header's `margin-left: auto` resolving to the same used value |

The remaining differences are all explained and none is a port bug: template
whitespace inside `text`, Tailwind preflight, inherited text defaults on
elements that render no text, and the deliberate font-stack normalisation.

Also verified: `tsc --noEmit` clean; all six lint gates clean; `bun run test`
2752 pass / 24 skip / 0 fail; `bun run build` green; `bunx storybook build` green with
`--color-amber`, `--radius-card`, `--spacing-14`, `--animate-breathe` and
exactly one `@keyframes breathe` present in both the published stylesheet and
the Storybook's own Tailwind pass; `bunx vitest run --project=storybook` 85
pass in real Chromium; `bun scripts/check-leakage.ts` clean;
`bun scripts/check-dist-types.ts` clean; `api-report/ui-kit.txt` regenerated.

## Wave 2 notes

Fourteen components, 133 stories, 218 story tests in real Chromium (wave 1 and 2
together), 156 tokens. Four compositions run through the DC parity harness
came back node-for-node identical, with every difference reducing to one of the
classes wave 1 already documented — the measurements are at the end.

### The rows needed their own interaction class, and that is the design's call

Wave 1 built `.bk-control`. It does not fit a row, and the design says so at two
points rather than one:

- **Focus offset is -2 on a full-width row, +2 on a control.** The README states
  both side by side. The reason is concrete: an outline at +2 on a row that
  fills its container is drawn *outside* the container and clipped by the first
  ancestor with `overflow: hidden` — which, in this kit, is every `Surface`.
- **Pressed is `brightness(.97)` with no transform.** `.bk-control` translates
  1px, which reads as a button taking a press; a whole row nudging down while
  its neighbours hold still reads as the list glitching. `.97` is the design's
  own value, from `ListRow`'s `style-active`.

So `theme.css` gained `.bk-row` (background hover, -2 ring, `.97` pressed) and
`.bk-row-border`, an additive second class for the one row whose hover has to
move a border as well. ChoiceOption is that row, because its rest border is what
tells selected from unselected.

**`FilterRow` takes `.bk-control`, not `.bk-row`** — a filter pill is
control-shaped: it moves all three hover properties and its ring sits outside
it. Two classes, chosen per component by shape rather than by folder.

One place the design is silent and the port is not: four of the five rows spell
no `style-active` at all. The README's states table says every interactive
component ships pressed, so the omission is the file being terse rather than a
statement, and `.bk-row:active` applies to all of them — one implementation per
state per family, which is the rule that keeps four states consistent across
thirty components.

### Roles are not guessable, and three of them need a container this kit had not built

Taken from each source and cross-checked against the README's role-and-keys
table: `ListRow` `button`; `ChoiceOption` `radio` + `aria-checked`; `FileRow`
`treeitem` for a folder and `option` for a file, with `aria-expanded` /
`aria-selected`; `FilterRow` items `tab` + `aria-selected`; `QueueItemRow`,
`SearchResultCard` and `ActionCard` `button`.

Three of those are **container-requiring roles the source never ships the
container for**. A `radio` with no `radiogroup`, a `tab` with no `tablist` and a
`treeitem` with no `tree` each announce neither the set nor the position in it,
and axe flags all three as `aria-required-parent`. Resolved by who owns the
element:

- **`FilterRow` renders its own `role="tablist"`**, because the row element IS
  this component. That is the port finishing the job, not a redesign.
- **`AskUserCard` renders the `radiogroup`**, labelled by its own question via
  `aria-labelledby`, so the group is announced by what it is asking.
- **`FileRow` cannot**, because a tree is the caller's. Its stories supply
  `role="tree"` to show the wrapper a caller owes it. **Outstanding for the
  wave that builds the Files screen.**

### Keyboard

Every `role="button"` takes Enter and Space. The design's table gives `ListRow`
only ⏎, but Space on a button role is a defect a user meets long before they
meet the table, and wave 1 already set the precedent on `Button`.

`ChoiceOption` handles ↑↓ itself, scoped to the nearest `[role="radiogroup"]`
and falling back to its own parent, wrapping at both ends. `FilterRow` handles
←→ across its items, and **activation follows focus** — arrowing through filters
is filtering, so each arrow also fires the pill's callback.

Two keys in the table are deliberately NOT implemented, and neither is an
oversight:

- **`FileRow`'s ←→ to fold.** There is no `onToggle` in the source's prop table
  to route an arrow key to; `kind` is a prop the caller sets. Adding one would
  widen the API during a port. For the Files wave.
- **`ActionCard`'s a / d / s.** The card has one callback and does not know
  which of its children is "allow". The shortcut belongs to whatever renders the
  three buttons.

### The one place this port widens the API, and why

Six components draw a control the source gives no way to operate: the two
buttons on `AskUserCard`, the allow/deny pair on `ApprovalCard`, the action row
on `NotificationCard`, the options inside `AskUserCard`, and the retry
affordance on all four `Placeholder` delegators. In DC those are wired by the
editor. In React they are dead pixels, and `AskUserCard` in particular would
have shipped as a picture of a question.

So each gained the optional callback it needed — `onPrimary` / `onSecondary`,
`onAllow` / `onDeny`, a per-action `onClick`, and `onStateAction`. **Every one is
optional and absent by default, so the rendered result with no callbacks is
byte-identical to the source**, and D20's gating rule does the rest: no handler,
no role, no ring, no tab stop. `onStateAction` is a separate prop rather than a
reuse of `onClick`, because "open this" and "try the fetch again" are different
actions and a callback that means both is a bug waiting for its first caller.

The counter-case, for the line: **`ListRow`'s trailing `Toggle` and `Button` got
nothing.** The row already carries the handler, and a second hit target inside
one row is how `FeedbackRow` recorded thumbs-down for a thumbs-up.

### Tokens: 41 added, and the one that is new in kind

`--bk-hover-veil{,-soft,-firm}` at 3.5% / 3% / 4% white. Four components lift a
*transparent* row on hover and so cannot lift to `raised` — there is no surface
underneath to step up from. Named for what they are rather than for the four
call sites, because the same 3.5% serves `FileRow` and `ActionCard` and two
names for one colour is how two colours start. On paper the veil inverts to
black: one edit, not four.

The three rows whose hover IS `#1a1d22` (`ListRow`, `QueueItemRow`,
`SearchResultCard`) reach for `--bk-color-raised` **directly and get no alias** —
that is the rule that deleted `--bk-hover-surface` in wave 1.

Everything else follows wave 1's family convention. Two reuses worth recording
because they are claims, not conveniences:

- **`FilterRow` reads the CHIP ramp.** A filter pill is a chip — same shape,
  same 40% border, same 10% tint — so it does not mint a second one.
- **`ApprovalCard` reads `surface-border-amber` / `surface-tint-amber`.** Its
  shell is `Surface`'s `bold` emphasis to the value, and "needs a decision" is
  one thing in this kit rather than two.

**`ActionCard` got its own five-tone ramp** (`action-{tint,border-bold,
border-tinted,border-dashed}-*`, 20 tokens) and could not reuse any existing
one: its alphas are uniform across tones (0.05 / 0.4 / 0.35 / 0.45) while
`surface-*` varies per tone (red 0.35, gold 0.45). Matching would have meant
averaging, which wave 1 forbids. Its seven kinds resolve to five accents, so the
ramp is five rows wide, and the names are written out rather than interpolated —
an interpolated token name is a name TypeScript cannot check, and an undefined
custom property renders nothing at all.

**`--bk-ask-head-*` is the one foreground in the kit that comes from alpha** (the
accent at 85%, on a 10px uppercase mono line). It is the design's value and it
is ported, but D21 bans alpha ink in both themes and this is the exception. The
a11y wave should MEASURE it rather than assume it passes.

### Three source quirks, ported as found

- **`Receipt`'s tone table is not the shared one.** Its `neutral` is dim ink,
  not the neutral accent — an unremarkable value in a receipt is still a value
  to read. Its table also carries a `muted` entry nothing reads; dead in the
  source, so not ported.
- **`DataTable` renders flex rows, not a `<table>`.** A screen reader therefore
  gets no row/column relationships. Left alone because changing the element
  changes the layout model, which is a redesign. **For the a11y wave.**
- **`TraceSteps`' output block is a SIBLING of its step row**, so the rail's
  `gap` applies to both. Ported with a `Fragment`, not a wrapper div — a wrapper
  would make the pair one flex item and collapse the gap between them.

### Fixtures, and the brands that had to go

Wave 1's stories used inline strings because `fixtures/` had no entry point yet.
**Every wave-2 story imports the Odyssey world instead** (D19); no story in this
wave contains an inline content string. The wave-1 re-point is still outstanding.

Two components needed their *runtime fallbacks* changed as well, which is a
divergence from the source rather than a story choice: `DataTable`'s and
`SearchResultCard`'s `renderVals()` defaults name real companies and quote their
rates. Replaced with this world's. **The consequence for the parity harness is
that neither can be compared on its defaults** — the two sides now render
different content by design. Every other component's fallback is the source's
verbatim, brands being the only reason to touch one.

### Parity, measured

Four compositions, rendered under the real DC runtime on one port and the built
Storybook on the other, compared node by node on 37 computed properties. The two
deepest in the wave are included, as is each of the two cards that compose four
primitives.

| Composition | Result |
|---|---|
| `ActionCard > Receipt` | 44 nodes each |
| `AskUserCard > ChoiceOption x3 + Button x2` | 34 nodes each |
| `ApprovalCard > DiffBlock + Chip + Button x2` | 24 nodes each |
| `Surface > ListRow x4` | 53 nodes each |

Across all four, every difference reduces to **seven distinct forms**, and all
seven are the classes wave 1 already documented:

```
borderLeftStyle / borderTopStyle: none -> solid      Tailwind preflight
boxSizing:            content-box -> border-box      Tailwind preflight
lineHeight:                  normal -> 24px          Tailwind preflight (html{line-height:1.5})
display:              inline-flex -> flex            the sc-host decision
display:            inline-block -> block            the sc-host decision (StatusDot, Toggle)
fontFamily:   'JetBrains Mono',monospace -> ,ui-monospace,monospace
text:                 template newlines JSX strips
```

**Zero differences in any colour, padding, radius, border width, border colour,
gap, flex, font size, weight, tracking, text-transform, white-space, margin,
overflow, animation, position, text-align, word-break or transition.** That is
the claim the harness exists to make, and it is the evidence for it.

`display: inline-block -> block` is new this wave — `StatusDot` and `Toggle` as
direct flex items — and it is the same cause as `inline-flex`, so wave 1's table
covers it in kind. The throwaway `.dc.html` pages used are in the design drop's
`kit/` as `_p-*.dc.html`; a composition the design has no single file for needs
one, exactly as the harness README says.

### The `sc-host` decision bites in a flex ROW, and `Button` gained a `style` prop

`ApprovalCard` shipped broken and the Storybook showed it: its second button
rendered OUTSIDE the card. `Button` defaults to `block`, which is `width: 100%`
plus `flex: none` — full width, refuses to shrink — so two of them in a flex row
each demand the whole row and the second overflows. `ActionCard`'s `WithButtons`
story had the same shape.

**The cause is the `sc-host` decision, and this needs stating precisely because
the obvious explanation is wrong.** The design's own file passes
`hint-size="50%,36px"` to both buttons, which makes it look as though deleting
that editor-only attribute exposed a latent bug. It did not. Two independent
checks say so:

- **In the source.** `hintToMin()` is reached only through
  `r.htmlStreaming ? hintToMin(...) : void 0`, and `htmlStreaming` is `false` in
  the registry's initial record. On a settled render `hint-size` contributes
  nothing, which is exactly what wave 0 concluded.
- **In the browser.** The DC page's two `div.sc-host` wrappers measure **155px
  and 65px**. If `hint-size` were applied they would carry `min-width: 50%` and
  measure at least 224px. They are content-sized.

What actually happened is this. Under DC the flex items were the `div.sc-host`
WRAPPERS (`flex: 0 1 auto`, shrink-to-fit), and each Button was a block child
INSIDE its wrapper, so `width: 100%` resolved to 100% *of a shrink-to-fit box*
and came out content-sized. The row measured 448px in a 448px container: no
overflow, and no sign of a problem. Wave 1 dropped the wrapper on purpose and
recorded the consequence in general terms, that those declarations "become live,
doing exactly what their author wrote them to do". Here what the author wrote
overflows, **because the author never saw those declarations take effect.**

Wave 1 checked this decision in a flex COLUMN and found it harmless. **Nobody
checked a flex ROW**, and a row is where it bites: two block roots, both
`width: 100%`, neither shrinking.

**This is not a Button problem.** Nearly every block component in the kit
declares `width: 100%` on its root, `Surface`, `Placeholder`, `DiffBlock`,
`Receipt`, `DataTable`, `BarList`, `TraceSteps`, `ChoiceOption`, `ListRow`,
`QueueItemRow`, `SearchResultCard`, `ActionCard`, `AskUserCard`, `ApprovalCard`
and `NotificationCard` among them. Put any two side by side in a flex row and
the same thing happens, and **wave 5's assembly work is where that will recur.**

It typechecked, passed every unit test and every a11y check, and the DC parity
harness called the card IDENTICAL, because the harness compares computed style
per node and never asks whether a node fits inside its parent.

**Two legitimate row shapes, and the kit now expresses both:**

- **Content-sized** — `block={false}`. Already worked, and it is the design's
  own pattern: `AskUserCard` does exactly this, as does the desktop 4-up action
  bar, whose four hints are four DIFFERENT widths, i.e. content-sized by intent.
  `ListRow`, `NotificationCard`, `ContactCard` and `EmptyState` all use it.
- **Even split** — `ApprovalCard`, whose two hints say 50%/50%. `Button` gained
  an optional `style` prop merged last onto its own root, and both buttons pass
  `{ flex: "1 1 0", width: "auto" }`.

  **This is a deliberate divergence from the DC runtime, stated so nobody
  "fixes" it back.** DC rendered those two buttons content-sized, 155px and
  65px, and `block={false}` would have reproduced that exactly. The even split
  was chosen instead because the content-sized render is itself an accident of
  the wrapper: the only statement of intent anyone made is the 50%/50% the
  author saw in their editor, and a wide Allow beside a narrow Deny is the worse
  of the two. The parity run below shows the divergence as one property on two
  nodes, which is what a deliberate difference should look like.

The `style` prop is **the seam wave 1 already set aside** — "`hostPositionStyle`
has no successor yet… the component gains a `style` prop merged onto its own
root, never a wrapper". It was expected to be needed first by `AgentOrbit`'s
polar placement in wave 4; sizing inside a flex row got there first. Taking it
rather than adding a `.bk-actions` class also kept wave 2 out of `theme.css`
while wave 3 was editing it.

`overflowing()` in `stories/_stage.tsx` is the test, and it was **proven to fail
before the fix**: `content is 686px wide inside a 360px box`, `<div>Skip it
overflows the right edge by 326px`. It asserts the class rather than the
instance — any content wider than its box, plus which element escaped — and
`ApprovalCard`'s story also asserts the two widths match to within 1.5px, which
is the other half of what 50%/50% meant.

### What a later wave needs to know

1. **Pick the interaction class by SHAPE, not by folder.** `.bk-control` for
   anything button- or pill-shaped (ring outside, all three hover properties,
   1px press); `.bk-row` for anything that fills its container (ring inside,
   background only, no transform). Add `.bk-row-border` when the rest border
   carries meaning.
2. **A container-requiring role obliges its container.** If the component owns
   the container element, render it and say so. If the caller owns it, show the
   wrapper in a story and record the gap — do not ship a lone `treeitem`.
3. **Every `Static` story is the contract test.** Assert four things at once:
   no role, no `.bk-row`/`.bk-control`, no `[tabindex]`, and no `aria-*` that
   only means something under a role. Querying the class and the attributes
   beats querying the element, which moves when a decorator does.
4. **Four props still need the a11y wave**, all recorded above: `FileRow`'s
   ←→ fold, `ActionCard`'s a/d/s, `DataTable`'s missing table semantics, and
   `--bk-ask-head-*`'s alpha foreground. None is a port bug; all four are the
   design handing work forward.
5. **The `sc-host` decision is not finished being consequential.** Verified in a
   flex column and found harmless; a flex ROW is where it bites, because
   `width: 100%` on a component root became live when the wrapper went. Any row
   holding two block-rooted components needs its children given a shrinking
   `flex`. A wave 5 problem more than a wave 2 one.
6. **Measure boxes, not only props and computed style.** A component can pass
   typecheck, unit tests, a11y and DC parity and still render outside its card.
   Any story with two or more controls in a row owes an `overflowing()` play
   assertion, and any `hint-size` deleted from a control inside a flex row owes
   a look at what the runtime does without it.
7. **`api-report/ui-kit.txt` is a real gate.** `tests/api-surface.test.ts`
   fails on any export added without `bun run api-report`. Wave 1 left the file
   untracked; wave 2 regenerated it. Run it whenever `src/index.ts` changes.

## Wave 3 notes

Twenty components, 133 stories, 361 story tests in real Chromium (waves 1-3
together), 267 tokens. Five components were run through the DC parity harness
and four came back node-for-node identical; the fifth differs by exactly one
node, inside a Lucide glyph. The measurements are at the end.

This is the wave where the design's own numbers stopped being trustworthy in
two places, and both were caught by measuring rather than reading.

### `MapView` is the only component here with real content, and it ports exactly

Everything drawn comes from the coordinates: Web Mercator through `mercY`, a
graticule on rounded intervals chosen by `step()`, label suppression where a
label would collide with the scale bar or the viewport edge, a metres-per-pixel
scale bar snapped to a nice distance, and optional `[lon, lat]` polylines.

**Verified numerically, not visually** (`tests/mapview-projection.test.tsx`, 13
tests). Three levels, and the middle one is the one that matters:

1. `mercY` against the closed form at five latitudes, and the ±85° clamp.
2. **The property that makes it Mercator rather than equirectangular** — the
   local vertical stretch at latitude φ is exactly `1/cos φ`, checked by
   numerical derivative at five latitudes and by the ratio at 60° being exactly
   2. A plain lat/lon plot is visually indistinguishable at this zoom and fails
   this line. That is the "looks plausible and is wrong" failure, made loud.
3. The rendered component, via `renderToStaticMarkup`: where Scylla and
   Charybdis land in pixels (252.887, 96.496 and 77.113, 73.564 at 330x170,
   `spanKm` 9), that the scale bar's 59px really measures the 2 km it claims
   when converted back through metres-per-degree at that latitude, that the
   label flips past 62% of the width, that a polyline is projected
   longitude-first, and that **Troy is north and east of Ithaca in the render**
   — the cheapest check on sign conventions, which a transposed lat/lon or a
   flipped y would otherwise pass everywhere else.

The expected pixel values were computed from the definitions before the
component was run. Two of them were wrong on the first pass and the component
was right, which is the correct direction for that to fail in.

**`paths` is the component's one seam for real geometry, and it is already
enough.** D25 records that `MapView` will eventually draw simplified OSM
coastline, because a graticule and a pin read as a radar screen rather than a
place. That geometry arrives as `[lon, lat]` polylines through this same prop
and this same projection, so **it needs no component API change**: it is fixture
data plus a generation script, scheduled as its own wave. Nothing was built
ahead of it — no `backdrop` prop, no tile layer, no fetch, no attribution line,
and `check-kit-purity.ts` enforces the last of those mechanically. What did
change is that `paths` stopped being decorative, so it is now pinned from both
sides: the `Voyage` story renders the fixtures' fifteen-point voyage route and
its three-point planned leg and asserts both point counts, and
`tests/mapview-projection.test.tsx` checks all fifteen project in order, with
the extreme longitudes and latitudes landing at the right indices and with y
inverted. A polyline silently short of a point is the failure with no visible
symptom.

**The default coordinates changed** — the source pins a real Lisbon venue — and
they changed to Ithaca (38.3647, 20.7202), which is a Wikipedia geotag like
every coordinate in `fixtures/places.ts`. An invented coordinate would draw a
wrong map with a confidently wrong scale bar underneath it, so even the stand-in
content is a real place. The footer's `meta` is `628 km`, the great-circle
distance from Ogygia — where the owner of this brain is this morning — to Vathy,
computed from the two fixture coordinates rather than chosen to look plausible.

### The hit-target measurement, which corrects the design

`FeedbackRow` is the component the bug actually happened to, and its source now
carries the fix inline: a 30x26 visual expanded to "48x44" by a `-9px` inset
pseudo-element, with `gap: 18` because the gap must be at least twice the inset.
Wave 1's `elementFromPoint` edge-probe was reused, and it failed.

**`inset` on an absolutely positioned pseudo-element resolves against the
containing block's PADDING box, not its border box.** A 1px border therefore
eats 1px of the expansion on every side:

| | design's comment | measured |
|---|---|---|
| `FeedbackRow` thumb | 48 x 44 | **46 x 42** |
| `InlineToast` undo | 44 tall | **43.65 tall** |
| `Toggle` (wave 1) | 44 x 44 | 44 x 44 — correct |

`Toggle` is right because its track has no border at all, which is why wave 1
did not find this. **Every expansion on a BORDERED element is short by the
border**, and both of wave 3's land under the design's own 44px floor.

Reported, not fixed, and the maintainer confirmed that call. The two numbers
have to move together: `inset: -10px` would give a true 48x44 but would then
demand `gap >= 20`, and the design's gap is 18 — so a local fix would diverge
from the source's spacing AND break the source's own gap rule at once, and the
original click-theft bug would come back. The stories assert the REAL numbers
(`"46x42"`, `> 43.5 && < 44`), because a test asserting 44 would be asserting
something untrue. **The kit ships slightly under spec with tests saying exactly
by how much**, which means the moment the design moves, the test fails and says
so. Written up for the designer in `.plan/design-feedback.md`.

**The edge probe has teeth, and it is proven here rather than claimed.**
`NarrowGapStealsTheClick` renders the row at `gap: 10` and asserts that a probe
one pixel inside the UP thumb's own right edge is owned by the DOWN thumb. It
asserts the THEFT rather than its absence, so a future change that fixes the
geometry fails the story and has to delete it deliberately. That is the
`FeedbackRow` bug, reproduced on demand.

`gap` is exposed as a prop for exactly that story, and is documented as such.

### `Disclosure`: uncontrolled, and it should probably not stay that way

Ported exactly: `useState(p.open === true)` reproduces
`state.open === null ? p.open === true : state.open`, so `open` seeds the
initial value and is **ignored from the first toggle onward**. Flipping the
control in the Storybook toolbar after clicking the summary does nothing, and
`OpenPropIsSeedOnly` asserts that, so the behaviour is a documented property
rather than something a reader has to discover.

**The recommendation was made and accepted, so it is now built** — D27. Two
concrete cases break without it, both real in this app: a transcript that
re-renders because the server said "expand the trace" cannot expand it, and a
parent rendering several disclosures — the Run-detail screen does — cannot
collapse the others when one opens.

The shape is what makes it safe. Three modes, and **the middle one is the
design's, untouched**: neither prop is uncontrolled; `open` ALONE still seeds
and is still ignored after the first toggle; `open` AND `onOpenChange` together
hand the value to the parent. Gating on the presence of BOTH props is the whole
reason the divergence is cheap — every existing call site passes only `open` and
is bit-for-bit unaffected, and `OpenPropIsSeedOnly` still asserts the design's
behaviour rather than being rewritten to match the new one.

Four stories, one per mode plus `Accordion`. `Controlled` asserts the thing that
is invisible when you get this wrong: a parent that IGNORES the callback gets a
disclosure that does not open, which proves no second source of truth is holding
state alongside the parent's. `Accordion` asserts that opening one of three
collapses the other two — the case the change exists for.

This is the port's ONE deliberate divergence from the DC source, and the rule it
sets is in D27: a divergence must be ADDITIVE and gated on a prop the design
never had, so the design's own behaviour stays the default and stays asserted.

### `aria-live`, and what is deliberately not in the component

`StreamingAnswer`'s phase line and the whole of `InlineToast` carry
`aria-live="polite"`, per the design's non-negotiable list. Both change without
the user doing anything to make them change, and both are otherwise silent.
`polite` rather than `assertive` in both: a phase change must not cut across the
answer being read. The README's Accessibility section now states this, along
with the handler-gating contract and the hit-target measurements above — it
previously still described the package as scaffolding exporting `Smoke`.

`prefers-reduced-motion` is still the a11y wave's, and wave 3 adds four more
animated elements to its list: `StepList`'s current bubble, `StreamingAnswer`'s
caret and skeleton bars, and `InlineToast`'s pending state.

### Interaction states: five components got them, fifteen deliberately did not

The design's latest drop changed exactly five of the twenty — `Disclosure`,
`FeedbackRow`, `SuggestionChips`, `InlineToast`, `RelatedFiles` — and the other
fifteen are byte-identical to `design-v1`. Ported per D20, reusing waves 1-2's
classes and choosing by SHAPE:

- `.bk-control` — `Disclosure`'s summary, `FeedbackRow`'s thumbs,
  `SuggestionChips`' chips, `InlineToast`'s undo. All four are control-shaped:
  ring outside at +2, all three hover properties, a 1px press.
- `.bk-row` — `RelatedFiles`' rows, which fill their container: ring INSIDE at
  -2, background-only hover, `brightness(.97)` with no transform.

Two new hit-expansion classes, `.bk-thumb::before` and `.bk-undo::before`,
alongside wave 1's `.bk-switch::before`. One implementation per state per
family, still.

Three places where the shared implementation differs slightly from what a single
source file wrote, all resolved the way wave 2 resolved the same question — the
file is being terse, and one implementation per state is what keeps thirty
components consistent:

- `SuggestionChips` spells its press `brightness(.95)` with no transform;
  `.bk-control` is `.94` with `translateY(1px)`. The shared one wins.
- `RelatedFiles` and `Disclosure` spell no `style-active` at all; they get their
  family's.
- `SuggestionChips` sets `role` and `tabIndex` unconditionally while the
  README's own handler rule says otherwise. The rule won, as it did on `Button`
  in wave 1. `Static` and `MixedGating` stories assert the gating per item.

**`LinkPreviewCard` and `AttachmentRow` got no states, on purpose.** Both take
an `onClick` and both land it on a plain `<div>` with no role and no tab stop,
which is the source exactly. D17's rule still governs what the design has not
specified, and D17 already lists both among the accessibility wave's work. Each
has a `NoRoleYet` story asserting the absence, so it is a recorded gap rather
than an oversight.

### Brands: eleven had to go, and a twelfth was found in wave 2's output

Eleven of the twenty carry a real brand in their runtime fallback — a real
airline, a real Lisbon venue, a real news site, a real VPN product and a
plausible real person. All eleven were replaced with Odyssey content (D19):
`MapView`, `ContactCard`, `ComparisonTable`, `LinkPreviewCard`, `TimelineList`,
`ScheduleList`, `QuoteCard`, `AttachmentRow`, `EmptyState`, `SuggestionChips`,
`RelatedFiles`.

**`EmptyState`'s `offline` variant is the hard one.** Its copy said the host "is
not answering on Tailscale", and `AGENTS.md` bans tailnets as personal
infrastructure — a rule about the CATEGORY, not the wording, so this variant
could never have shipped verbatim in any form.

**The consequence, as wave 2 recorded it for two components: none of the eleven
can be parity-compared on its defaults**, because the two sides now render
different content by design. The harness can still compare them when both sides
are driven with identical explicit props, which is how `MapView` was measured.

The other nine keep the source's fallback verbatim — `StepList`, `CodeBlock`,
`StatTiles`, `TrendChart`, `Disclosure`, `FeedbackRow`, `StreamingAnswer`,
`InlineToast`, `DigestCard`. They mention a Lisbon workshop, which is a real
city in a file path rather than a brand, and they match waves 1 and 2, which
ship the same content in `Receipt`, `PathRef`, `ApprovalCard` and `ActionCard`.
An earlier pass of this wave replaced all twenty and it was reverted: keeping
nine comparable is worth more than a coherent fallback world, and the rule that
brands are the only reason to touch a fallback stays one rule.

**Worth a decision, once, rather than nine times:** a runtime fallback IS demo
content — it is what renders when a model's tool call omits a field, on exactly
the D3 surface this wave built. If D19 should extend to fallbacks, it should
extend to all of them in one commit, and the kit then loses default-parity
everywhere. That is the maintainer's call and this wave did not make it.

**A brand grep over the whole package now returns nothing** — and it found one
thing wave 2 missed: `TraceSteps`' fallback read a path naming the same
plausible real person. Replaced, with the same consequence for its own default
parity noted in the file.

### Tokens: 112 added, and the one rename

267 tokens now. Everything follows waves 1-2: a family per SURFACE rather than
per call site, nothing averaged, and a value that is already a token says so.
The new families are `map-*` (22, including per-tone pin rings and label
borders), `schedule-tag-border-*`, `quote-tint-*`, `avatar-*`, `trend-bar-*`,
`suggestion-*` (20 — a suggestion chip is the one control whose REST state is
toned, so it needs four values per tone), `attach-thumb-*`, `toast-*`,
`medallion-*`, plus `provenance-border`, `hatch-stripe`, `trend-track`,
`compare-recommended-{head,cell}`, `step-rail-done`,
`step-bubble-tint-current` and a fourth hover veil at 5%.

**`--bk-diff-bg-inset` was renamed `--bk-inset-well-bg`.** It is the darker well
sunk into a card, and wave 3 gave it two more callers (`StepList`'s code line,
`AttachmentRow`'s extract) — a token is named for what it is, not for where it
was first needed, and three call sites is when that stops being theoretical.

**Alpha bytes are rounded to two decimals**, as waves 1-2 rounded theirs
(`c + '0f'` is 15/255 = 0.0588 and the token says 0.06). That was worth
checking rather than assuming, and it checks out: the built stylesheet's
minifier re-encodes them and they come back as the source's OWN hex suffixes —
`rgba(91,181,162,0.06)` -> `#5bb5a20f`, `rgba(177,151,212,0.35)` -> `#b197d459`,
`rgba(224,159,62,0.5)` -> `#e09f3e80`. The rounding is byte-exact.

### Six tone unions were narrowed, and that made the fixtures stricter

`QuoteTone`, `ContactTone`, `SuggestionTone`, `AttachmentTone`, `ToastTone` and
`EmptyTone` are each exactly the keys of their component's own tone table, not
`Tone`. Two of them (`ContactCard`'s facts, `AttachmentRow`'s) have no runtime
fallback at all, so a tone outside the table renders with NO COLOUR — a value
the component silently discards, which is the case `src/types.ts` exists to make
impossible. Wave 1 set the precedent by typing `icon` as `IconName` where
`data-props` declared `string`.

**This turned `packages/ui-kit/fixtures/types.ts`'s stated guarantee into a real
one.** That file says it mirrors the kit's shapes "so a fixture cannot name a
colour or an icon the components do not have — a fixture typo becomes a compile
error instead of a blank square in a screenshot", and until now it could not
deliver that, because the mirror declared `tone?: Tone` everywhere. Thirteen
shapes are now re-pointed at `../src` instead of restated: `Step`,
`TimelineItem`, `ScheduleItem`, `ScheduleGroup`, `StatTile`, `MapPin`,
`MapPath`, `ContactFact`, `ContactAction`, `ComparisonColumn`,
`ComparisonRow`, `DigestGroup`/`DigestItem`, `RelatedFile` and
`SuggestionChip`. **Re-point each remaining shape as its wave lands.**

It immediately caught five fixture values naming a colour their component cannot
draw, and one of those is a real design gap rather than a fixture mistake:

- **`ContactCard` cannot express severity in a fact.** Its tone table is the
  ENTITY palette — teal person, blue company, purple project — with no red and
  no gold. The fixtures wanted red for "last spoke: 20 years ago" and gold for
  "holding: 108 guests", and had to settle for amber; three facts meaning three
  different degrees of "this is a problem" now all read the same. Written up in
  `.plan/design-feedback.md` — a card whose facts are provable statements about
  staleness and load has an obvious use for a severity ramp.
- `QuoteCard`'s palette is PROVENANCE, not severity, and has no red either.
  `forecastQuote` became purple (an outside source) and `nameQuote` amber (the
  user's own words). Both read better than before, so this one is a gain.
- `SuggestionChips` has no red; the chip that used it carries `icon: "failed"`
  and no tone now, which is right — a question about cost carries no effect.

### Source quirks, ported as found

- **`ScheduleList` resolves `neutral` to the `edge` HAIRLINE**, not to the
  neutral accent, so an FYI draws a rule rather than a grey bar — and its tag
  border is 40% of that hairline rather than of the ink ramp. Every other
  component in the kit resolves `neutral` to the ink ramp. There is a story
  showing it next to a toned rail.
- **`StatTiles` and `ComparisonTable` resolve `neutral` to PRIMARY INK.** An
  unremarkable number is still a number you read, and that is the whole reason
  those two read as prose rather than as a dashboard.
- **`SuggestionChips` resolves `neutral` to DIM INK.** Three different meanings
  for `neutral` across three components in one wave, all deliberate in the
  source, all preserved.
- **`ComparisonTable`'s tone table carries a `muted` entry nothing can reach**,
  since `Tone` has no such member. Dead in the source, so not ported — the same
  call wave 2 made on `Receipt`'s `muted`.
- **`StepList`'s state default is a dead ternary** (`v === 'numbered' ? 'todo' :
  'todo'`). Collapsed to `'todo'`.
- **`ContactCard` renders its fact list behind a guard that can never be
  false**, because the list is always an array. The guard's INTENT was ported
  (`facts.length ? … : null`), so passing `[]` renders no bordered empty block —
  the only case where the source contradicts its own guard.
- **The `p.x || FALLBACK` idiom is not `p.x?.length ? … : FALLBACK`.** An empty
  array is truthy, so a caller who passes `[]` gets an empty list rather than
  the stand-in. That distinction is the point of a fallback and it is preserved
  per component: `MapView` and `TrendChart` DO length-check their arrays in the
  source, and the other eight do not. `StepList`'s `EmptyList` story pins it.

### One place this port widens the API, again

`ContactCard`'s action buttons and `EmptyState`'s primary/secondary buttons are
drawn by the source with no way to operate them — in the design's editor they
are wired by hand, and in React they are dead pixels. Both gained optional
callbacks (`ContactAction.onClick`, `onPrimary`/`onSecondary`), absent by
default, so the render without them is the source's byte for byte and D20's
gating rule gives an unwired button no role and no tab stop. Same reasoning and
same shape as wave 2's six.

### Parity, measured

Five components, rendered under the real DC runtime on one port and the built
Storybook on the other, compared node by node on 37 computed properties.

| Component | Result |
|---|---|
| `StepList` (defaults) | 35 nodes each |
| `CodeBlock` (defaults) | 8 nodes each |
| `TrendChart` (defaults) | 28 nodes each |
| `DigestCard` (defaults) | 46 nodes each |
| `MapView` (identical explicit coordinates) | 37 vs 36 — one node, inside a Lucide glyph |

Across the four default comparisons, every difference reduces to the classes
waves 1 and 2 already documented: Tailwind preflight (`box-sizing`,
`border-style`/`border-color` on zero-width borders, `line-height: 24px`),
inherited `color`/`font-family` on elements that render no text, the mono-stack
normalisation, `inline-flex` -> `flex` from the sc-host decision, and template
whitespace JSX strips. **Zero differences in any colour, padding, radius, border
width, gap, flex, font size, weight, tracking, text-transform, white-space,
margin, overflow, animation, position or text-align.**

`MapView` is the one worth reading closely, because it is the one with content:
the eight graticule lines, all four graticule labels, the pin, the scale bar and
the coordinate readout are **identical on every probed property, including every
`top` and `left`**. The single node difference is inside the `graph` glyph —
`lucide-react@0.460` draws Waypoints with six children where the UMD lucide the
DC page loads uses seven — which is an icon-set version difference and exactly
the class wave 1 accepted when it replaced the imperative `Icon`. Everything
after the glyph is the same nodes compared one index apart.

Two findings from the harness worth keeping:

- **`DigestCard`'s `margin-left: auto` differed by 920px until the two sides
  were width-matched.** Not a port bug — an auto margin resolves to the free
  space, and a raw `.dc.html` page is unconstrained while the Storybook stage is
  360px. Comparing an auto margin means matching the container first.
- **`MapView`'s scale bar is the second instance of wave 1's `Chip
  variant="count"` exception:** a fixed-width box with a 1px border either side,
  so it is 2px wider under the DC page's `content-box` than under the kit's
  preflight `border-box`. Border-box is the more correct one here, since the end
  caps ARE the measurement ticks and edge-to-edge is what the label claims.

The throwaway pages used are in the design drop's `kit/` as `_p3-*.dc.html`. A
bare `<dc-import name="X">` with no attributes is the right way to compare
runtime fallbacks, because `data-props` defaults do not apply to imports — and
the DC-side selector then needs `.sc-host .sc-host` to step past the page's own
host.

### Verification actually run

`bunx tsc --noEmit` clean; `bun run lint` all six gates clean (including
`check-kit-purity` and `check-leakage`); `bun run test` 2920 pass / 24 skip /
0 fail; `bun run build` green; `bunx storybook build` green, with every new
token present in the built stylesheet and `.bk-thumb:before` / `.bk-undo:before`
present as authored (the minifier collapses `::before` to `:before`, which is
what a first grep got wrong); `bunx vitest run --project=storybook` 361 pass in
real Chromium; `bun scripts/check-leakage.ts` clean; `api-report/ui-kit.txt`
regenerated; a brand grep over `src/`, `stories/`, `fixtures/`, `tests/` and the
API report returns nothing.

### What a later wave needs to know

1. **Measure a hit target, never compute one.** `inset` resolves against the
   padding box, so every expansion on a bordered element is short by its border.
   Two of this wave's three land under the 44px floor because of it. The edge
   probe is the only thing that finds this.
2. **Re-point a fixture shape at `../src` the moment its component ships.** It
   is what turns "the fixtures cannot name a colour the kit lacks" from a
   comment into a compile error, and it found a real design gap the first time
   it was switched on.
3. **`neutral` is not one colour.** Three components in this wave resolve it to
   three different things — the edge hairline, primary ink, dim ink — all from
   the source. Read the table; do not assume the accent.
4. **A `data-props` default is not a runtime fallback, and the parity harness is
   where the difference bites.** A prop with an editor default and no `??` in
   `renderVals()` (`CodeBlock.caption`, `TrendChart.delta`, `ContactCard.badge`)
   renders in the `.dc.html` page and not in a bare `<dc-import>`. Compare
   against a bare import.
5. **Four props still need the accessibility wave**, on top of wave 2's four:
   `LinkPreviewCard` and `AttachmentRow` have `onClick` on a bare `<div>`; the
   two hit targets are under the floor; and `prefers-reduced-motion` now owes
   four more animated elements.

## Wave 4 notes

Thirteen components, 122 stories, 486 story tests in real Chromium (waves 1-4
together), 301 tokens. Eight comparisons through the DC parity harness, two of
them width- or prop-matched against throwaway pages. The kit is at **59
components** — the design's 58 plus `ScreenBody`, minus `PhoneFrame`, which is
furniture rather than a component.

Two things in this wave are net-new behaviour rather than a port, and both are
flagged as such below so nobody later reads them as design.

### `Composer` is a real `<textarea>`, and that was the instruction

The design draws the field as a styled `<span>` with `role="textbox"`, and its
own known-gaps list says: *"Composer is a display component (a styled span, not
a live input) — wire it to a real `<textarea>` with `:focus-visible` when
implementing."* Done, and three consequences followed that are worth recording
because none of them is a port decision:

- **The keys are the design's own table** — ⏎ sends, ⇧⏎ inserts a newline — and
  `onSend` is what makes ⏎ mean anything. Without it ⏎ reaches the textarea and
  inserts a newline like any other key, which is right for a field nobody is
  listening to. `EnterSendsShiftEnterDoesNot` asserts both halves; the ⇧⏎ half
  is the one that matters, because a ⏎ that always sends makes a multi-line
  question impossible to type.
- **The focus ring moved to the field.** The thing that takes focus is now the
  textarea, and the thing that should be ringed is the rounded field around it,
  so `theme.css` gained `.bk-field:has(:focus-visible)` and the textarea
  suppresses its own outline. `:has(:focus-visible)` rather than `:focus-within`
  keeps the design's "a pointer tap leaves no ring behind" rule, and a text
  field is exactly where that is least surprising, since browsers match
  `:focus-visible` on text inputs for mouse focus too. `:has()` is Chrome 105 /
  Safari 15.4, inside the package's stated Chrome 111 / Safari 16.4 floor.
- **No `onChange` means `readOnly`, not a fake.** The field still focuses, still
  announces itself and still cannot be typed into, which is honest in a way a
  `<div role="textbox">` is not.

Height follows the newline count of a CONTROLLED value, capped at five rows.
That keeps the component a pure function of its props — no ref, no measuring, no
layout effect — at the cost of not growing on soft wrap. Stated in the component
doc rather than hidden.

The parity harness cannot compare `Composer` on anything, because the two sides
now render different elements by design. That is the correct outcome, not a gap.

### `ScreenBody`, the kit's one addition

Ported from nothing: every assembled screen in the catalog retypes
`flex: 1; min-height: 0; overflow: hidden` with its own padding and gap. Nine
screens, nine chances to drop the `min-height: 0` — and a flex item without it
is floored at its content height, so the body grows instead of scrolling and the
tab bar walks off the bottom of the phone. That reads as "the list is too long",
not as a missing declaration, which is why it is worth one component.

`padding` and `gap` are props because the design genuinely varies them (2-20px
and 4-14px); the three declarations that make it scroll are not props at all.
`FitsBetweenTheChrome` and `PhoneFrame`'s `TheColumnHolds` both measure it.

### `AgentOrbit` is algorithmic and is verified numerically

`tests/agentorbit-placement.test.tsx`, 8 tests, expected values computed from
the five lines of the definition with a calculator before the component was run:

```
cx = w/2   cy = h/2   rMax = min(w,h)/2 - 26   r = 40 + orbit*rMax
rad = (angle - 90) * PI/180
left = cx + cos(rad)*r     top = cy + sin(rad)*r
```

Two agents pinned: researcher (orbit 0.28, angle 34) at **(210.53, 81.91)** and
source-watch (orbit 0.92, angle 214) at **(87.96, 263.64)** in a 340x284 box.
The two claims a wrong port passes silently get their own tests:

- **`angle` is clockwise from TWELVE**, which is the whole job of the `- 90`.
  Dropping it rotates the entire orbit a quarter turn, and a ring of pills is
  rotationally symmetric to the eye. Asserted as: angle 0 is straight up, angle
  90 is straight right.
- **`orbit: 0` is the core's EDGE, not the core**, which is the `40 +`. A port
  that dropped it would bury a nearly-finished run under the core glyph, which
  reads as "there is no such run".

**Proven to have teeth**: deleting the `- 90` fails 7 of the 8. The Storybook
also measures the same two pills in a real layout (`PlacementIsPolar`), because
a pill is centred on its point by `translate(-50%,-50%)` and its `left` is
therefore not where the maths says it is. DC parity came back 52 nodes each with
**zero differences in any `left` or `top`**.

`OnlyTheDotsMove` asserts the other half of the design's rule: exactly two
elements animate (the two live runs' dots), both on `breathe`, both 7px. Pills
are placed, never animated around — a spinning orbit would be a second ambient
animation, which the design's "what never changes" list forbids.

### The hit target: the negative-margin method is EXACT, and it has a width floor

`TabBar` uses the design's second sanctioned method — `padding: 9px 14px` with
`margin: -9px -14px` — rather than the `::before` at negative inset that waves 1
and 3 used. Measured, because the brief asked whether it carries the same
off-by-one wave 3 found:

**It does not.** `inset` on an absolutely positioned pseudo-element resolves
against the containing block's PADDING box, so a 1px border eats 1px of reach per
side; padding is not measured against anything, it IS the box, so the expansion
is exactly 18px vertically and 28px horizontally whether or not the element has
a border. Measured at the design's 390px: hit box **50.5px tall** around a
**32.5px** visual, against the README's "~33px visual -> 51px hit".

**The neighbour constraint still applies, and here it has a number.** With
`justify-content: space-around` the clear gap between two slots is the bar's free
space divided by the slot count, so for the five default slots (135.08px of
content) it is `(width - 135.08) / 5`, and it reaches the required 28px at a bar
width of **276px**. Measured, not only derived: at 275px the two expanded boxes
touch (-0.02px), at 276px they separate (+0.19px). At 390px the clear gap is
50.98px.

So **a five-slot tab bar below 276px steals its own clicks**, and
`NarrowBarStealsTheClick` reproduces that at 240px — asserting the THEFT, so a
future change that fixes the geometry has to delete the story deliberately.
Proven to have teeth the other way too: narrowing the padding from 14 to 8 fails
`HitTargetIsExact`. The floor moves with the slot count and the label lengths, so
a six-slot bar needs more; it is comfortably under any phone the design targets.

**One departure from the kit's gating rule, and it is deliberate.** Waves 1 and 3
gate their expansions on a handler, because a pseudo-element at negative inset
exists for no other purpose. This padding is ALSO the badge's containing block —
`right: 0` resolves against the padding box — so gating it would move the badge
out of the corner the moment an item lost its handler. Geometry two things depend
on is not gated on one of them. The cost: a STATIC item in a mixed bar still
carries an expanded box and can sit on an interactive neighbour's label. Recorded
in the component doc rather than papered over.

### `stageWidth` is a CAP, not a width, and this wave is where that mattered

`#storybook-root` shrink-wraps under the preview's `layout: "centered"`, and the
stage is `width: 100%; max-width: <stageWidth>`. So a component that does not
force a width renders at its CONTENT width and the cap never binds. Measured:
`LaneChart` renders at **212.23px** inside a 244.23px root, not at the 360 its
parameter names.

Harmless for most components. Not harmless for `TabBar`, where it is the whole
subject: at content width the five slots touch, their padding boxes overlap by
28px, and every hit-target measurement is meaningless. The TabBar stories
therefore render inside an explicit fixed-width box and state the width they
measure at. **Any future story that measures geometry owes the same.** This also
explains a parity result: `LaneChart`'s segments differ in `left` by a constant
ratio, and all four land on their authored percentages exactly (1.99 / 8.00 /
44.00 / 29.99 against 2 / 8 / 44 / 30) once divided by the real track width.

### Desktop: two components, and the rail is the wave-5 hazard's first real test

`SideRail` and `CommandPalette` are the first components built for a window.
Both reuse waves 1-2's classes rather than minting new ones, per D22.

**The rail sits in a flex ROW beside a whole screen**, which is exactly the shape
that overflowed in wave 2 — `width: 100%` on a component root became live when
the `sc-host` wrapper went, and two such roots in one row each claim the whole
row. The rail is safe because it declares `flex: none` and an explicit width
rather than `width: 100%`. **Verified rather than assumed**:
`TwoPaneDoesNotOverflow` renders a real 900px two-pane layout with
`ScreenHeader` + `ScreenBody` + four `QueueItemRow`s beside the rail, runs
`overflowing()` on it, and asserts 208 + 692. D22's breakpoint widths are
asserted exactly: 208 expanded, 60 collapsed.

**`CommandPalette`'s effect-chip rule is not optional styling, and it is
asserted twice.** A row that writes shows its chip, and the chip is in the row's
ACCESSIBLE NAME — `"Re-index knowledge/, reindex"` — because a warning shown only
to people who can see it is not a warning. `EveryWriteShowsItsEffect` checks
both, and `Static` checks that both chips survive a palette with no callbacks at
all: the chip is the safety rule, not a hover state.

Three smaller decisions inside the palette:

- **⌘K is not in the component and cannot be.** It OPENS the palette, and a
  component that is not mounted cannot listen for it. ↑↓ and esc are here, gated
  on `onSelect` and `onClose`.
- **↑↓ is handled on the ROW, not on the dialog**, so DOM focus and the reported
  selection move together. SELECTION follows focus and ACTIVATION does not —
  the opposite half of `FilterRow`'s choice, for the opposite reason: arrowing
  through filters *is* filtering, and arrowing through a palette must never run
  anything.
- **`role="option"` needs a `listbox`**, so the list element renders one, plus a
  `role="group"` per result kind labelled by its own heading. Wave 2's rule: a
  container-requiring role obliges its container, and here the container is the
  component's own element. All of it gated on `anyInteractive`, so a decorative
  palette is a `dialog` and nothing else.

### A third interaction class, and it is one line

`TabBar` and `SideRail` both fill their container and both take the design's -2
focus offset, so both are `.bk-row` rather than `.bk-control`. What neither fits
is `.bk-row`'s background-only hover: `SideRail` moves the background AND the
foreground, `TabBar` moves the foreground ONLY (there is no row to shade under a
tab bar).

So `theme.css` gained **`.bk-row-fg`**, an additive modifier that adds
`color: var(--hv-fg)` — the exact sibling of wave 2's `.bk-row-border`, which
adds a border for the one row whose rest border carries meaning. Following the
established pattern beat minting a parallel `.bk-nav` family that would have
differed from `.bk-row` by one declaration.

One supporting change: `.bk-row:hover`'s `background: var(--hv-bg)` gained a
`, transparent` fallback. `TabBar` sets no `--hv-bg`, and without the fallback
that declaration is invalid at computed-value time and resets the element's
background to initial — which happens to be transparent for every such item
today. That is the kind of accident worth spelling out rather than relying on.
It changes nothing for the fourteen components that do set `--hv-bg`.

### Tokens: 34 added, and one that could not be a token at all

301 tokens. Families per SURFACE as before: `orbit-*` (8), `lane-*` (14),
`graph-*` (2), `composer-voice-glow`, `rail-*` (3) and `palette-*` (4).

**`orbit-border-*` is keyed by RUN STATE rather than by tone**, because that is
what the source's `S` map keys it by — the border says "still going / your turn /
finished / broke", which is a different axis from the icon's colour. Three of the
four are an existing colour under that second meaning and say so
(`var(--bk-chip-border-amber)`, `var(--bk-color-edge)`,
`var(--bk-surface-border-red)`), which is wave 1's practice exactly.

**`LaneChart` is where tokenisation genuinely broke the source.** It derives two
fills by string-concatenating an eight-digit hex suffix onto the lane's own
colour — `c + '80'` for the hatch, `c + '8c'` for the fade. `var(--bk-teal-ink)80`
is not a colour, so the two derived values became two real seven-tone ramps.
0x80/255 = 0.5 and 0x8c/255 = 0.549, rounded to two decimals the way waves 1-3
rounded theirs.

That has a consequence the fixtures had to absorb. The hatch is keyed off the
legend's glyph STRING (`l.glyph === '▨'`), so `fixtures/runs.ts` spelled
`glyph: "hatched"` and would have drawn the SOLID swatch — a legend saying
"running" beside a chart saying "stopped". The glyph is now exported as
`HATCH_GLYPH` and the fixture uses it. Ported as found; the constant is what
makes it checkable, and `LegendMatchesTheChart` asserts the two swatch colours
differ.

### Brands: three fallbacks replaced, and the rule got sharper

`GraphView` (a real airline, a plausible real person, a real city as a project),
`CommandPalette` (the same three) and `MessageBubble` (the person). All three
replaced with Odyssey content per D19; every other fallback in the wave is the
source's verbatim, per D26.

**A fourth was replaced and then reverted, which is the useful part.**
`AgentRunCard`'s fallback task reads "Compare the three Lisbon venues against
last year's notes". That was flagged as contamination, changed, flagged back,
and restored — and the maintainer's ruling is now recorded as D29, which is
worth reading before touching any fallback again. The short version:

> The test is not "is this in-world?" but **"would shipping this string name
> something REAL?"** A real airline does. A real city in a task description does
> not, any more than the nine wave-3 fallbacks mentioning a Lisbon workshop do.

And the reason it matters is the split D29 states: **stories and fixtures are the
demo world** — they end up in screenshots, website copy and demo videos, so they
are Odyssey without exception — while **a runtime fallback is a developer-facing
default and a parity anchor**, visible only to a consumer who renders with no
props. Divergence there costs the ability to parity-compare, which has paid
repeatedly, this wave included.

The revert paid immediately: `AgentRunCard` is now compared on its OWN defaults
rather than on props matched by hand, 9 nodes each, and the only difference is
the `margin: auto` container-width class.

A brand grep across `src/ stories/ fixtures/ tests/ tools/ README.md` returns
only the wave-3 "lisbon" file paths, this one task string, and one comment in
`fixtures/time.ts`. No airline, no venue, no person.

### `PhoneFrame` is furniture, and it needed one correction

`stories/_phone.tsx`, beside `_stage.tsx`. Absent from `src/index.ts`, absent
from the tarball (`bun pm pack --dry-run`: 318 files, no `stories/`, no
`_phone`), and exempt from the token rule the same way the design marks its own
`browser-window.jsx` "raw elements / hex / px by design". It exports both the
component and a `phone()` decorator factory, which is how wave 5's screens will
use it.

**One thing had to be fixed rather than ported: `box-sizing`.** Preflight sets
`border-box` globally, which the DC pages never loaded, so the 9px bezel was
eating into the 844 and a screen "mocked at 390x844" was really 372x826. The
bezel is a bezel — outside the screen — so the frame sets `content-box`
explicitly. That is a **fourth** instance of the preflight box-sizing exception,
after `Chip variant="count"`, `MapView`'s scale bar and (this wave)
`TabBar`'s badge, whose fixed 15px box is 6px narrower under border-box and
therefore sits 6px further right. It is a pattern, not a series of one-offs.

`browser-window.jsx` was NOT ported. It is Claude Design's own starter scaffold
rather than Brain Kit design — Chrome's chrome, in Chrome's greys — and nothing
in this wave or the next needs a browser mock to present a desktop layout, which
is what `SideRail`'s two-pane stories already do honestly.

### Parity, measured

Eight comparisons, 37 computed properties per node.

| Component | Result |
|---|---|
| `ScreenHeader` (defaults + `trailingIcon`) | 10 nodes each, **zero differences** |
| `MessageBubble` (identical explicit text) | 2 nodes each, **zero differences** |
| `AgentOrbit` (source fallback both sides) | 52 nodes each; inherited `color`/`border-color`, the mono stack, template whitespace. **Every `left` and `top` identical** |
| `SideRail` (defaults) | 77 nodes each; the same three classes, plus one `margin-top: auto` |
| `TabBar` (defaults, no handlers) | 36 nodes each; the same classes, plus the badge's `left` |
| `LaneChart` (source fallback both sides) | 31 nodes each; segment `left` only, all four on their authored percentages |
| `AgentRunCard` (its own defaults, after the revert) | 9 nodes each; one `margin-left: auto` |
| `BottomSheet` (defaults) | 6 nodes each; one `margin-left: auto` |

Every difference reduces to a class waves 1-3 already documented — Tailwind
preflight, inherited `color`/`font-family`/`line-height` on the DC page, the
mono-stack normalisation, template whitespace JSX strips — plus two that are
each a documented harness property rather than a port bug:

- **`margin: auto` resolves to the free space**, so it cannot be compared without
  matching the containers. Wave 3 hit this on `DigestCard` horizontally and paid
  920px for it; this wave hit it three times, twice vertically (`SideRail`'s
  footer `margin-top: auto`, 0 vs 81.5px) and once horizontally.
- **`TabBar`'s badge is the preflight box-sizing exception again.** `minWidth: 15`
  plus `padding: 0 3px` is 21px wide under `content-box` and 15px under
  `border-box`, and since it is positioned by `right: 0` the difference shows as
  a 6px `left`.

Zero differences, across all eight, in any colour, padding, radius, border width,
border colour, gap, flex, font size, weight, tracking, text-transform,
white-space, overflow, animation, position or text-align.

`GraphView`, `CommandPalette` and `Composer` were not compared: the first two
have replaced fallbacks per D19 and would need throwaway pages carrying JSON
array props, and `Composer` renders a different element by design.

**`AgentRunCard` needed `progress: 72` passed on the React side**, and that is a
third instance of wave 1's "defaults are runtime, not editor-only" finding
rather than a mismatch. The source gates the meter on
`p.progress !== undefined`, so a React consumer who passes nothing draws NO
meter and the `?? 72` beside it is unreachable — while the DC runtime injects
the `data-props` default as a real prop, so the standalone page always draws
one. The port reproduces the source's own logic exactly; the two sides differ
because DC supplies a prop that React does not.

One harness note worth keeping: a run came back `React 0 nodes` once, on a
selector that was demonstrably correct, and was fine on the re-run. Re-run before
investigating — the same advice `SIGTRAP`/133 already earns.

### Verification actually run

- `bunx tsc --noEmit` clean; `bun run lint` all six gates clean; `bun run build`
  green; `bun run api-report` regenerated.
- `bun test packages tests` — **2961 pass, 24 skip, 0 fail**.
- `bunx storybook build` green. All 16 new token families present in BOTH
  `dist/styles.css` and the Storybook's own Tailwind pass, grepped rather than
  assumed. `@keyframes breathe` still appears exactly once. `::before` is
  collapsed to `:before` by the minifier, as wave 3 warned — five occurrences,
  which is the three expansion classes plus preflight.
- `bunx vitest run --project=storybook` — **486 pass, 0 fail** in real Chromium,
  run three times (twice green before the two fixes below, once after).
- Two story expectations were wrong and the components were right, which is the
  correct direction: `focus()` leaves a textarea's caret at position 0 so ⏎
  inserted the newline at the front, and `PhoneFrame`'s outer height was the
  preflight box-sizing bug above.
- `bun scripts/check-leakage.ts` clean; `bun scripts/check-dist-types.ts` clean;
  brand grep across the package empty.
- `bun pm pack --dry-run` — 318 files; all thirteen components in `src/` and
  `dist/`, no `stories/`, no `_phone`, no `fixtures/`.

### What a later wave needs to know

1. **`stageWidth` is a max-width, and `layout: "centered"` shrink-wraps the
   root.** Any story that MEASURES geometry must state its own width in a
   wrapper, as `TabBar`'s now do. Several wave 1-3 components are rendering
   narrower than their parameter suggests; nothing is wrong with them and no
   earlier assertion is invalidated, because `overflowing()` compares
   `scrollWidth` to `clientWidth` — a RELATIVE test, which shrink-wrapping
   cannot corrupt. Only an assertion about an absolute pixel number would have
   been wrong, and waves 1-3 made none. See D28.
2. **`margin: auto` needs container matching before the parity harness means
   anything** — in both axes. Three of the eight runs here hit it.
3. **Seven more fixture shapes were re-pointed at `../src`**: `OrbitAgent`,
   `RunTool`, `Lane`, `LaneSegment`, `LegendItem`, `GraphNode`/`GraphEdge`,
   `TabItem`, and `RunState` itself. `fixtures/types.ts` now restates only the
   world types and a handful of evidence shapes. Re-point each as its wave
   lands; it is what turns that file's stated guarantee into a compile error,
   and this time it caught the `glyph: "hatched"` mismatch.
4. **Wave 5 inherits a real `ScreenBody`, a real `PhoneFrame` decorator and a
   proven two-pane layout.** The assembly work should not retype a screen
   container, and `SideRail.stories.tsx`'s `TwoPaneDoesNotOverflow` is the
   pattern for the desktop half.
5. **`Disclosure` should become controllable** — still wave 3's recommendation,
   still not done, and the Run-detail screen in wave 5 is the case that needs it.
6. **The 276px tab-bar floor is a kit constraint, not a TabBar note**, and it
   is written up under "Kit-wide constraints, measured" near the top of this
   file for that reason. It moves with the slot count and the label lengths, so
   anyone adding a sixth destination, choosing a minimum supported width, or
   localising the labels owes a re-measurement rather than a reuse of 276.
7. **The a11y wave's list grew by three.** `MessageBubble`'s four response-action
   icons have no roles and no callbacks (the source's exactly, and `LinkPreview`
   and `AttachmentRow` are already on that list for the same reason);
   `GraphView`'s nodes are not navigable; and `prefers-reduced-motion` now owes
   `AgentOrbit`'s dots as well.

## Wave 1b notes

**The gate is at `'error'` and it was shown red on a seeded violation before it
was trusted.** That is the whole deliverable; everything else in this wave is
what had to be true first.

### The evidence D17 asked for

D17's requirement was not "flip it and see green" — it was that a green run
prove something, which it cannot while `'todo'` also passes. So the seed was run
at both settings, on the whole suite, with the same violation in place: a bare
`<img>` with no `alt` added to `Callout`, a component that renders in six
stories.

| Run | Result |
|---|---|
| seeded violation, `a11y.test: 'todo'` | **503 passed / 0 failed, exit 0** |
| seeded violation, `a11y.test: 'error'` | **497 passed / 6 failed, exit 1**, each naming `"Images must have alternative text (image-alt)"` |
| seed removed, `a11y.test: 'error'` | 503 passed / 0 failed, exit 0 |

The first row is the finding, not the control. A textbook accessibility defect,
shipped in a real component, rendering in six stories, passed CI completely
green. Everything waves 1-4 said about accessibility was unverified in exactly
that way.

The first seed attempt was thrown away and is worth recording, because it was a
near-miss: removing `Toggle`'s `aria-label` failed at `'todo'` too — but through
this wave's own `findByRole(…, { name })` assertions, not through axe. It would
have "proved" the gate using a mechanism that is not the gate. A seed only
demonstrates a gate if nothing else in the suite can see it.

### What the flip actually found

**33 failures across 7 story files, from exactly four axe rules.** Not a long
tail — four causes, each with one fix or one decision:

| Rule | Count | Verdict |
|---|---|---|
| `color-contrast` | 27 | **Design decisions.** Four distinct causes; `.plan/design-feedback.md` §§4-8. |
| `aria-required-parent` | 9 | **Component bug + story bug.** `FileRow`. |
| `aria-toggle-field-name` | 4 | **Component bug.** `Toggle` had no accessible name. |
| `aria-required-children` | 2 | Same `FileRow` defect, seen from the container. |

`FileRow` is the one worth reading twice. The source picks the row's role per
row — `treeitem` for a folder, `option` for a file — and **no container satisfies
both**, so axe failed it from both ends simultaneously and no call site could
have fixed it. Every operable row is a `treeitem` now, with `aria-expanded`
carrying the distinction; the design's own role table says `button` / `treeitem`
and never mentions `option`, so this moves the port towards the spec rather than
away from it. Recorded as a deliberate divergence in design-feedback §9.

### The components that shipped no states: five, not nine

D24-superseded predicted "the nine components that have no states at all". The
measured answer is **five**, and the difference is instructive: the other four
(`ContactCard`, `EmptyState`, `ApprovalCard`, `NotificationCard`) route their
handlers into a `Button`, so they inherited every state when `Button` got them.
**A component with a handler prop is not necessarily a component with a
control** — the audit has to follow the handler to the element it lands on, not
stop at the interface.

The five that landed on a bare `<div>`/`<span>`:

| Component | Class | Ring | Why |
|---|---|---|---|
| `Surface` | `.bk-row` | −2 | **The component the −2 offset was written for.** It sets `overflow: hidden`, so a +2 ring on a Surface inside a Surface is drawn outside the inner box and clipped away — present in the stylesheet, correct in the computed style, invisible on screen. |
| `LinkPreviewCard` | `.bk-row` | −2 | Full-width card; opening it is navigation, so one target and no effect chip. |
| `AttachmentRow` | `.bk-row` | −2 | Same. |
| `Placeholder`'s retry | `.bk-control` | +2 | Small bordered pill with padding around it. |
| `StreamingAnswer`'s Stop | `.bk-control` | +2 | Same, and untoned, so it takes D20's literal values. |

One thing had to be decided to finish them: **`.bk-control:hover` substitutes
`--hv-bd` unconditionally**, and an unset custom property there is invalid at
computed-value time, which resets `border-color` to `currentColor` — so a toned
control cannot simply decline to move its border. `Placeholder`'s retry sets
`--hv-bd` to its own rest border, restating rather than moving it, because D20
forbids a hover that changes what a control means and this control's border is
what carries its tone. `.bk-row:hover` already had a `, transparent` fallback for
the sibling problem (wave 4); `.bk-control:hover` does not, and that asymmetry is
now load-bearing rather than incidental.

Three items carried onto this wave's list by wave 4 resolved without code.
`MessageBubble`'s four response icons and `GraphView`'s nodes have **no callbacks
at all** — under the gating rule, no handler means no role, so they are already
correct, and making them operable is API widening rather than accessibility.
`AgentOrbit`'s dots are `StatusDot`s, so the one reduced-motion rule below
reached them with no change.

### Reduced motion was not implemented at all, and it is one rule

`prefers-reduced-motion` appeared nowhere in the kit. It is one of the design's
five non-negotiables, and waves 1-4 shipped without it.

It is now **one media query**, because there is one keyframe. Six call sites
write `animation: breathe …` on their own **inline** style, and an inline style
cannot be overridden from a stylesheet without `!important` — six of them, and a
seventh the day someone adds a seventh call site. **Redefining the keyframe**
reaches every call site instead, present and future, from the one place the
motion is described: the animation still runs, it simply has nowhere to go.

Two details that are easy to get backwards and are now asserted:

- **Two `@keyframes` of one name resolve by SOURCE ORDER, not specificity.** Put
  the override first and you ship a stylesheet that parses, loads, and silently
  ignores the user's preference. `tests/theme-tokens.test.ts` asserts the
  ordering, not just the existence.
- **The single stop is the REST state, not the trough.** A pulsing dot left at
  `opacity: .6` reads as *disabled* — meaning lost rather than motion removed,
  which is the exact failure the rule exists to prevent.

`Rules/Non-negotiables → ReducedMotion` checks the rule against **the stylesheet
the browser actually loaded**, walking `document.styleSheets` for the media rule
and its keyframe. A rule that is correct in `theme.css` and dropped by the build
is a failure a source grep cannot see — the same class of bug as wave 1's
`@theme static`.

### Contrast: the floor is right, and it is quoted against a ground the kit does not have

The design says `#8a8691` is 5.10:1 on surface. **Measured: 5.09.** The claim is
exact.

It is also the only ground on which it holds. `ink-mute` over `raised` is 4.75;
over **all 81** of the kit's translucent tints on `raised`, it fails every one;
at `opacity: .7` it is 3.08. Four distinct causes, all in design-feedback §§4-7,
none patched — a contrast failure is a palette decision, and patching one would
fork the kit from its source quietly.

Two mechanisms keep that honest rather than merely unfixed:

- **`knownContrastGap(reason)`** in `stories/_stage.tsx` is the only sanctioned
  way past the gate. It disables **one rule on one story** and requires the call
  site to write down why — so every other axe rule still runs on that story, and
  `color-contrast` still runs on the rest. Nine call sites, four causes; two sit
  on a `meta` because the same defect is in every story of that file.
- **`tests/contrast.test.ts`** recomputes every documented number from the
  tokens, so the day a token moves a test fails and names what changed. The
  composite arithmetic reproduces axe's own reported hex values exactly
  (`#64626b` on `#121417`), which is what makes it a measurement rather than a
  second opinion.

§7 is the one to notice: **a solid button's effect chip is under 4.5 on every
tone, and axe never saw it**, because no story renders that combination. "axe is
green" and "the palette is sound" are different claims, and that is where they
come apart.

### Keyboard: every group is reachable, and the tab order has a cost

`stories/rules/Keyboard.stories.tsx` walks a screen carrying one of each of the
design's nine component groups and asserts three things that no single
component's stories can see: that every group is **reached**, that the order is
**document order** (nothing sets a positive `tabIndex`), and that the ring is
**visible at every stop** at the offset its class specifies. Reading the ring
requires real focus from a real Tab — `getComputedStyle`'s pseudo argument takes
pseudo-*elements* only, so `:focus-visible` cannot be queried.

The walk's expectation is a list of names rather than a count, and the list is
where the finding is: **ten tab presses to get past the navigation.**
`FilterRow`, `TabBar`, `SideRail` and `ChoiceOption` each render `tabIndex={0}`
on every item, where a `tablist` and a `radiogroup` want a **roving tabindex** —
one tab stop for the group, arrows within it. The arrows are already wired, so
today they are redundant with Tab rather than being the way you move.

Not changed, and the reason is specific rather than timidity: getting it
half-right is worse than the current state. A group where nothing is selected and
every item is `tabIndex={-1}` becomes **completely unreachable from the
keyboard**, and `FilterRow` can have several pills active while `ChoiceOption` can
have none — so each of the four needs its own answer to "which item is the tab
stop when the obvious one does not exist". Design-feedback §11; it is the thing
I would do next.

Three bindings in the design's table also have nowhere to land — `ActionCard`'s
`a`/`d`/`s`, `TabBar`'s `1`-`5`, `FileRow`'s `←→` — because each component has
one handler and those need three. Left alone deliberately: WCAG 2.1 SC 2.1.4
makes an unmodified single-character shortcut a conformance question, and the
answer (focus-scoped, almost certainly) is the design's to give. §10.

### The five rules are checked as rules now

They were all true of some component somewhere. What was missing is the thing
that makes a rule a rule: a check that fails when the NEXT component forgets.
`stories/rules/Non-negotiables.stories.tsx` holds four of the five —

- **Never colour alone** renders every queue state and every action kind inside
  `filter: grayscale(1)`, which removes the channel the rule says must not be
  load-bearing, and then asserts on **words**. Every state and every kind, not a
  sample: a rule that holds for five of six states is not a rule, and the sixth
  is the one that ships.
- **Announce the effect** is satisfied structurally — the effect chip is a CHILD
  of the button, so a `role="button"` takes it into its name by construction. Now
  asserted, because the day someone moves the chip to a sibling for layout
  reasons, the name silently loses the half that says what the tap DOES.
- **Live regions** assert the "announce ONCE" half, which is the one that gets
  broken: one region per announcing thing rather than per item, none nested, and
  no `assertive` or `role="alert"` anywhere in the kit.
- **Reduced motion**, above, plus the other half of it — that nothing needed the
  motion. Each breathing thing is checked for a signal that survives it being
  switched off: `claimed` says "claimed", the skeleton's phase line says
  "drafting answer", the pending toast still offers its Undo.

The fifth — hit targets — is deliberately NOT there. It is measured where it
happens, with `elementFromPoint` at each target's edges, in `Toggle`,
`FeedbackRow`, `InlineToast` and `TabBar`. A copy of those numbers in a rules
file would be a second place for them to drift. All four still pass unchanged.

### Smaller things, decided once

- **The focus ring says it is ink**, rather than restating ink's literal:
  `--bk-focus-ring: var(--bk-color-ink)`. D21 requires the ring to stay ink in
  BOTH themes, so a second copy of `#e8e4df` is how the paper theme ends up with
  a ring left over from the dark one. Three `var(--bk-focus-ring, #e8e4df)`
  fallbacks were also removed — dead, since the rules live in the stylesheet that
  defines the token, and a D23 violation regardless.
- **`Toggle` gained `label` / `labelledBy`**, which is net-new: the design draws
  a switch as pure geometry with no text in any state, and a switch is the one
  control with no visual words to fall back on. A dev warning covers the
  combination the type cannot express — a handler with no name.
- **Seven `--bk-surface-hover-tint-*` tokens** are the only invented numbers in
  the wave, and they are flagged as derived in §13.
- **`stageWidth` and story wrappers again**: `FileRow`'s tree decorator is
  conditional on the story's own args, because the wrapper exists BECAUSE OF THE
  ROLE — a `Placeholder`-state row and a handler-less row have no role, and
  wrapping them would produce an empty tree that axe correctly rejects.

### Verification actually run

- `bunx tsc --noEmit` — clean. `bun run lint` — six gates clean.
- `bun run test` — **2976 pass / 24 skip / 0 fail**, 3000 across 224 files.
- `bunx storybook build` — green; `prefers-reduced-motion` confirmed present in
  the built `storybook-static` CSS and in `dist/styles.css`, by grep, not by a
  green build.
- `bunx vitest run --project=storybook` in real Chromium with the gate at
  `'error'` — **61 files, 503 tests, 0 failures** (was 487 before this wave).
- The three-run seed proof above.
- `bun scripts/check-leakage.ts` clean; brand sweep over `src`, `stories`,
  `fixtures` and `tests` empty (three hits, all the English words "notion",
  "slack" and "no slack").
- `bun run api-report` regenerated — `Toggle` gained two props, `Surface`'s
  surface is unchanged.

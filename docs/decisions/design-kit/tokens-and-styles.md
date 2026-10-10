# Design kit — Tokens and styles

Part of the [design-kit decision record](../design-kit.md). Entries retain their
original dates and order within this subject; the index maps the complete chronology
and relationships with [other subjects](../design-kit.md#subjects).

<a id="2026-09-15--d23-the-kits-stylesheet-is-mandatory-not-optional"></a>

## 2026-09-15 — D23: the kit's stylesheet is mandatory, not optional

Every colour in `ui-kit` resolves through a CSS custom property. No `.tsx` in
the package contains a colour literal; each component keeps its `T`/`C` table
with the design's vocabulary (`amber`, `teal`, `fg`, `border`, `tint`) and every
value in it is a `var(--…)`.

**Consequence, stated plainly: a consumer who does not load `styles.css` (or
pull `theme.css` into their own Tailwind build) gets components with no colour
at all.** That is a real cost for a published package and it is deliberate.

I originally asked for `var(--token, #hex)` fallbacks so a stylesheet-less
consumer would still render. That was wrong, for a reason I had not considered:
**a light-theme consumer who fails to load the stylesheet would get dark
defaults.** "No colour" is a loud failure that gets fixed in minutes; "subtly
wrong theme" is a quiet one that ships. Fallbacks would also put the literals
back in source and mask the missing stylesheet entirely. Documented at the top
of `index.ts`, `tokens.ts` and in the changeset.

`tests/token-references.test.ts` enforces both directions: every `var(--…)` in
`src/` must be defined in `theme.css`, and no source file may contain a hex,
`rgb(`, `hsl(` or `color-mix(`. Worth understanding why that test earns its
keep — **the failure mode moved**. A hex typo renders the wrong colour loudly; a
token typo renders *no declaration at all*, which can look plausible.

<a id="the-alpha-ramps-are-three-sets-not-one"></a>

### The alpha ramps are three sets, not one

Chip tints at 9-10%, Callout at 6-8%, Surface at 5-6%. These are the design's
own numbers from its `T` maps. Collapsing them to a single tint would have been
a silent redesign, so the band rule is documented and the three points within it
are preserved.

<a id="open-relative-colour-syntax-is-outside-the-packages-baseline"></a>

### Open: relative colour syntax is outside the package's baseline

The derived tokens were built with `rgb(from var(--color-amber) r g b / 0.1)`.
Verified against caniuse: **relative colour syntax shipped in Chrome 119, with
full support in Chromium 125+ and Safari 18.0+** — outside Tailwind v4's
Chrome 111 / Safari 16.4 floor, which is the baseline this package otherwise
claims. Exposure is small in practice (Chrome 111 is March 2023, 125 is May
2024), but this is published CSS in an npm package rather than an app we
control.

The benefit is also smaller than it first appears: the payoff of derivation is
"redefine the 14 base colours and every tint re-derives", but the light contract
explicitly wants *different* alphas (tints use the fill hue at 8-14%, never the
ink hue), so the second theme overrides the derived tokens anyway. Direction
given: precompute the 60 derived tokens as literals in `theme.css` unless there
is a counter-argument. They stay tokens, stay in one place, stay overridable —
only the derivation mechanism goes, and `theme.css` is where literals belong.

<a id="naming-rule-established"></a>

### Naming rule established

`#7fd0be` served as both `affirm`'s hover fill and the teal meter gradient's
stop. Renamed `--color-teal-lift` — **named for what it is, not where it was
first used.** Free at one call site, expensive at twenty. The ~18 hover tokens
wave 1b needs follow the same rule.

<a id="d24--buttondisabled-is-ported-but-incomplete"></a>

### D24 — `Button.disabled` is ported but INCOMPLETE

Wave 1 ported `disabled` (the visual rest state: `opacity .45`,
`cursor:not-allowed`, `pointer-events:none`) while leaving `role`, `tabIndex`
and `aria-disabled` to the accessibility wave. That split is sound — the
component has no keyboard path at all yet, so the semantics half would have
nothing to suppress, and a declared prop silently missing from the kit is the
worse failure.

**But it must not be recorded as done.** A wave-1b checklist reading "disabled:
ported" invites skipping the `aria-disabled` half, and a visually-disabled
control with no programmatic signal is exactly the bug an accessibility wave
exists to prevent.

<a id="2026-09-18--d32-the-light-theme-is-light-dark-per-token-switched-by-color-scheme-under-data-theme"></a>

## 2026-09-18 — D32: the light theme is `light-dark()` per token, switched by `color-scheme` under `[data-theme]`

The second design drop shipped the paper palette in full (`design/light.md`),
so the light-theme wave D21 deferred is done. The contract says "route the tone
maps through custom properties on a `[data-theme]` root"; the kit already
routed every colour through `--bk-*`, so the question was only how the second
set of values is switched. Researched against MDN, web.dev and the Storybook
and Tailwind v4 docs before choosing.

**The mechanism.** Every token is one declaration, `--bk-x: light-dark(<paper>,
<dark>)`, and `color-scheme` picks the half: `:root { color-scheme: dark }`
keeps the kit dark for a consumer who does nothing, and `[data-theme="light"]`
/ `"dark"` / `"system"` set `light` / `dark` / `light dark` — the design's
three-way toggle, on `<html>` for an app or on any element for a subtree.
`system` is the browser's own `prefers-color-scheme`, with no script and no
flash. Baseline since May 2024; in an older browser the declaration is invalid
at computed-value time and the element renders no colour, which is the loud
failure the kit already chose for a missing stylesheet.

**Why not a second `[data-theme="light"]` block of 300 values**, which is what
the stub in `theme.css` had sketched: (1) one declaration per token keeps each
light value beside its dark one and the comment that explains it, and cannot
drift from it by omission; (2) the UA's own chrome — scrollbars, form
controls, the composer's textarea — follows `color-scheme` for free, and a
block does not do that; (3) a light subtree inside a dark page needs no
selector work, because the property inherits and `light-dark()` reads it
where the token is USED — the paper `PhoneFrame` story proves the nesting;
(4) system preference costs nothing, where a block needs either a duplicated
`@media` copy or a script. **Why keep `data-theme` at all:** it is the attribute
the design's contract names, it is what `@storybook/addon-themes` sets, and it
is what an app's persisted choice writes — `color-scheme` stays the
implementation underneath it.

**Where the values come from.** The design draws about fifty light values
(§L3/§L4) and states the base palette and accent pairs (§L5); it says nothing
about the other ~260 alpha tokens. Those are derived by one rule each in
`tools/theme/derive-light.ts` — tints keep their hue role and step +0.07 in the
fill hue (capped at 0.16), borders step +0.05 in the ink hue, white veils
invert to ink — and the generator rewrites `theme.css` and `LIGHT_TOKENS`
in place. `tests/light-theme.test.ts` pins both to the generator, so a light
value can only change as a rule or as an entry in the `SPECIFIED` table, and
the line between "the design said" and "we chose" stays in one file. The
design's own rule against deriving one theme from the other is about hue and
lightness (no `invert()`, no programmatic lightening); the derivation here
touches only alpha, and never a hex the design gave.

**Proof.** The a11y gate runs every story on paper: a second Vitest project
pins the `theme` global to `light` (`initialGlobals`, D9's matrix made real),
and `tests/contrast.test.ts` measures the light ramp and every accent ink on
its own tinted ground over the canvas. The first run of that gate found the
first light palette failing on 141 stories (design-feedback §19); the design
revised five inks the same day and the gate is green with one recorded
exception (§20). What it does not prove: pixels. No light visual baselines
exist yet, and the dark ones that changed need a container run.

<a id="2026-09-18--d33-neutral-is-the-grey-accent-and-nothing-else-on-fill-is-what-sits-on-a-fill"></a>

## 2026-09-18 — D33: `neutral` is the grey accent and nothing else; `on-fill` is what sits on a fill

The drop tightened the tone vocabulary to ten members (`design/catalog.md`
§1.1b) after design-feedback §4: `ink`, `dim` and `edge` are named, `neutral`
means `#8a8691` in every component, every lookup falls back to `dim`, and the
dead `muted` entries are gone. The kit follows: `ValueTone = Tone | "ink" |
"dim"` for values inside an answer (`StatTiles`, `ComparisonTable`, `Receipt`
rows, `ContactCard` facts — which also settles §2), an untoned value takes the
component's stated default (ink, ink, dim, dim), and `ScheduleList` names
`edge` for its untoned rail. Wave 3's "ported as found" notes for these five
components are superseded, and the fixtures were audited for a `neutral` that
meant "plain" (one, the digest's `days out` tile, now untoned).

The same drop settled what sits on a solid accent: near-black ink in both
themes, the README's `--on-fill`, "including count badges". `--bk-on-fill`
(`#0c0e12` / `#231f1a`) replaces every foreground use of `color.canvas`, and
`--bk-on-ink-solid` (`#0c0e12` / `#f8f5ef`) covers the two discs the light
catalog fills with an accent's INK rather than its fill — a selected option's
mark and a done step's bubble — where the light glyph has to be surface, not
ink. The distinction is the light theme's, not the dark's, which is why it
needed two names.

<a id="2026-09-18--d34-hit-targets-are-specified-as-reach-past-the-paint-and-the-paint-carries-no-border"></a>

## 2026-09-18 — D34: hit targets are specified as reach past the paint, and the paint carries no border

The drop answered design-feedback §1 with a rule rather than two numbers, and
stated it three times (README, catalog §11, desktop D3): a small control's
target is its transparent `::before` at negative inset, **specified as the
reach past the paint**; a hairline on such an element is `box-shadow: inset 0
0 0 1px`, an underline is `text-decoration`, never a border, because an
absolutely positioned pseudo-element is offset from the padding box and a
border eats a pixel of reach per side; and **expansion is constrained per
axis** — per side, at most half the distance to the nearest interactive
neighbour on that axis. `FeedbackRow` is 46×44 from a 30×26 thumb
(`inset:-9px -8px`, 8 horizontally against an 18px gap), `InlineToast`'s undo
45×45.65 (`inset:-16px -10px`), `Toggle` 44×44 as before. The kit's stories
measure all three with `elementFromPoint` at the edges, and now also assert
that the border is zero — so a border creeping back fails a test rather than
shaving two pixels silently, which is exactly how it shipped under spec for
three waves. The consequence for the hover mechanism: a shadow is not a
border, so `.bk-thumb:hover` and `.bk-undo:hover` carry their own rule in
`theme.css` beside the shared `.bk-control:hover`.

<a id="2026-09-18--d35-the-dark-floor-is-9a96a1-and-the-paper-palette-is-stated-three-times-per-hue"></a>

## 2026-09-18 — D35: the dark floor is `#9a96a1`, and the paper palette is stated three times per hue

The fourth drop answered the ledger's palette questions with numbers rather
than exceptions. **Dark:** machine-meta ink moves from `#8a8691` to `#9a96a1`
— "6.26 on surface, 5.83 on raised, 4.80 on the worst documented tint" — and
`neutral` moves with it, because it is the same colour. `opacity` on a row is
gone as a de-emphasis (a superseded queue item reads as superseded from its
state word and its still dot). The well on a solid button lightens
(`rgba(255,255,255,.28)`) in both themes and its subtitle is opaque `on-fill`
at weight 500. **Paper:** every accent carries ink, fill and dot; teal, purple
and red came down once more for two stacked tints of one hue (`#15594c`,
`#5d4489`, `#9c2a24`); all seven dots are stated and judged against the 3:1
non-text bar. The kit takes all of it through the two places it already had —
`tokens.ts` for dark, `derive-light.ts`'s `SPECIFIED` table for paper — and
the effect is measured rather than described: `tests/contrast.test.ts` now
asserts §4, §5, §7 and §20 as resolved (ink-mute clears every tint over both
grounds; the effect chip clears 9:1 on every fill), and the light story
project runs with no contrast exception. The cost is every dark visual
baseline, which is what a floor move should cost.

<a id="2026-09-19--d39-the-app-draws-no-colour-of-its-own--theme-inline-over---bk--ink-and-fill-named-apart"></a>

## 2026-09-19 — D39: the app draws no colour of its own — `@theme inline` over `--bk-*`, ink and fill named apart

Asked to make sure the main screens are tested in light mode, the first thing
checked was the app shell itself, in a real browser at 1440 with
`data-theme="light"` set: the kit's cards turned to paper and the page around
them stayed `#0c0e12`. The cause was `packages/ui-react/src/theme.css`: its
`@theme` block held literal dark hex for `--color-background`,
`--color-surface`, `--color-foreground` and every other utility colour, so
`bg-background` and `text-foreground` — 150-odd uses — were the one place the
`light-dark()` switch (D32) could not reach. Two prose blocks
(`.brain-prose`, `.whatsup-briefing`) and the filament carried the same hex.
Four component files used Tailwind's own palette (`text-amber-100`,
`bg-amber-950/90`, `text-emerald-200/90`): light text for a dark ground, which
vanishes on paper.

**The decision.** The app declares no colour. Every `--color-*` utility is
`var(--bk-*)`, in a `@theme inline` block so the utility carries the token
itself and it resolves where it is used, not on `:root` — the same reason the
kit's `PhoneFrame theme="paper"` nests. The prose blocks and the filament use
the tokens by name (`--bk-filament-edge` / `-core` are the design's own two
stops), and the four alpha tints in the prose are `color-mix()` of the ink
hue, which is the kit's own rule for a border or a decoration on a tinted
ground; there is no paper value typed anywhere in the app, so
`tools/theme/derive-light.ts` stays the only place one lives.

**Ink and fill are two names.** The kit keeps them apart — `--bk-color-amber`
is `light-dark(#7f4c08, #e09f3e)`, the ink; `--bk-amber-fill` is `#e09f3e` in
both themes, the fill — and one Tailwind name cannot serve both: with
`--color-primary` as the ink, `bg-primary` on a button is dark brown on paper.
So `primary`, `accent` and `destructive` are the inks (`text-`, `border-`,
`ring-`, `accent-`) and `primary-fill`, `accent-fill`, `destructive-fill` are
the fills (`bg-`, solid or with an alpha), with `--bk-on-fill` as
`primary-foreground` / `accent-foreground`. Thirty-nine `bg-` sites renamed.
The surfaces map onto the kit's four (canvas, surface, raised, line/edge);
`surface-overlay`, which was one step above raised in the dark set, is
`raised` now — the kit has no fifth surface, and the app should not invent
one.

**Proof, and its limit.** `packages/ui-react/tests/theme-neutral.test.ts` is
the gate: no hex or rgb literal in `theme.css`; every `--color-*` is a kit
token or a `color-mix` of one and none is declared in the plain `@theme`
block; no Tailwind palette class anywhere in `src/`; solid black or white
only in the two files whose ground is not the theme's (the mask editor's
controls on a photograph, the HTML viewer's iframe); a hex in source only in
the six files that draw outside the DOM, each with its reason, and the
allowlist itself checked against the tree so it cannot go stale. That is
static. The runtime proof was the browser sweep — computed background,
border and text colour of every rendered element on Chat, Actions, Files,
Graph and Settings, in both themes, at 1440 — which is not a test because the
app has no browser harness; the kit's light visual baselines and the
`storybook-light` project cover the kit, and the shell's light rendering
rests on this gate plus the sweep recorded in the handoff.

**What stays dark, on purpose.** The sigma canvas palettes and the mermaid
theme variables are literal hex validated as sets against the dark canvas
(CVD order, lightness band). On paper the graph draws on `--bk-color-canvas`
and its labels take the ink, but the node colours are the dark set — legible,
not validated. A paper set is a design question, not a derivation
(design-feedback §14).

**The review's three findings, all real.** Codex (gpt-5.6-sol) read the
diff and found what the sweep cannot: contrast. A six-pixel status dot in
`bg-*-fill` is 1.9–2.5:1 on paper, under the 3:1 a non-text cue needs — the
kit's third weight, `--bk-*-mark`, exists for exactly that, so the app has
`primary-mark` / `accent-mark` / `destructive-mark` and its five dots use
them. The mask editor's error line sat in `text-destructive` on its
`bg-black/80` overlay, a dark red on black on paper — it is
`text-destructive-fill` now, the fill being the same light red in both
themes. And `text-primary/80` on the share block's format chip over a
`bg-primary-fill/15` tint fell to 3.5–4:1; it is the full ink. The lesson for
the gate: a class regex proves the theme reaches an element, not that the
element reads once it does — contrast on paper still needs eyes or numbers.


<a id="2026-09-19--d40-the-seventh-drops-rulings--canvas-palettes-are-tokens-the-diff-and-the-checkbox-are-the-kits"></a>

## 2026-09-19 — D40: the seventh drop's rulings — canvas palettes are tokens, the diff and the checkbox are the kit's

Ten questions, ten rulings (design-feedback "The seventh drop", §14–§23).
Binding:

1. **The canvas palettes are kit tokens** with a paper half from §L6:
   `--bk-canvas-slot-1…8`, `--bk-canvas-ramp-1…5`, `--bk-canvas-root`,
   `--bk-canvas-other`, `--bk-canvas-lens-*`, `--bk-diagram-*`. Slot order is
   frozen across themes. The app resolves a `light-dark()` token to the half
   matching the document's `color-scheme` before handing it to sigma or
   mermaid — canvas `fillStyle` cannot read the function — and re-resolves
   when the theme changes. Labels take the ink, never the node's colour.
2. **No fifth surface.** `surface-overlay` stays `raised` (D39 confirmed).
3. **Grounds take the fill hue, lines take the ink hue** — the general rule
   for any derived tint, prose included.
4. **A bare mark takes the mark value at every size.** Fill only under
   near-black content or behind a ≥3:1 border.
5. **`DiffBlock` has a `tinted` mode**; the app's diff view renders through
   it and its word-level highlight is gone (no design equivalent).
6. **`ChoiceOption.multiple`** (checkbox role, square mark) and
   **`AskUserCard.multi`** with `answers[]`; the app's own checkboxes are
   gone.
7. **`AskUserCard` has a fourth state, `dismissed`** (gold, lapsed row, "Ask
   again" behind `onAskAgain`). The app reopens the card locally; a submit
   from a reopened card is a normal composer message quoting the question,
   since the server's request is already resolved.
8. **State the absence**: the mask receipt reads "region not recorded"; the
   mask is drawn over the thumb when its bytes exist, else the thumb says
   the mask was not rendered.
9. **The token swap is the spec** for desktop screens on paper; the
   maintainer's screenshots are the record.
10. **`ApprovalCard`: Allow `flex: 1 1 auto`, Deny content-sized with a
    96×44 floor; the target wraps.** The kit's earlier 50/50 divergence is
    withdrawn.

**The review's four findings, all real.** Codex (gpt-5.6-sol) on the three
commits: multi-select closed the Other field when a neighbour was picked
(fixed: it stays open while Other is on); a reopened question stayed pending
after its message went out (fixed: it closes again); the mask receipt
trusted a byte count as proof the browser had the PNG (fixed: fill and
label only after `load`, "mask not rendered" on `error`); and the kit's
`diffRows` stripped one character from a context line where a unified diff
carries two, so context rows sat a cell to the right (fixed; a recorded
divergence from the design's source, which has the same off-by-one).


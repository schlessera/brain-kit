# @schlessera/brain-ui-kit

The brain-kit design kit: presentational React components, the design tokens
they are built from, and the Storybook that documents them.

Everything here is **prop-driven**. Props in, callbacks out — no stores, no
`fetch`, no ambient configuration, no browser globals. That is not a style
preference: `@schlessera/brain-ui-react`'s stores are module singletons with no
provider, so a component that reaches for one cannot be rendered in a story, a
test, or a second embedder without mutating global state. The kit is where that
class of component does not exist, and `scripts/check-kit-purity.ts` enforces it
mechanically rather than by review.

## Status

**58 presentational components have landed**, including agent views, screen
chrome and desktop navigation. Four assembled screens exercise the kit in
Storybook: Morning Digest, Chat Answer, Weekly Review and Run Detail. Browser
interaction/accessibility checks and curated visual baselines run in CI.

The live `ui-react` application has not yet migrated onto the kit. See
`.plan/HANDOFF.md` for current progress and `.plan/PLAN.md` for the wave checklist.

## Styles

Two forms, both generated from `src/styles.css`:

```ts
// A consumer with its own Tailwind v4 build:
//   @import "@schlessera/brain-ui-kit/theme.css";
//   @source "../node_modules/@schlessera/brain-ui-kit/src";

// A consumer without one:
import "@schlessera/brain-ui-kit/styles.css";
```

`src/theme.css` is the token set, reproduced from the design catalog's
Foundations section. Two things in it are easy to get wrong and are asserted by
`tests/theme-tokens.test.ts`: the spacing scale is deliberately irregular (it is
not a 4px grid), and three radius steps are ranges whose ends both ship.

## Storybook

Run from this directory:

```sh
bun run storybook          # dev server on :6006, MCP endpoint at /mcp
bun run build-storybook    # static build
bun run test-storybook:ci  # every story's render + play function, in Chromium
```

The story tests run under Vitest browser mode against real Chromium, which is a
separate runner from the repo's `bun test`. Both are expected to pass; they do
not interfere.

Stories are [CSF Next](https://storybook.js.org/docs/api/csf/csf-next)
(`preview.meta` / `meta.story`), the format that becomes Storybook's default in
11. They import the preview through the `#*` subpath map in `package.json`, so
no story carries a `../../.storybook/preview` path.

## Accessibility

`parameters.a11y.test` is `'error'`: axe violations fail the browser suite in
CI. The gate was verified with a seeded violation. Known palette contrast gaps
have explicit, story-scoped exceptions recorded in `.plan/design-feedback.md`;
a green suite does not mean those design issues are resolved. Keyboard groups
use roving tab stops, and reduced-motion behavior is checked in the browser.

The following interaction rules are also covered by stories.

**Interaction states are gated on a handler.** A component that was given no
`onClick` gets no role, no tab stop, no focus ring and no hover — so a static
row never pretends to be pressable. That is an API contract, not styling.

**Hit targets are not visual size.** Small controls stay small and extend their
target with a transparent pseudo-element: `Toggle` (38x22 drawn), `FeedbackRow`
(30x26) and `InlineToast`'s undo (text-sized). The constraint that makes it safe
is that expansion per side must be no more than half the distance to the nearest
interactive neighbour — get it wrong and a neighbour's invisible target steals
the click, which is how `FeedbackRow` once recorded thumbs-down for a thumbs-up.
Each one is asserted with `elementFromPoint` at the target's EDGES in its own
story. **Note the measurement:** `inset` on an absolutely positioned
pseudo-element resolves against the containing block's PADDING box, so a 1px
border costs 1px of reach on every side — `FeedbackRow`'s target is 46x42 rather
than the 48x44 its source comment claims, and the undo's is 43.65px tall rather
than 44. Both are recorded in the stories that measure them.

`TabBar` uses the design's other sanctioned method — padding cancelled by an
equal negative margin — and that one is exact: padding is not measured against
anything, so a border costs it nothing. The neighbour constraint still applies
and here it has a number. With `justify-content: space-around` the clear gap
between two slots is the bar's free space divided by the slot count, so for the
five default slots it reaches the required 28px at a bar width of **276px**.
Below that a five-slot tab bar steals its own clicks, and
`NarrowBarStealsTheClick` reproduces it at 240px.

**Container-requiring roles get their container.** A `tab` needs a `tablist`, an
`option` needs a `listbox`, a `radio` needs a `radiogroup`. Where the container
element belongs to the component it is rendered — `FilterRow`, `TabBar` and
`SideRail` render their own `tablist`, `AskUserCard` its `radiogroup`,
`CommandPalette` its `listbox` and one `group` per result kind. Where it belongs
to the caller (`FileRow`'s `tree`) the stories show the wrapper it is owed.

**A control that writes says so in its accessible name.** `CommandPalette` puts
the effect chip into the row's `aria-label` — *"Re-index knowledge/, reindex"* —
so the warning is not shown only to people who can see it.

**Two components announce themselves.** `StreamingAnswer`'s phase line and the
whole of `InlineToast` carry `aria-live="polite"`, because both change without
the user doing anything to make them change and are otherwise silent to a screen
reader. `polite` rather than `assertive` in both cases: neither should cut
across whatever is being read.

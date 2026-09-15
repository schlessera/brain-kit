---
"@schlessera/brain-ui-kit": minor
---

`ui-kit` gains its first twelve components, ported from the design drop: the
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

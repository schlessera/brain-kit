# DC parity harness

Renders a component twice — as the original `.dc.html` under the real DC
runtime, and as its ported Storybook story — and diffs the two DOM trees node by
node across 37 computed properties.

It exists because a ported component can look right and be wrong, and because
the alternative is a human comparing two screenshots and believing themselves.
What it has already caught or settled, none of which review would have:

- **The `sc-host` decision.** The DC runtime wraps every component in a plain
  block `div`, so dropping that wrapper changes which element is the flex item.
  This harness is how "it changes nothing" stopped being an argument: `Surface >
  Meter x2` came back 15 nodes each, identical on every probed property.
- **A colour refactor that had to be invisible.** Moving every literal into
  tokens was verified by re-running all four comparisons and getting the same
  answer, rather than by reading the diff.
- **`renderVals()` fallbacks versus `data-props` defaults.** Several components
  differ between the two, and the harness shows which one actually renders.

## Running it

Two static servers — the design drop's `kit/` directory, and a built Storybook:

```
python3 -m http.server 8801 --directory <design drop>/kit
bunx storybook build && python3 -m http.server 8802 --directory storybook-static
```

Then one invocation per component:

```
bun tools/dc-parity/compare.ts Button \
  'http://localhost:8801/Button.dc.html' '.sc-host' \
  'http://localhost:8802/iframe.html?viewMode=story&id=primitives-button--default' \
  '#storybook-root > div > div'
```

Needs `agent-browser` on `PATH`. Exits non-zero on any difference.

A `.dc.html` opened directly renders from its `data-props` **defaults**, so
match the story to those with URL args — `&args=label:Approve+this+edit;onClick:!undefined`
— rather than editing the story. The Storybook selector usually needs an extra
`> div` to step past the stage decorator.

For a composition the design has no single file for, write a throwaway
`.dc.html` in the served directory: a `<x-dc>` wrapper and `<dc-import>`
elements is all a page needs. That is how the nested `Surface > Meter` case was
built.

## Four differences that are expected

Not port bugs. Everything else is.

| Difference | Why |
| --- | --- |
| `text` whitespace | DC templates carry newlines that JSX strips |
| `box-sizing`, `border-style` | Tailwind preflight, which the DC pages never load. Changes nothing where a border is 0 wide or a box is auto-sized — the one exception in the kit is `Chip variant="count"`, whose fixed 15px box is 2px larger under `content-box` |
| inherited `color` / `font-family` / `line-height` on elements that render no text | the DC standalone page sets no body font |
| `inline-flex` computing to `flex` | the `sc-host` decision: without the wrapper the component root is itself the flex item, and flex items are blockified |

## What it does not cover

Computed styles on a settled render, and nothing else: no attributes, no
pseudo-elements, no interaction states, no layout at a second width. Hover,
focus and hit targets are asserted in the stories instead, where a real browser
can drive them — see `Toggle.stories.tsx`'s `HitTargets`.

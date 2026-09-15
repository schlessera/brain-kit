---
"@schlessera/brain-ui-kit": minor
---

ui-kit wave 1b: the accessibility gate is enforced, not configured.

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

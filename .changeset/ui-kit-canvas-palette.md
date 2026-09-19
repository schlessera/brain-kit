---
"@schlessera/brain-ui-kit": minor
---

The canvas palettes get a paper set (seventh drop, §L6).

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

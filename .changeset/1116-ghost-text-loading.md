---
"@schlessera/brain-ui-kit": minor
---

Loading is ghost text. `Placeholder`'s `loading` variant, `StreamingAnswer`,
`ActionCard`, `QueueItemRow`, `SearchResultCard` and `FileRow` no longer draw
breathing skeleton bars: they draw blurred text in the replaced content's type
role and length, with the kit spectrum sweeping through it, and cross-fade to
the real content over 600ms when that item's data lands. The frame, icons and
dot slots are final from the first frame, so the layout does not move.

New: `Placeholder` takes `ghost` (the blocks it stands in for, each
`{ length, role, size? }`), `seed`, and `arrived` with the real content as
children; `lines` stays as the neutral fallback, and `barHeight` is ignored.
`QueueItemRow` and `SearchResultCard` take `index` to stagger the sweep down a
list, and `SearchResultCard` takes `snippetLength` to size its snippet ghost.
`StreamingAnswer` ghosts behind the answer until its first token (`bars` and
`lines` now describe that ghost, and the answer holds that height while it
streams); the first chunk fades in over the same 600ms, and later characters
settle in from 0.2 opacity as they stream. Ghost glyphs are seeded per
component instance, so re-ranking a list never regenerates them. New `--bk-ghost-*` tokens in both themes; reduced motion shows the
ghost as plain blurred text, with no sweep or spectrum, and makes the handoff
instant; print hides it.

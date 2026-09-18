---
"@schlessera/brain-ui-kit": minor
---

The light theme, from the second design drop. Every colour token is now
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

---
"@schlessera/brain-ui-react": minor
---

The sixth drop's pane rulings (D38 §3, §4, §7, §8).

The Files evidence rail never collapses: with a file open the column stays
mounted and each block is drawn only when its data exists. A Modified block
is built from the file's own `mtime` against a 30-day threshold (the design
gives no number; the constant is named) and turns gold past it, and the tree
marks a stale file the same way. "Untrusted only" is drawn disabled with its
reason — provenance does not exist yet — never omitted. The tree binds `←` /
`→` to fold through the kit `FileRow`'s new `onFold`, and the footer prints
`← → fold · ⏎ open` regardless of the single-key switch, since arrows are not
single keys.

Dismissing inbox items is silent: no receipt without undo. Approval decisions
keep theirs, because their effect happens in the run, out of sight.

The graph's colouring modes gain `entity` (person · company · project, the
kit's own entity tones) beside topic, distance and folder; the caption and
the legend follow the active rule.

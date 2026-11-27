---
"@schlessera/brain-ui-react": patch
---

An inline `show_block` result keeps its identity across the frames of its answer (#4749). The answer reads the block's payload through the per-tool-call cache, so an unchanged call is parsed once and hands the card the same payload on every render; `BlockCard` is memoized, and the map block builds the frames it hands `PlaceMap` once per plan and geometry. Blocks draw the same content; a call replaced by a new object with a new output still redraws its block.

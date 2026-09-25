---
"@schlessera/brain-ui-sdk": patch
---

The classification detector no longer drops text. A list item that holds any block besides paragraphs (a quote, a heading, a definition) now keeps its list as markdown instead of offering it as an ordered or timed list without that block, and a hard break reads as a space in a quote, its attribution or a list item, so `Sail` and `home` on either side of one no longer run together as `Sailhome`.

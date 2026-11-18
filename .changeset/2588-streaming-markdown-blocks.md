---
"@schlessera/brain-ui-react": patch
---

A streaming answer no longer re-parses its whole text on every frame. Each top-level markdown block now parses on its own, and a finished block is skipped while the answer grows, so only the growing last block re-parses, and its re-parse is deferred behind input and scrolling. Appending to a 24 KB answer went from a 23 ms median render to under 3 ms (desktop). What renders is unchanged. A text holding a link reference or footnote definition, or an HTML block that may contain blank lines, still parses whole, as does a single long growing block.

---
"@schlessera/brain": patch
---

`brain doctor`'s `instructions-weight` check now finds code in `CLAUDE.md` with the same GFM parser `brain audit` uses. An `@path` inside a fence within a blockquote or a list item, or inside an indented code block, is no longer counted as an import.

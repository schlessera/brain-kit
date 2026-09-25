---
"@schlessera/brain": minor
---

`brain_read` takes optional `section` and `max_tokens`, and `brain read` takes `--section <heading>` and `--max-tokens <n>`. A section runs from its heading to the next heading of the same or higher level. When the result would be over the token limit, you get the frontmatter and an outline of headings with estimated token counts, plus a note on how to ask for one section. Without either option, the whole file comes back exactly as before.

Sections are found by parsing the body as GFM, so a heading inside code, HTML, a table, a list or a blockquote never opens or ends one. A heading is matched on its visible text under Unicode full case folding. `@schlessera/brain` now depends on `remark-parse`, `remark-gfm`, `unified` and `mdast-util-to-string`, the same versions `@schlessera/brain-ui-sdk` already uses.

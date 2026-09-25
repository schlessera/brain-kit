---
"@schlessera/brain": minor
---

`brain_read` takes optional `section` and `max_tokens`, and `brain read` takes `--section <heading>` and `--max-tokens <n>`. A section runs from its heading to the next heading of the same or higher level. When the result would be over the token limit, you get the frontmatter and an outline of headings with estimated token counts, plus a note on how to ask for one section. Without either option, the whole file comes back exactly as before.

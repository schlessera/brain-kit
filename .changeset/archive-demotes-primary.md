---
"@schlessera/brain": minor
---

`brain archive` and the `brain_archive` tool now set `relevance: historical` when the document's relevance is `primary` or missing. An explicit `secondary` or `historical` is left alone. Before, archiving a primary document left it claiming `primary`, so it still took the primary search boost whenever archived documents were included. `brain validate` now warns on any document with `status: archived` and `relevance: primary`, and the message names the fix. It does not rewrite existing files.

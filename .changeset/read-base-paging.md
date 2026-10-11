---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

**Breaking (MCP contract):** an unranged `brain_read_base` on a document too large for one tool result (over 40,000 JSON-escaped characters) no longer returns `content`. It returns the base hash, the size and the first page of lines with a paging hint, so the Claude Agent SDK no longer spills the result to a file where the hash cannot be reached. To get the whole text, read the pages in turn with `offset` (and `column`). Documents within the budget still return `content`.

`brain_read_base` now puts `expectedBaseHash` first and adds `bytes` and `lines`. It also accepts optional `offset`/`limit`/`column` to page through a document; `limit: 0` returns only the hash and size. Every result carries the hash of the whole document, so the write tools' base guard is unchanged.

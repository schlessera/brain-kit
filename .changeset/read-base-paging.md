---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

`brain_read_base` now puts `expectedBaseHash` first and adds `bytes` and `lines`, so a hosted agent can always get a document's base hash. It accepts optional line-range `offset`/`limit` for reading a document in pages, and `limit: 0` returns only the hash and size. A document too large for one result returns its first page with a paging hint instead of the whole text, which the Claude Agent SDK used to spill to a file. Every page carries the hash of the whole document, so the write tools' base guard is unchanged.

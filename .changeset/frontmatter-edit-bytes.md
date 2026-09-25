---
"@schlessera/brain": minor
"@schlessera/brain-backend-pi": patch
---

Archiving a document and `brain_update` (over MCP and in the pi backend) now change only the frontmatter keys they set. Every other byte is kept: YAML comments, quoting, key order, flow or block sequences, blank lines, and the body. Before, the whole frontmatter block was re-serialized, so a one-field change dropped comments and restyled lists. A value in a form the new editor does not rewrite (a block scalar, a multi-line flow sequence), or an edit that would not read back exactly as asked, falls back to the old serializer. `@schlessera/brain` exports the editor as `editFrontmatter` and `updateDocument`.

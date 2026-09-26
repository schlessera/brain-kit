---
"@schlessera/brain": minor
"@schlessera/brain-backend-pi": patch
---

Archiving a document and `brain_update` (over MCP and in the pi backend) now change only the frontmatter keys they set. Every other byte is kept: YAML comments, quoting, key order, flow or block sequences, blank lines, and the body. Before, the whole frontmatter block was re-serialized, so a one-field change dropped comments and restyled lists. A value in a form the new editor does not rewrite (a multi-line flow sequence, a multi-line plain scalar, a flow map, keys indented under the fence), or an edit that would not read back exactly as asked, types included, falls back to the old serializer. Block scalars (`summary: |`) and quoted keys are edited in place, comment and blank lines inside a value are kept, line endings are kept, and a date-like list entry is quoted so it stays a string. A quoted key spelled with escapes (`"sta\u0074us"`) also falls back. `@schlessera/brain` exports the editor as `editFrontmatter` and `updateDocument`.

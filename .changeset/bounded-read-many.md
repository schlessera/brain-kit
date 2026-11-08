---
"@schlessera/brain": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-ui-server": minor
---

A bounded multi-document read (#3642). The MCP tool `brain_read_many`, pi's tool of the same name and `brain read-many --json` read up to 20 documents or sections in one call and keep the whole JSON answer within `max_total_chars` (default 24,000; 2,000 to 40,000) and each item within `max_item_chars` (default 8,000), counted as characters of the serialized JSON with metadata and escaping. Items keep request order and are `full` (exactly what `brain_read` returns), `outline` (frontmatter when it fits, headings with estimated tokens), `partial` (a page with `next.offset`/`next.column` to continue; the pages join back to the exact text), `duplicate` (of an earlier request for the same file and section) or `error` (a code such as `refused`, `not_found`, `section_not_found`, `source_changed` or `budget_exhausted`, and a message that never contains a host path). Each item carries its file's `sha256`; passing it back as `expected_sha256` reports a file that changed instead of mixing versions. Every request is contained and refused exactly as a single `brain_read` is, a call stops between files when cancelled, and invalid input is refused rather than clamped. Both chat backends auto-allow it as they do `brain_read`, the Claude voice posture includes it, and it takes no lock. `brain_read` and the hosted `brain_read_base` are unchanged.

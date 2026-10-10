---
"@schlessera/brain": patch
---

The CLI, the MCP server and `brain doctor` now decide whether an embedding or
completion provider is usable in one place, from the key variable each built-in
declares. `brain doctor` no longer asks for `GEMINI_API_KEY` when the embedding
provider is a custom value, and an unknown built-in embedding name is reported
whether or not `GEMINI_API_KEY` is set.

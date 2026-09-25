---
"@schlessera/brain": minor
---

`brain_search` results now carry `status`, `summary`, `updated` and `deadline`, so an agent can tell whether a hit is current without reading the file. `brain search --json` results and `brain list --json` documents gain `deadline` too. The JSON text copy of every MCP result is now compact instead of pretty-printed, which saves tokens on each call; it still parses to the same object as `structuredContent`.

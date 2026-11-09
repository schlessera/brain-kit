---
"@schlessera/brain": minor
"@schlessera/brain-backend-pi": minor
---

Context briefings take an explicit path scope (#3644). `brain context --include <path> --exclude <path>` (both repeatable), the MCP `brain_context` tool's `include` and `exclude` inputs, and pi's `brain_context` parameters of the same names keep every lane of the briefing inside the scope: the identity and current-focus documents, the search pool and each hit's section, and the related neighbours. An entry is an exact repository-relative file path, or a folder ending in `/`; an exclusion always wins, matches any casing of the path and follows symlinks, and an excluded file is never opened. Each list holds at most 64 entries of up to 512 characters, and an invalid entry is refused before anything is read. A scoped briefing also reports its coverage, which excerpts it holds (path, lane, form) and which requested or in-scope paths it left out and why (`budget`, `unavailable`, `not_ranked`, `excluded`), and states that it is not an inventory: as `coverage` in MCP `structuredContent` and pi's tool `details`, and as a `### Coverage` note after the context on every surface. Calls without a scope are unchanged.

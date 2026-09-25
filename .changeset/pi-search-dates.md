---
"@schlessera/brain-backend-pi": minor
"@schlessera/brain": minor
---

The pi backend's `brain_search` tool takes the same date inputs as the MCP tool: `updated_since`, `updated_before`, `deadline_from` and `deadline_to` (inclusive `YYYY-MM-DD`), `sort` (`score`, `updated` or `deadline`) and `upcoming` (deadline from today, sorted by deadline). An invalid date or sort is a tool error. `@schlessera/brain` now exports `isIsoDate` and `SEARCH_SORTS`.

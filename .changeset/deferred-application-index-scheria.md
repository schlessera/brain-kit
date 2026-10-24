---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

A hosted application (`brain_add`, `brain_update`, `brain_archive`, `write_file`, `edit_file`, `apply_staged_changes`) returns as soon as its Markdown is committed, instead of re-indexing the brain first (#2835). On a 2,000-note brain that wait was about 4 s per write. Breaking before 1.0, ruled on #2835: a successful result now reports `indexed: false` with the new `indexStatus: "pending"` while its index update is queued, and `indexed: true` only after an update completed. The Markdown write, its durability and its refusals are unchanged.

The changed paths are batched and indexed in one targeted update, in the same isolated maintenance worker, at the next read that needs the index or at the end of the turn. Every such read waits for it: the brain's MCP tools, pi's `brain_search`, `brain_context`, `brain_read`, `brain_list` and `brain_graph`, the shell, `brain_add` planning, and the server's `/api/brain/search`, `/list`, `/stats`, `/briefing` and `/api/graph/*` routes. When the update fails, the read is refused with the committed paths and the error instead of returning stale results, `brain_add` refuses with `index_stale`, `/api/*` answers `503` with `code: "index_stale"`, and the paths stay queued for the next try. Activity records each outcome as a `brain_application_index` event after the application it follows.

`BackendBridge` gains optional `awaitIndex(toolName)`, which the Claude and pi backends await before admitting every tool. `indexAll` in `@schlessera/brain/internal` accepts `paths` for a targeted run that leaves the index as a fresh build would. The standalone `brain add --json` keeps its synchronous `indexed`.

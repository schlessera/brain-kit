---
"@schlessera/brain": minor
---

`brain.db` moves to `schema_version` 9, which adds an index on
`links(target_id)`. Asking what links to a document — `brain_graph` with
`direction: "incoming"` or `"both"` — used to read the whole `links` table once
per visited node; it is now an index lookup. An existing brain gains the index
the next time it is opened writable — the MCP server starting, `brain index`,
`brain sync` or any other command that writes — with no reindex. No table or column changed, so readers that accept schema 8 read 9
unchanged.

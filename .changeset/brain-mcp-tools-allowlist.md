---
"@schlessera/brain-backend-claude": patch
---

Auto-allow the brain's own MCP document tools in the Claude backend

`DEFAULT_ALLOWED_TOOLS` now covers `mcp__brain__brain_{search,context,read,list,graph,add,update}`.
Since the brain repo started registering the CLI's MCP server project-scoped in
`.mcp.json`, those tools reached the model but were absent from the allowlist,
so every `brain_read` raised an approval card. `Write` and `Edit` were already
auto-allowed, so withholding `brain_add`/`brain_update` only pushed the model
onto the raw-file path, which skips frontmatter and the reindex.

`brain_archive` stays behind an approval card — it moves files between
directories.

Also fixes a latent write-serialization gap: all three brain writers are now in
`MUTATING_TOOLS`, so they take the cross-session write lock like `Edit` and
`Write`. Previously two parallel sessions could reindex the repo concurrently.

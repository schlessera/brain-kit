---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-module-jobs": minor
---

A strict, voice or autonomous turn now sees its own applications in the same turn (#2848). Its worker reads a turn data tree at `/tmp/brain-worker-data`: the documents as the turn started plus every change the turn's host applications committed, with a search index the server brings up to date before the next search. `brain` commands in either shell, Claude's `brain` MCP server and pi's brain tools, `read_file`, `grep`, `brain_read` and shell use it as their data root, while `brain.config.ts`, modules and module settings still load from the frozen view at the brain path. A peer's change made during the turn does not enter it. Admission copies the startup documents into the tree and seeds its index (about 0.1-0.4 s on 2,000 notes).

Claude's `Read`, `Grep` and `Glob`, and shell commands that name the brain path, still see the turn-start bytes. A Claude `Read` of a file the turn changed is refused and names `mcp__brain__brain_read`, which reads the current version.

A provider-restricted turn's own applications now reach its private search index too (#2846), and no masked document does: a change enters only if its path is outside the masked folders, neither its result nor its base declares a type the recipient may not see, and its base is what the turn could already see, never a peer's. Such a turn's `brain_add` plans on its own data tree and index, in a masked worker. The private index is now read-only to the agent: `brain index` and `brain` CLI captures inside a masked turn fail, and the server keeps it current instead.

Core maps a worker's `BRAIN_WORKER_CONFIG_ROOT` back to its `BRAIN_WORKER_DATA_ROOT` during root discovery, and readers there retry `SQLITE_READONLY_RECOVERY` and `SQLITE_BUSY_RECOVERY` a bounded number of times. `@schlessera/brain/module` exports `configurationRoot(root)`; jobs scoring reads `settings/jobs.json` and its criteria document through it. `BackendBridge.awaitIndex` takes the tool's input as an optional second argument.

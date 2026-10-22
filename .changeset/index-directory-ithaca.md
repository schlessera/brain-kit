---
"@schlessera/brain": minor
"@schlessera/brain-common": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-pi": minor
---

Keep the disposable search index in its own `.brain-index/` directory: `brain.db`, its SQLite sidecars and the embedding lock move from the brain root to `.brain-index/brain.db`. Breaking before 1.0, ruled in #1668 (option B): a direct SQL reader opens the new path. The schema and every CLI, MCP and HTTP shape are unchanged. An existing brain migrates by rebuilding, never by moving: the first writable command creates the directory and `brain index` fills it. The old root-level files are ignored; `brain doctor` reports them as `legacy-index` and `--fix` deletes them. ui-server now requires a content CLI of at least 0.44.0, deletes the old root-level index at boot and starts one index run. While a governance policy names provider folders, every governed writer retains `.brain-index/` like a provider folder, and publication refuses to remove or replace it.

---
"@schlessera/brain": patch
---

- Changed: `sync post-sync` commits and pushes the sidecar caches its reindex rewrites, so a sync no longer ends with a dirty tree.
- Added: `cacheCommit` and `treeDirty` fields on `sync post-sync`; `sync` reports `"dirty"` when anything is left uncommitted.
- Added: `DERIVED` class in `sync assess` for the sidecar caches, so the skill stops committing a stale copy the later reindex supersedes.
- Fixed: `sync assess`/`group` dropped the first character of the first changed path when it was modified-but-unstaged (`.context-cache.jsonl` reported as `context-cache.jsonl`).

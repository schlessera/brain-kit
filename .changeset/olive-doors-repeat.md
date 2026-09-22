---
"@schlessera/brain": minor
---

- Changed: `sync post-sync` commits and pushes the sidecar caches its reindex rewrites, so a sync no longer ends with a dirty tree. The commit carries only those caches: anything already staged stays staged and uncommitted.
- Added: `cacheCommit` and `treeDirty` fields on `sync post-sync`; `sync` reports `"dirty"` when anything is left uncommitted.
- Added: `DERIVED` class in `sync assess` for the sidecar caches, so the skill stops committing a stale copy the later reindex supersedes.
- Changed: `sync pull` drops local changes to the sidecar caches before merging and reports them as `restoredCaches`. The reindex after the pull rebuilds them from `brain.db`, and a rewritten cache no longer fails the merge when another clone pushed its own.

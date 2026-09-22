---
"@schlessera/brain": minor
---

- Changed: `sync post-sync` commits and pushes the sidecar caches its reindex rewrites, so a sync no longer ends with a dirty tree. The commit carries only those caches: anything already staged stays staged and uncommitted.
- Added: `cacheCommit` and `treeDirty` fields on `sync post-sync`; `sync` reports `"dirty"` when anything is left uncommitted.
- Added: `DERIVED` class in `sync assess` for the sidecar caches, so the skill stops committing a stale copy the later reindex supersedes.
- Changed: `sync pull` sets local changes to the sidecar caches aside while it merges, then unions this clone's entries back into the merged copy, reported as `mergedCaches`. A rewritten cache no longer fails the pull when another clone pushed its own. A conflicted cache is resolved the same way instead of being handed to conflict resolution, and when git refuses the merge outright the caches are put back untouched.

---
"@schlessera/brain": patch
---

`brain sync pull` now classifies a failed merge by what it left in the index. If paths are unmerged it reports `conflicted` and lists them, including when `branch.main.mergeOptions=--squash` stops the merge without a `MERGE_HEAD`. If nothing is unmerged it reports `merge-failed` with exit code 1, as the fast-forward path already did: git refused to start (for example, an uncommitted edit to a file the incoming commits change), a merge was left unfinished before the pull, or a hook rejected the merge commit. It used to report `conflicted` with an empty conflict list and exit 0 for those, which left the sync skill's conflict phase nothing to resolve. A cache conflict left by a squash merge is now resolved from its index stages like any other. The sync skill's Phase 3 now says what to do with `merge-failed`: show the user what blocks the merge and stop.

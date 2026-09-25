---
"@schlessera/brain": patch
---

`brain sync pull` now reports a merge that git refuses to start — for example because an uncommitted edit touches a file the incoming commits change — as `merge-failed` with exit code 1, as the fast-forward path already did. It used to report `conflicted` with an empty conflict list and exit 0, which left the sync skill's conflict phase nothing to resolve. A merge that stops on conflicts still reports `conflicted`. The sync skill's Phase 3 now says what to do with `merge-failed`: show the user what blocks the merge and stop.

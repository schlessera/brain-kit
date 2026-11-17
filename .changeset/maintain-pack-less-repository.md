---
"@schlessera/brain": patch
---

`brain maintain`'s git step and `brain storage pack` no longer fail on a repository that has no pack file yet, such as a newly created brain whose objects are all still loose, or one with no commits. Git's `incremental-repack` task refuses such a repository ("no pack files to index"), and older git releases such as 2.43 refuse even after the same run's `loose-objects` task has written the first pack. The step now leaves `incremental-repack` out while the repository has no pack. The `loose-objects` task still writes the first pack, so the step reports how many loose objects it packed. A repository that already has a pack runs the same tasks as before.

---
"@schlessera/brain": minor
---

`brain maintain` now packs the brain's git repository. When the brain is a git work tree, a new `git` step runs git's non-destructive `loose-objects`, `incremental-repack` and `pack-refs` maintenance tasks. Git's automatic gc counts loose objects rather than bytes, so a content repository's large images and PDFs could stay loose forever. `--no-git` skips the step, and a git failure fails the run like any other step. `brain doctor` gains a read-only `git-storage` check. It warns when loose objects exceed 100 MB, and when a `refs/original/` backup left by `git filter-branch` is keeping rewritten history alive. The removal command is shown as text and is never run, not even by `--fix`.

---
"@schlessera/brain": patch
---

`brain_update` and `brain_archive` now give the indexer `/`-separated paths on every platform (#4887). They built the paths of the files they changed with `path.relative`, which uses backslashes on Windows, while index keys and the markdown scan use `/`. A nested note's row could then stay stale, and a second spelling of its path could be inserted, until the next complete run.

---
"@schlessera/brain": patch
---

A file written just before its index run is no longer counted stale after that run (#4870). Before, `indexed_at` was the run's start cut down to the millisecond, so a file whose mtime fell in that same millisecond (common for `brain_add`, `brain_update` and `brain_archive`, which write a note and index it at once) was newer than its own row. The MCP read tools then warned `index is stale (1 file(s) newer than index)` until the file changed again. The stamp is now the run's start rounded up to the next millisecond, and the run reads no file until the clock has passed it, at most one millisecond later. A file changed after the run read it is still counted stale.

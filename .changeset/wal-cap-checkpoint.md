---
"@schlessera/brain": patch
---

`brain.db-wal` no longer keeps the size of the largest write for as long as a connection stays open. Writable connections now set `journal_size_limit` to 64 MiB, and every index run, including one that fails after writing, ends with a `wal_checkpoint(TRUNCATE)`. That empties the WAL unless another connection holds a lock, such as a read transaction left open. In that case the checkpoint gives up at once rather than waiting out the busy timeout, the run's own result or error stands, and its progress output says the checkpoint was busy. `brain stats` counts the WAL in `size.db.bytes`, so after an index run that figure drops back to the database itself.

---
"@schlessera/brain": patch
---

`brain.db-wal` no longer keeps the size of the largest write for as long as a connection stays open. Writable connections now set `journal_size_limit` to 64 MiB, and every index run ends with a `wal_checkpoint(TRUNCATE)`, which empties the WAL when no other connection is mid-read. If a reader holds a transaction open, the checkpoint gives up at once rather than waiting out the busy timeout. The run still succeeds, and its progress output says the checkpoint was busy. `brain stats` counts the WAL in `size.db.bytes`, so after an index run that figure drops back to the database itself.

---
"@schlessera/brain-ui-sdk": patch
---

Native index publication no longer refuses a refresh because a read-only search connection touched the index's SQLite wal-index. Before, a worker's `brain_search` reading the live index while a refresh was being prepared changed `.brain-index/brain.db-shm`, and the whole refresh failed with `stale maintenance output: .brain-index/brain.db-shm`. Search then kept serving the old index until a later refresh happened to succeed. Now the wal-index follows its database: it is replaced with a fresh empty file whenever `brain.db` or `brain.db-wal` publishes, so no new connection shares a wal-index an earlier reader still holds. A concurrent change to the database, its WAL or any other output is still refused. A changed stage file refused before or during its copy (`Native output changed before copy`) now names the inspected and the found stamp.

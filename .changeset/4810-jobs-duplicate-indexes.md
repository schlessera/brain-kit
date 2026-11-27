---
"@schlessera/brain-module-jobs": patch
---

Deduplication and the `duplicate_of` lookups no longer read the whole jobs table (#4810). Without planner statistics, SQLite preferred the index on the boolean `is_duplicate` column over the fingerprint index, so each duplicated fingerprint read every non-duplicate row, and every `duplicate_of = ?` statement (ingest refresh, delete, `jobs gc --purge`) scanned the table. `jobs.db` moves to internal schema version 3 on its first open: the `is_duplicate` index and three indexes no statement uses (`company_normalized`, `title_normalized`, `published_at`) are dropped once, and `duplicate_of` gains an index. An up-to-date database is opened without any write. `runDedup` now applies its duplicate marks in one transaction, so a failure part-way marks nothing. No column, `--json` output or MCP shape changes.

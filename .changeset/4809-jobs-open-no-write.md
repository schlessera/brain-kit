---
"@schlessera/brain-module-jobs": patch
---

Opening `jobs.db` no longer writes to it (#4809). Every open used to seed two `jobs_metadata` threshold rows with `INSERT OR IGNORE`, which takes the write lock even when it inserts nothing, so `brain jobs review`, the `jobs_review` MCP tool and the show, stats and search commands failed with `database is locked` while another process held a write for longer than the five-second busy timeout. Nothing read those rows (scoring takes its thresholds from the criteria file), so the seed and the unused internal `getMetadata`/`setMetadata` accessors are gone. Rows already present in an existing database are left as they are.

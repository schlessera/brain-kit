---
"@schlessera/brain-ui-server": patch
---

ui-server compiles each fixed-text SQLite statement once per connection instead of on every call (#4808). About 115 call sites, including the principal lookup every authenticated request runs and the statements of a draft save, now take their statement from `db.query`, which `bun:sqlite` caches per SQL string. The statements, their SQL text and their results are unchanged. `db.prepare` stays only where a cached statement would be wrong: a statement kept for a store's lifetime, SQL whose text varies per call, and the migration receipt insert.

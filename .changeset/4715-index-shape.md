---
"@schlessera/brain": patch
---

Internal (#4715): search reads which later tables and columns an index has from one per-connection answer cached under SQLite's schema cookie, so a repeated search no longer compiles a `sqlite_master` probe per table and a long-lived reader still sees a migration another process ran. The tokenizer of `documents_fts` is read in one place: a table built without a `tokenize` clause counts as `unicode61`, SQLite's default, and `porter unicode61` applies only when the table does not exist yet. Search results and index contents are unchanged.

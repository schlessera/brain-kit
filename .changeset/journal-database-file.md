---
"@schlessera/brain-ui-server": patch
---

Changed: the turn journal keeps its tables in its own SQLite file, `DB_PATH.journal.db`, attached to the UI database; they move there on the first start. Its capacity is that file's page count and WAL, with no b-tree walk on a journal write (#2789).
Changed: a steering change's governance event that did not commit with it is recorded again on start, from the journal.

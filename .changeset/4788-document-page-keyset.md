---
"@schlessera/brain": patch
---

A page of the paged document listing (`brain_list`, `brain list --cursor`) no longer reads the whole scope twice (#4788). The continuation predicate now lets SQLite search the `updated` index for the page instead of collecting and sorting every older row, and the scope's `total` and newest index run are read by two statements that each use an index instead of one that read every document body. Rows, order, `total`, cursors and the stale-cursor warning are unchanged; a cursor issued before this change is still accepted.

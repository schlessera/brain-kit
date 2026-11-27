---
"@schlessera/brain-ui-server": patch
---

Lookups on the hosted server's append-only tables read through an index instead of scanning the whole table (#4798): unfinished dialogue conversations and aliases by owner, an inbox item's budget reservations, a thread's resolutions, an interactive share by run, and a run's notification intents. The `inbox_changes_thread` index, which duplicated the table's `UNIQUE(thread_id, seq)`, is dropped; the uniqueness rule is unchanged. No query result changes.

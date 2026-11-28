---
"@schlessera/brain-ui-server": patch
---

Four lookups that run on every turn or inbox tick now search an index instead of scanning a table that grows for the life of the host (#5071). The safety ledger's history-owner scope is read by every turn, every safety write and each subscribed socket's one-second poll. The session-taint join, the inbox drain's budget reconcile and the autonomous budget totals are the other three. Migration `105_hot_path_lookups.sql` adds the four indexes. The two inbox budget ones are partial, so the existing, more selective indexes keep serving their other statements. No statement, result or row order changes.

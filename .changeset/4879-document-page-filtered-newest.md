---
"@schlessera/brain": patch
---

A paged document listing filtered by type, status, relevance or tag (`brain list --overview/--path-prefix/--cursor`, `brain_list`'s paged inputs, `pageIndexDocuments`) no longer reads the stored body of every matching document to find the scope's newest index run (#4879). The filter's own index now selects the matching ids, and the newest `indexed_at` comes from `idx_documents_indexed_at` alone. An index from before schema 16, which has no such index, keeps the earlier statement. `total`, the cursor fingerprint and the stale-cursor warning are unchanged for every scope, and no index is added.

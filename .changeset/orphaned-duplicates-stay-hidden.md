---
"@schlessera/brain-module-jobs": patch
---

When a re-scraped job joins an existing dedup group, a duplicate whose canonical
was deleted (by `jobs gc --purge` or a delete) stays hidden. Before, regrouping
released it back into the review queue.

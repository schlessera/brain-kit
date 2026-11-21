---
"@schlessera/brain-ui-server": patch
---

Batch changed-version storage reservations and durable pins, and maintain active journal summary and scope totals from committed deltas rather than rescanning turn history.

Keep private-file fallback within existing reader and staging capacity, recover interrupted hardlink publication, settle failed copy scheduling, and preserve conflict choices after overlapping peers end.

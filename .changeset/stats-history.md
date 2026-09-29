---
"@schlessera/brain": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Record `brain stats` over time (#581). `brain maintain` gains a `stats` step, run after the index and audit, that keeps the day's figures as one line of `.stats-history.jsonl` at the brain root: the counts, the health figures and the size totals, one snapshot per UTC day (a second run the same day replaces it), every day for 90 days and then one per week. The file is committed with the brain, so `brain index --force` and a fresh clone keep it; nothing indexes, validates or audits it. `brain stats --record` records on demand, and `brain stats --history [--since YYYY-MM-DD] [--json]` reads the snapshots back oldest first, one array per field, with `null` where a snapshot has no figure. `brain stats --json` is unchanged.

`GET /api/brain/stats/history` passes the history through, and the PWA's /stats answer draws trend charts for documents, orphans, stale documents, embedding coverage and the broken-link rate once two snapshots exist, and nothing with fewer.

---
"@schlessera/brain-ui-server": minor
---

Breaking change before 1.0: keep cron and other activity rollups unclassified when the root span has no valid recorded billing mode. Server credentials no longer supply a billing guess: billing mode, effective cost and its estimate flag stay unknown, while available list-price accounting remains visible. Explicit subscription/API billing and frozen historical costs retain their existing behavior.

Consumers that previously relied on environment-derived cron billing must treat missing recorded billing as unknown. Available list-price cost remains a reference rather than an effective spend estimate; no historical backfill is performed.

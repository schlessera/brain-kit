---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-ui-server": patch
---

Use completed response receipts for resumed Claude turns instead of the runtime's session-cumulative cost and model usage. Retain newly observed unstreamed usage separately and once in Activity and session totals, with explicit unknown attribution and partial coverage after missing history or counter rollback. Model identifiers retain their own counters across response snapshots and persisted reconciliation, including names that match inherited JavaScript properties.

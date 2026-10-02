---
"@schlessera/brain-ui-server": minor
---

Ship `brain-ui-inbox export/restore` for complete operational database and share-staging backups. Empty-target restoration preserves Activity spend, principal identities, decisions and completion receipts, then atomically reconciles lost workers before opening dispatch. Interrupted restores resume from the same checksummed artifact; the documented host recovery-point objective is 24 hours.

---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Add Google write engine contracts (#4211): strict mail approval cards and distinct once, always and session answers isolated from generic tool grants; atomic decision/inverse storage, card-owned send locks and session-state deletion; metadata-only reversible and irreversible governance receipts and journal labels. The host sequences exact per-use cards, live admission rechecks, durable recording before a single dispatch, unknown-outcome handling and automatic startup cleanup recovery; bounded structured write receipts contain no mail text. An exact card stays within `GOOGLE_APPROVAL_CARD_BYTES`, stays bound to the safety it was shown under, and only the brain's owner can answer it. Standing approvals, Gmail write operations and dedicated card controls arrive in their follow-up issues.

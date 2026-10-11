---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Allow reviewed handoffs to any available profile, including the source conversation's own backend. Every handoff starts a distinct linked conversation. Preselect the source profile when recovering from `session_too_large`, closing the single-backend dead end while preserving review, reference checks, recording and idempotency. This is an additive contract behavior change: the same-backend refusal is removed.

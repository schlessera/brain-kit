---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-backend-claude": minor
"@schlessera/brain-ui-backend-pi": minor
"@schlessera/brain-ui-server": minor
---

Reserve interactive capacity while limiting autonomous operations to two by
default. Shared locks prioritize interactive waiters and cooperatively yield
long autonomous holders after a configurable 20-second wait. Yield checkpoints
before abort, drains writers before recovering work, retains completed-call
receipts and incurred costs, and bounds repeated interruption with a single
dead-letter Action. Production autonomous dispatch remains disabled.

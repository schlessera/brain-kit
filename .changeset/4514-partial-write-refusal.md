---
"@schlessera/brain-ui-server": patch
---

A fetch denied before execution no longer stays an unresolved, unreviewable input when its result obligation failed to commit: the denial still proves non-delivery, so the attempt is retained in history and contributes zero unresolved inputs.

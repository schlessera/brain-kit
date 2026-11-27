---
"@schlessera/brain-ui-server": patch
---

A fetch denied before execution no longer stays an unresolved, unreviewable input when its result obligation failed to commit: the denial still proves non-delivery, so the attempt is retained in history and contributes zero unresolved inputs. The turn's end waits briefly for that denial, and any result under the ID, recorded or lost, even after the turn ended, makes the inputs unresolved again.

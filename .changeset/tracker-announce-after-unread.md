---
"@schlessera/brain-ui-react": patch
---

A tracker's failure, completion or question is no longer announced a second time after a recovery read that could not answer. A read that timed out or failed briefly turned the tracker into `can't check`, and the next read's same answer was announced again as a new change. The announcer now measures changes from the last state it saw settle, not from `can't check` or `unknown`, so work that moved on in the meantime is still announced.

---
"@schlessera/brain-ui-server": patch
---

The inbox lifecycle sweep no longer visits every queued staging cleanup on each tick to find work past its retention (#4993). Migration `104_inbox_work_expiry` adds a partial index of live work by status and expiry that leaves staging cleanups out, and the sweep's expired-work branch reads it, so its range ends at the sweep time. The sweep's rows, their order and the changes it makes are unchanged.

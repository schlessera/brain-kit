---
"@schlessera/brain-ui-server": patch
---

Keep turn admission independent of a running index when the verified policy hash already matches the healthy durable trust projection. Changed or unavailable policy still refreshes under the cancellable brain lock.

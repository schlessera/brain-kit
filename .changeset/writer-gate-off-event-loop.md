---
"@schlessera/brain-ui-server": patch
---

Changed: the hosted server commits the brain's writer gate on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#2850). Each gate transaction keeps its `BEGIN IMMEDIATE`, so it stays serialized against the cron runner's. A release is submitted at once and settles once it has committed; a host process spawns only after its downgrade has committed and the boundary is still the host fallback; a type folder translation that cannot be recorded refuses the turn.

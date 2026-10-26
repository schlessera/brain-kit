---
"@schlessera/brain-ui-server": patch
---

Changed: the hosted server commits authentication's per-request principal writes (the `last_seen_at` touch, terminal-principal pruning, ambient principal resolution and a login's new principal) on its SQLite write worker at `synchronous=FULL` instead of on the event loop (#2850). A request never waits for its touch; a login answers once its principal has committed.

---
"@schlessera/brain-backend-claude": patch
---

A Claude turn's own abort, such as an autonomous turn yielding at its checkpoint, again reaches a running worker only through the Agent SDK's close, which gives the runtime its grace period to finish its last request. Since the worker's probe and launch moved behind the deferred spawn, that abort had killed the worker at once, so a held continuation request could go unaccounted.

---
"@schlessera/brain-ui-react": patch
---

Bind push controls and post-login subscription registration to their UI instance.
Ignore stale browser and server responses, reset connection-gate probe/retry
state on instance changes, and require an explicit Enable click before replacing
a browser subscription bound to a different server key.

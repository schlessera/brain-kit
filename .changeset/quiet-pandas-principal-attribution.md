---
"@schlessera/brain-ui-server": minor
---

Resolve authorized HTTP and WebSocket requests to stable principals and attribute authenticated request logs. Ambient identities are retained safely with boot-time and throttled pruning, without consuming credential admission; their display labels are bounded and sanitized independently from identity. Console string attributes are quoted and escaped. `isWsAuthorized` now returns the resolved principal or null.

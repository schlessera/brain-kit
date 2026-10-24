---
"@schlessera/brain-ui-sdk": patch
---

A separate-UID worker's identity broker is now closed off the event loop on the asynchronous probe and on a failed asynchronous launch, together with its fallback cleanup and the governed launch's brain-view requests. The hosted server no longer stalls `/api/health` and WebSocket pings while the broker's control client runs on those paths. The synchronous forms are unchanged.

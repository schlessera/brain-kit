---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

A separate-UID worker's identity broker is now also closed off the event loop after an asynchronous launch has returned: when a turn releases the worker's last runtime-state or turn-temp handle, when the worker exits holding none, and after a failed supervision. The hosted server no longer stalls `/api/health` and WebSocket pings at the end of such a turn. Both backends await the close before they release the turn's storage reservation. A close the supervisor cannot confirm keeps the reservation charged and can be retried, and a worker's exit holding no handle now reports that refusal instead of dropping it. The synchronous launch is unchanged.

---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain-backend-pi": patch
---

Keep the hosted server answering while a turn's worker checks run. The per-turn worker host probe, the sandbox's scratch git check and the pi worker launch now wait on their bubblewrap workers without blocking the event loop, so `/health` and WebSocket pings no longer stall while a loaded host starts a worker. The checks, their order and their refusals are unchanged; the synchronous forms remain for callers that cannot await.

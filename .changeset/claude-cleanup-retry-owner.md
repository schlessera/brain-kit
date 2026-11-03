---
"@schlessera/brain-backend-claude": patch
---
A Claude turn whose worker cleanup the supervisor cannot confirm no longer keeps its runtime-state and turn-temp reservation until the server restarts. The turn still fails, but the backend now retries the cleanup a few times with growing delays and releases the reservation once a retry is confirmed. If every retry is refused, the server log names the allowance that stays charged. Shutdown stops the retries, logs what is still held and releases nothing.

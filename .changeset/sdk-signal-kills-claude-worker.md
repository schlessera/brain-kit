---
"@schlessera/brain-backend-claude": patch
---

Stop a cancelled Claude turn the way it was stopped before its worker launch became asynchronous. Cancelling a turn still halts a worker that is still being prepared, and a cancelled turn is no longer reported as a worker start failure. A worker that has already started is now ended by the Claude runtime's own stop, as before: the runtime first records the interrupted tool call and sends its follow-up request, so an escalated autonomous turn keeps its follow-up and its usage is charged in full.

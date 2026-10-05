---
"@schlessera/brain-ui-server": patch
---

Queue a message sent to a session whose turn has already streamed its result, instead of handing it to the backend's live `followUp()`. Between the result and the turn's end the backend has nothing left to deliver into, so the message was refused with `FOLLOWUP_FAILED` and lost; it now becomes the session's next turn.

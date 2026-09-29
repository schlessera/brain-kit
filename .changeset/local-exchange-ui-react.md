---
"@schlessera/brain-ui-react": minor
---

A `/stats` answer is part of the session (#582): in an existing session it is sent to the host with a plain-text rendering of its figures, so the agent sees them with the next message and a reload or a second device shows the answer again, drawn with the kit. In a draft conversation it is kept with the draft and sent with the message that starts the session. When it cannot be kept (no connection, or the host refused it), the answer still renders and says it was not saved to the conversation.

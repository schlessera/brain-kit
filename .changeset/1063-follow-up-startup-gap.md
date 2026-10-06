---
"@schlessera/brain-ui-server": patch
---

Stop losing a follow-up sent while a resumed or queued turn is still starting. The host handed such a message to the backend's `followUp()` as soon as the turn was registered as running, before the turn had reached the backend, so the Claude backend refused it and the message was dropped with `FOLLOWUP_FAILED`. The host now injects a follow-up natively only once the turn has been handed to `startTurn`, and queues it as the session's next turn before that. A follow-up that the backend still refuses with its "no running turn" `BackendRequestError` is queued the same way instead of being discarded, and keeps the local exchanges its refused prompt carried.

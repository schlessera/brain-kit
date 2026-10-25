---
"@schlessera/brain-ui-server": patch
---

Record a Claude memory note saved during a turn before that turn's journal closes, now that journal commits run off the event loop. A save still committing when the turn finished was refused after the note had already been written, and the turn ended partial with the note unconfirmed. A save requested after the turn finishes is refused before it writes, and a memory record no longer reuses the sequence of an observation that is still committing (#2893).

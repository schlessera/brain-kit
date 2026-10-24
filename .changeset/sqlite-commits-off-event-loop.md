---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
---

Changed: the hosted server commits turn-journal, Activity and native-lease SQLite writes on a write worker thread at `synchronous=FULL`, in submission order; the event loop awaits each commit instead of blocking in its fsync (#2814).
Changed (breaking for direct `TurnJournal` callers): journal writes that callers wait on (`bindSession`, `writeOperation`, Claude memory persistence, revert reservation, retained-version leases and retained streams) are asynchronous; `writeOperation` takes statements, and the journal exposes `ready` for its startup recovery.
Added: `StartTurnRequest.persistClaudeMemory` may return a promise; the Claude backend awaits it before persisting the next note or ending the turn.

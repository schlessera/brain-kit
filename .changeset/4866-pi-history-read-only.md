---
"@schlessera/brain-backend-pi": patch
---

Opening a pi chat's history no longer rewrites its transcript (#4866). The history read opened the file with pi's `SessionManager.open`, which rewrites a transcript saved by an older pi session version in its migrated form, writes a new header into an empty file and appends a newline to a last line without one. The read now parses the entries itself and migrates them in memory, so it returns the same history and leaves the file's bytes and modification time as they were. A non-empty file that is not a pi session is still refused with the same error. Resuming a chat still migrates its transcript, as before.

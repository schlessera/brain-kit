---
"@schlessera/brain-ui-server": patch
---

Ten JSON routes now apply the documented 262,144-byte request cap and answer 413 `{ error: "Request body too large" }` when a body declares or streams past it (#4756): starting a Storage scan, chat deletion, code history revert, marking a file untrusted, dictation settings, `POST /api/voice/session`, turn revert, creating and updating a voice persona, and `PUT /api/settings/voice`. They read through the same capped reader as every other JSON route instead of buffering whatever the server-wide request limit allows. Each keeps its own 400 for malformed JSON, and `POST /api/voice/session` still accepts a request with no body and ignores a non-JSON one without reading it. `POST /api/skills/install/zip` now counts the archive upload as it streams and refuses past the archive limit plus multipart headroom before the multipart parser runs, with the same 400 `Archive exceeds 100MB.` as before.

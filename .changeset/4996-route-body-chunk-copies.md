---
"@schlessera/brain-ui-server": patch
---

The draft, schedule, session-profile, voice-session, transcription, skill-archive and markup routes copy each request-body chunk as it arrives (#4996), as JSON routes and share already did. An in-process `Request` (an embedder's `app.fetch`) whose stream enqueues one buffer twice, changing it in between, now gets the answer the same bytes in separate chunks get. Requests over HTTP were not affected, and limits, statuses and messages are unchanged.

---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Refuse native file writes when a file's bytes changed since that live session read it. Preserve actual read-version truth, including Claude's cached unchanged-read responses, and keep Pi's observations across ordinary per-turn worker launches. Paths never read by the session remain writable. Read observations are held by the running backend and are not restored after a backend restart.

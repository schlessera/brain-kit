---
"@schlessera/brain-ui-react": patch
---

A device snapshot no longer rebuilds and serializes a draft whose object it already wrote, so typing in one draft serializes only that draft and not every draft with its images (#4746). A snapshot that changes only the work context (the session in view, focus, selection, review text) is written without reading every stored draft back. Draft records, forks, collisions and accepted transcripts are written as before.

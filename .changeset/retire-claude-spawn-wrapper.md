---
"@schlessera/brain-backend-claude": patch
---

Remove the unused child-only exec-wrapper spawn adapter. Ordinary turns continue to use the isolated worker launcher, including optional exec wrappers and worker-owned cancellation.

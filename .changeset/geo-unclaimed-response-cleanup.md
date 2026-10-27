---
"@schlessera/brain-geo": patch
---

Cancel unclaimed geo response bodies when a request aborts before acquiring its reader, including responses delivered after timeout or failed admission persistence. Keep the existing timeout budget, durable admission and cache behavior.

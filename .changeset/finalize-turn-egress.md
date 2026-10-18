---
"@schlessera/brain-ui-sdk": patch
---

Finalize active HTTP and CONNECT egress records synchronously and exactly once when a turn stops, so cleanup can observe audit failures before publishing its terminal outcome.

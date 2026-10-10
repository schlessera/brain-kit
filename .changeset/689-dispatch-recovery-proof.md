---
"@schlessera/brain-ui-server": patch
---

Internal only: the repository's dispatch fixture host can supply its own clock, so crash, lease-recovery and restore tests can drive the gated production dispatcher through elapsed lease and backoff time. No configuration, environment variable or default enables autonomous dispatch, and nothing a consumer can import changes.

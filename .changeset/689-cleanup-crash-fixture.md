---
"@schlessera/brain-ui-server": patch
---

Internal only: the repository's dispatch fixture host can stop staging compensation between removal and acknowledgement, so a crash there can be proven through the gated dispatcher. Nothing a consumer can configure or import changes, and no autonomous dispatch is enabled.

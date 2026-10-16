---
"@schlessera/brain-ui-server": patch
---

Keep successful Activity runs free of run-level failure reasons when a child tool failed and recovered. Child errors remain visible in the trace, and existing rollups are corrected when rolled up again.

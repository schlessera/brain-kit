---
"@schlessera/brain-ui-server": patch
---

Close the app-owned SQLite write worker during ordinary shutdown after its consumers and independent push deliveries drain, preserving accepted notification outcomes and retaining bounded diagnostics and counts for settled persistence failures through unconditional cleanup.

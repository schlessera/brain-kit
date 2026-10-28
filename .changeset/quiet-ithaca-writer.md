---
"@schlessera/brain-ui-server": patch
---

Close the app-owned SQLite write worker during ordinary shutdown after its consumers drain, including when another cleanup fails.

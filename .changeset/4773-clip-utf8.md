---
"@schlessera/brain-ui-server": patch
---

Internal: the autonomous-turn checkpoint and schedule admission bound their stored text with one shared `clipUtf8` (#4773). The cut is unchanged: at the last complete UTF-8 sequence at or below the byte limit.

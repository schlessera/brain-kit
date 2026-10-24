---
"@schlessera/brain-ui-server": patch
---

Changed: an ordinary journal write no longer walks SQLite's b-trees; it charges every page a journal commit has written, read from that commit's WAL frames, and pre-charges the pages it could newly own. The exact measurement runs only at startup, after another connection commits, and before any refusal (#2789).
Changed: governance event expiry no longer runs inside a journal write.

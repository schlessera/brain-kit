---
"@schlessera/brain-ui-server": patch
---

Apply the existing SQLite busy timeout before enabling WAL so server and cron startup can wait for a transient database lock instead of exiting immediately.

---
"@schlessera/brain-ui-server": patch
---

The generated crontab refuses a module cron job whose name the cron runner
trusts to run outside the exec wrapper (today only `digest`, the server's own
job). Module jobs are already named `<module>-<entry>`, so none could carry
that name; this keeps it true if the naming ever changes, using the same set
the runner checks.

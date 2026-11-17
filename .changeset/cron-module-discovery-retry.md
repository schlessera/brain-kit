---
"@schlessera/brain-ui-server": minor
---

`brain-ui-cron crontab` no longer drops every module job silently when module discovery fails at container start (#3381). Discovery is retried twice, after 5 and then 15 seconds, and each failed attempt names its cause on stderr: the `brain module list` exit code and stderr tail, unreadable output, a host that could not be qualified or reconciled, or a missing native configuration. When every attempt fails, the crontab still carries the core jobs, and the skip is recorded as a failed `modules` job in `cron_runs` and Activity, so `/api/status` shows it until a later start discovers the modules. A successful crontab is byte-for-byte unchanged.

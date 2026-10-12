---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
---

The server no longer runs the brain's own code, the `brain` CLI or git against the brain in a host process wherever a governed turn could have changed it (#1648). Capture planning and the index refresh behind `brain_add`, every server-spawned `brain` command, the streamed sync, cron jobs and git's ignore checks run in a maintenance worker instead: the same bubblewrap launcher, with the brain writable, the host read-only, and `/run`, `/var/lib`, the home directories and the UI database's directory masked. A malicious `brain.config.ts` import, `bunfig.toml` preload, `.env`, git include or symlinked ref therefore runs only inside that sandbox. Work a turn waits for runs without credentials or network and holds the brain's new writer gate shared; credentialed work (sync, reindex, capture, module actions) holds it exclusively and waits for running writers. Boot, and the cron runner before each job, quarantine any protected file a governed turn left behind after an unclean stop, beside the UI database.

`GET /api/status` gains `runtime.workerHost.governed`: whether the `governed` profile can run, why not (`server_cwd_in_brain`, `database_in_brain`, `worker_host_unavailable`), and whether the brain's code runs in workers or on the host. A server started from inside the brain reports `governed` unavailable. The generated crontab now starts every line with `cd /` and the cron runner gives each job the brain as its working directory; regenerate the crontab on upgrade. The brain's CLI must be installed inside the brain (`node_modules/.bin/brain`), not linked from a home directory. The Claude runtime version probe now runs outside the brain.

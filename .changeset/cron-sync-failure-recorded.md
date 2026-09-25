---
"@schlessera/brain-ui-server": minor
---

A cron `sync` run whose `brain sync` exits non-zero is now recorded as an error in the run history and the job log, instead of as a success. `BrainClient.sync()` throws on a failed sync, like the client's other commands, and on success returns `{ message }` holding what `brain sync` printed. The `success`, `commits` and `conflicts` fields are gone: `brain sync` prints the agent's text, so nothing could fill them.

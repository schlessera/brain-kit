---
"@schlessera/brain-ui-server": patch
---

The cron runner prices a gated job's provider-relay spend from the brain the job runs in (#4761). With `BRAIN_PATH` unset it used to read and write the model-pricing cache under `$HOME/brain` while the job ran in `/data/brain`; both now resolve from the cron configuration's own brain path. With `BRAIN_PATH` set nothing changes, and no environment variable or default changes.

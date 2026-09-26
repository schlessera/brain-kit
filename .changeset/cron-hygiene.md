---
"@schlessera/brain-ui-server": minor
---

The generated crontab gains a weekly base job, `hygiene` (Mondays 06:00). It runs `brain hygiene reconcile` through the same wrapper and `cron_runs` recording as `sync`, `validate` and `maintain`, so the content-hygiene log's backlog and last-run date keep moving without anyone running the skill. It edits no content. Set `BRAIN_UI_CRON_HYGIENE=off` to leave it out.

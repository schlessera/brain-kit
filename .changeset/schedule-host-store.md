---
"@schlessera/brain": minor
"@schlessera/brain-ui-server": minor
---

Store and inspect scheduled tasks on a UI host without running them. The new
`brain schedule add|list|cancel|due` commands talk only to the authenticated
host, and six protected `/api/schedules` routes back them: a proposal, a
verified operator approval, then publication of a Markdown definition under
`context/scheduled-tasks/` with its approved snapshot kept in the operational
ledger. Edited, missing or symlinked definitions quarantine the task; cancel is
idempotent and retires the file; `due` is read-only. Every task reports
`dispatch_disabled` until the Queue runtime ships. Proposals need the new
`BRAIN_UI_SCHEDULE_INFERENCE_ORIGINS` setting, `context/scheduled-tasks` is
excluded from indexing by default, and restore pauses restored schedules.

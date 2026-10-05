---
"@schlessera/brain": minor
"@schlessera/brain-ui-server": minor
---

Reopen scheduled tasks that a restore or an unknown effect paused. The new
`brain schedule reconcile <id> --key KEY` command and the protected
`POST /api/schedules/:id/reconcile` route record a verified operator decision,
checked against the approved definition bytes, the approved execution policy
and a usable creator. Reopening never replays an unknown occurrence, and a
restore now also ends lost attempts as `unknown` and drops their Queue work.
The UI server also gains the private occurrence admission boundary the Queue
runtime will drive (one admission per due instant, three operations and a
ten-minute deadline per attempt, crash recovery). Nothing wires it into the
running app yet, so tasks still report `dispatch_disabled`.

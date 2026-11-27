---
"@schlessera/brain-ui-server": patch
---

The turn budget receipt reads its session and day scopes through indexes (#4799). A new migration indexes `turn_budget_usage(started_at)`, `turn_budget_days(day_start)` and `activity_run_rollups(session_id)`, so admission and every completed model response no longer scan every turn the host has ever run while holding the write worker. The day scope sums each turn's days in one grouped read instead of one query per turn, and rows reach the totals in the order they did before, so receipts are unchanged to the last bit.

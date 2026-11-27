---
"@schlessera/brain-ui-server": patch
---

Internal: run settlement and the inbox dispatcher no longer ask SQLite whether `inbox_budget_reservations` and `schedule_occurrence_items` exist before using them (#4820). Every database the package opens has run the migrations that create both.

---
"@schlessera/brain": minor
---

`brain briefing` now opens with a warning line when the focus document is overdue for review (with the days overdue), over its `taxonomy.canonicalPolicy` token budget (with both numbers), or has lines naming a past date (with the count). The warnings come from the same checks as `brain audit`, so a stale focus document no longer reads as current. A current, in-budget focus document opens the briefing exactly as before.

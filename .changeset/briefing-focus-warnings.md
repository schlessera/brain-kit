---
"@schlessera/brain": minor
---

`brain briefing` now opens with a warning line when the focus document is overdue for review (with the days overdue), over its `taxonomy.canonicalPolicy` token budget (with both numbers), or has lines naming a past date (with the count). The warnings come from the same checks as `brain audit`, so a stale focus document no longer reads as current. A current, in-budget focus document opens the briefing exactly as before.

The warning lines show paths and dates as literal code, on one line, so a malformed `next_review` or a path with markup cannot break the briefing. A canonical path written as `./context/current-focus.md` now means the same document as `context/current-focus.md` everywhere canonical documents are looked up, including `brain audit` and `brain context`.

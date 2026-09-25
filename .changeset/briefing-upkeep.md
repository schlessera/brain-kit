---
"@schlessera/brain": minor
---

`brain briefing` gains an **Upkeep** section when the brain keeps a content-hygiene log (`context/hygiene/last-run.md` or `open.md`). It shows when content-hygiene last ran, how many days ago (marked `(overdue)` past 10 days), and how many entries are open. Overdue Reviews now lists the 5 oldest, then `… and N more (brain audit)`, and `--limit-reviews <n>` changes that cap. A brain without a hygiene log and with 5 or fewer overdue reviews gets the same briefing as before.

Overdue Reviews now lists reviews due before today, as `brain audit` counts them, so the audit it points to shows every review it leaves out. A review due today is no longer listed as overdue.

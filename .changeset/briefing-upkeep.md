---
"@schlessera/brain": minor
---

`brain briefing` gains an **Upkeep** section when the brain keeps a content-hygiene log (`context/hygiene/last-run.md` or `open.md`). It shows when content-hygiene last ran, how many days ago (marked `(overdue)` past 10 days), and how many entries are open. Overdue Reviews now lists the 5 oldest, then `… and N more (brain audit)`, and `--limit-reviews <n>` changes that cap. A brain without a hygiene log and with 5 or fewer overdue reviews gets the same briefing as before.

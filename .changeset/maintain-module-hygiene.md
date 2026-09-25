---
"@schlessera/brain": patch
---

`brain maintain`'s audit step now counts every enabled module's hygiene checks, as `brain audit` does, so the two report the same numbers. Before, maintain ran only the core audit. A finance ledger with a stale generated block showed up in `brain audit` and not in the maintain line the hosting cron logs. A module check that throws counts as one `module-hygiene` warning in both commands.

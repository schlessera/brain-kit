---
"@schlessera/brain": patch
---

`brain briefing` now lists stale documents by your taxonomy's staleness thresholds (`staleDays`, else `defaultStaleness`), the same rule `brain audit` and `brain stats` use, most overdue first. Before, it listed only `context` documents older than a fixed 30 days: a type with its own `staleDays` never showed up, and a brain with a different `context` threshold got a briefing that disagreed with its audit. The section is now headed `## Stale Documents` instead of `## Stale Context`, and each line keeps its form.

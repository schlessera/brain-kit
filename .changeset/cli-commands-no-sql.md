---
"@schlessera/brain": patch
---

Internal refactor (#1353): the `accept-mtime`, `briefing`, `doctor`, `eval` and `tags` commands no longer run SQL themselves; they call named index functions in core's library, and `brain briefing`'s Silently Modified section and `brain hygiene`'s silent-edit check now share one query. No command's output changes.

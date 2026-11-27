---
"@schlessera/brain": patch
---

Listing a broken link's repair handlers (`brain hygiene next`, `check` and `resolve`) walks the brain once instead of twice and tests membership against a set instead of scanning the file list once per file (#4777); `resolveHygiene` shares that one walk between its handler lookup, its containment check and its plan, while the write-time guards keep their own. `brain audit --fix` walks the tree at most once per run for its index-stale suggestions. Handlers, suggestions and JSON are unchanged.

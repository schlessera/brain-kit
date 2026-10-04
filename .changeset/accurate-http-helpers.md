---
"@schlessera/brain-ui-react": minor
---

Breaking: remove the nonexistent `health().version` declaration and expose `timestamp`; callers needing software identity must use authenticated `status()`.
Fix `brainSync()` to consume SSE terminal results and reject incomplete streams without retrying.

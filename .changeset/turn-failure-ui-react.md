---
"@schlessera/brain-ui-react": minor
---

A failed turn is shown as soon as it ends, not only after a reload (#575). The assistant row shows the `**Error:**` line it always showed for an error, and for a Claude subscription auth failure the #254 instruction for what to do next. A turn that fails before any text arrives no longer leaves an empty row. A partial answer stays above the error. One failure is shown once, even when a diagnostic error came first. The same turn reads the same after a reload. While the runtime is retrying a failed call, the row says so ("Retrying (attempt 2 of 10) in 5s after rate_limit, HTTP 429") in place of the thinking indicator.

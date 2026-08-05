---
"@schlessera/brain-module-jobs": minor
---

Ship three skills and make `jobs scrape` cover both source kinds in one run.

- **Skills** (`jobs-review`, `research-opportunity`, `interview-scheduled`) — the
  module shipped a CLI and no skills, so the conversational half of the workflow
  lived only in the reference brain. Generalized: no personal names, CV variants,
  or example slugs, and they read the configured `criteria` file and
  `opportunitiesDir` rather than hardcoded paths.
- **`scrape --browser` is now additive.** It ran *instead of* the API pass, so no
  single invocation ever covered both — and the module's own cron entry therefore
  silently omitted every browser-only board. `--browser` now appends the Chrome
  pass to the API pass, `--browser-only` keeps the exclusive behavior, and the
  cron entry is `jobs scrape --all --browser`. The Chrome pass probes for a
  reachable browser first and skips with a clear message when there is none, so a
  host without Chrome loses the browser boards rather than the whole scrape.

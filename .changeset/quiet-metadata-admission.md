---
"@schlessera/brain-ui-server": minor
---

Cancel queued module metadata when its HTTP caller disconnects or as soon as the app starts closing, so `/api/status` no longer holds `close()` open behind a busy output lock. Admitted metadata drains within the close grace period, like other shared runs, with database ownership retained until handlers settle. Add an optional admission-cancellation signal to `BrainClient.modules`.

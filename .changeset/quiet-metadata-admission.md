---
"@schlessera/brain-ui-server": minor
---

Cancel queued module metadata when its HTTP caller disconnects or the app closes, while draining admitted workers and retaining database ownership until handlers settle. Add an optional admission-cancellation signal to `BrainClient.modules`.

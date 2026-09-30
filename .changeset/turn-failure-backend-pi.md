---
"@schlessera/brain-backend-pi": minor
---

A pi turn whose provider call failed now ends with `outcome: "error"` (#575). pi does not throw for one: the turn's last answer ends with `stopReason: "error"`, and the backend used to report that turn as a success. The terminal `result` carries a `failure` with the provider's text, the status the text opens with, and the class that status implies. A thrown runtime error carries one too. `auto_retry_start` becomes a `status: "thinking"` frame with a `retry`. On reload, a failed answer carries its `failure`, and an attempt pi retried is no longer replayed.

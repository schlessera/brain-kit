---
"@schlessera/brain-ui-server": minor
---

The classification pass (D42): with `TYPESAFE_API_KEY` set, one call to
TypeSafe AI's Jev per finished turn, and only when the assistant text holds
a candidate, decides which of the kit's answer blocks each markdown table,
list, quote or key-value run is. The result is one `message_blocks` frame
after the turn's `result`, persisted per text part so history replays it.

Progressive enhancement is a hard rule: the whole call, one retry on
429/529 included, runs inside a 1 s budget, and a timeout, an error, a
missing key, or a low-confidence answer all leave the markdown exactly as
it streamed. No turn waits on the pass. Outcomes and latency are metered.

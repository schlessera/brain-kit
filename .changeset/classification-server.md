---
"@schlessera/brain-ui-server": minor
---

The classification pass (D42): with `TYPESAFE_API_KEY` set, one call to
TypeSafe AI's Jev per finished turn, and only when the assistant text holds
a candidate, decides which of the kit's answer blocks each markdown table,
list, quote or key-value run is. The result is one `message_blocks` frame
after the turn's `result`, persisted per text part so history replays it.

Progressive enhancement is a hard rule: the whole call, one retry on
429/529 included, runs inside a 2 s budget, and a timeout, an error, a
missing key, or a low-confidence answer all leave the markdown exactly as
it streamed. No turn waits on the pass. Outcomes and latency are metered.
A classifier that keeps failing is not asked: after three consecutive
failures a breaker opens and the pass is skipped for 30 s, doubling on
each failed probe up to 30 minutes, so a dead vendor or a bad link costs
one probe per window rather than a budget's worth of waiting per answer.

Persisted blocks are keyed by the exact text of the part, never a
whitespace-normalised form: the spans are offsets into that text, and a
differently laid-out part must not inherit them.

---
"@schlessera/brain-common": minor
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Add the `taint.judge` governance policy setting, `{ mode: off, floor: 0.9 }` by default. With `mode: jev` beside `taint.classifier: heuristics`, a tainted interactive session's outgoing call whose heuristic score falls in the ambiguous band is put to Jev (`jev-1.13.0`, pinned) instead of raising its card. Jev sees only the outgoing request (its body cut at 2,000 characters), the name of what tainted the session and the overlap score. A `benign` answer at or above the floor admits the call, and an `extraction` answer at or above it refuses the call. Any other outcome keeps the card: a lower or `suspicious` answer, no answer, a timeout, an open breaker, another answering model, an exhausted budget, or a provider rule that keeps the conversation's folders from `typesafe`. Each call is metered in the turn, conversation and day budgets as a `typesafe` attempt with the new operation `extraction_judge`. Voice turns never call the judge and keep refusing. `brain policy check` reports the resolved setting.

---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
---

A safety-recording failure now restricts only what it puts at risk, and the host recovers by itself (#3812, #3810).

- **One turn, before delivery.** A failed safety begin, or a refused reservation that delivered nothing, refuses only that turn with the new retryable `SAFETY_RECORDING_UNAVAILABLE` error. The chat and the brain stay usable.
- **One chat, after delivery.** Lost evidence marks only that chat with a permanent `recording_failed` gap. It keeps running under its tainted policy; other chats are untouched.
- **The brain, only when the evidence store cannot take a scoped fact.** New turns still run, restricted, each with a permanent gap written before anything is sent. The server keeps retrying and clears the latch itself once the gaps are durable. A turn is refused only if even its restricted start cannot be written (`safety_recording_paused`).
- **Boot** resolves a set latch and pending reservations automatically instead of refusing every turn.
- **Diagnosable.** Each latch keeps its first cause and a count in the database, logs one structured line, and is shown to the owner as `safetyRecording` on `/api/status`. Errors are no longer all labelled `capacity`. Every recovery is recorded with who or what ran it.
- **Owner fallback.** `POST /api/status/safety-recording/recover` runs the same recovery when nothing is open.
- **PWA.** A message refused this way says that safety recording failed or is paused, instead of "The brain refused this message."

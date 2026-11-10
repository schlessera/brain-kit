---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
---

A safety-recording failure now restricts only what it puts at risk, and the host recovers by itself (#3812, #3810).

- **One turn, before delivery.** A failed safety begin, or a refused record of a tool's input before the tool runs, refuses only that turn with the new `SAFETY_RECORDING_UNAVAILABLE` error. The chat and the brain stay usable. When the refusal is for spent room, it says what to do: start a new chat (`safety_recording_chat_full`), or that retrying won't help (`safety_recording_brain_full`). Room that running turns or pending writes still hold is a plain retryable refusal.
- **One chat, after delivery.** Lost evidence marks only that chat with a permanent `recording_failed` gap. That includes a tool result whose record fails or whose report the host refuses: the runtime may already keep it in its session. Stopping a turn while a tool runs still records that tool's result. Every tool call the host admits owes its result's record until that record is written, and nothing else settles it: no refusal proves that an admitted call never ran. So a call whose result never arrives (a turn stopped before the runtime reported it, or a server that died mid-tool) leaves the gap, and so does a call denied after its admission. A permission grant is never usable before the host's last check of the call has passed. A turn's end waits for a result record already under way, and a result's record and its settlement are written together. The chat keeps running under its tainted policy; other chats are untouched.
- **The brain, only when the evidence store cannot take a scoped fact.** New turns still run, restricted, each with a permanent gap written before anything is sent. The server keeps retrying and clears the latch itself once the gaps are durable and every turn that predates the latch has ended, including one begun restricted under an earlier latch. A turn is refused only if even its restricted start cannot be written (`safety_recording_paused`).
- **Boot** resolves a set latch and pending reservations automatically instead of refusing every turn.
- **Diagnosable.** Each latch keeps its first cause and a count in the database, logs one structured line, and is shown to the owner as `safetyRecording` on `/api/status`, also while only the server process holds it (`cause.durable: false`). Errors are no longer all labelled `capacity`. Every recovery is recorded with who or what ran it.
- **Owner fallback.** `POST /api/status/safety-recording/recover` runs the same recovery when nothing is open.
- **PWA.** A message refused this way says that safety recording failed, is paused, or has no room left and what to do, instead of "The brain refused this message."

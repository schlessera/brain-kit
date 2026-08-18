---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": patch
---

Bound a session's follow-up queue by bytes instead of by message count

`MAX_SESSION_QUEUE = 5` was a placeholder with no reasoning behind it, and it
measured the wrong thing: a queue of five sentences and a queue of five
four-image messages differ by roughly 50 MB, and only the second is a problem.
Every queued entry is held in the host process (attachments still base64) until
its turn runs.

- **20 MiB warns, 50 MiB refuses.** Past the warn mark the message is still
  accepted and the `queued` status carries a `detail` note saying how much is
  parked; the server logs it too. Past the hard cap it is refused with
  `SESSION_QUEUE_FULL`, naming both the parked total and what the rejected
  message needed — an explicit error frame, never a silent drop.
- **`MAX_SESSION_QUEUE` survives as a depth backstop, raised to 50.** Bytes do
  not bound count, and each entry becomes its own turn: ~500k one-line messages
  fit inside 50 MiB and would run a session for days.
- `queuedFollowUpBytes` / `queuedBytes` (ui-server `ws/turns`) do the
  accounting, measuring the payload as it arrived on the wire.
- The client stores the note per session (`queueNotes`) and the session drawer's
  Queued pill turns red and shows it on hover.

Only affects backends without native follow-up — with `capabilities.followUp`
(pi) messages go into the running turn and no host queue exists. The default
Claude backend is the one that queues.

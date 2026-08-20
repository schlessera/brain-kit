---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-server": minor
---

Fix the five rough edges carried over from the extraction review.

They were ported verbatim and never re-verified. All five were still real, and
every one fails silently — which is why they survived: nothing errored, data
just went missing or appeared in the wrong place.

- **A follow-up sent mid-stream dropped every delta that followed it.**
  `mutateLastAssistant` indexed the END of the buffer, so once the user's
  second message was appended the still-streaming assistant message was no
  longer last, `role === "assistant"` failed, and each write was discarded. The
  turn kept running and its output stopped appearing. It now finds the last
  ASSISTANT message.
- **Draft adoption could bind to another turn's session.** A client starting a
  conversation has no session id, so it adopted the first `session_info` or
  `result` for an unknown session — possibly an older background turn's, or
  another client's. `chat_message` gains an optional client-minted `draftId`,
  echoed on `session_info`, and adoption requires a match. Additive: a server
  that does not echo it falls back to the previous behaviour rather than
  leaving the draft unbound.
- **The file store showed one file's content under another's name.** Two rapid
  clicks raced and the SLOWER fetch won. Both the success and error paths now
  drop a response for a path the user has already navigated away from.
- **`whatsup` could deadlock.** stderr was only drained after
  `await proc.exited`, so a child that filled the pipe buffer blocked on write
  and never exited. It is drained concurrently with stdout now.
- **The SPA fallback 404ed deep links from an absolute static root.**
  `serveStatic({ path })` resolves against the process cwd, so
  `join(staticRoot, "index.html")` only worked when `staticRoot` was itself
  cwd-relative — true of the shipped layout, not of an embedder passing an
  absolute directory. The fallback serves the file directly now.

---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": minor
---

Show follow-ups that are still waiting for the agent, and keep them through a reload. A message sent while a session is busy no longer appears in the chat until the agent takes it: it waits as a `pending` pill in the right half of the row above the composer, and its full text opens on hover, keyboard focus or a tap. Three or more show the oldest pill and a `+N pending` summary that opens a read-only `Pending follow-ups` sheet. When the agent takes one, its pill goes and the message appears in the chat once, where it entered the conversation; a dropped one leaves with its reason. The host reports each session's queue in a new `session_queue` frame (`server_hello.capabilities.followUpQueue`, sent only to clients that declare the same flag in `client_hello`) after a reconnect, after `session_resume` and on every change, so a reloaded or second client rebuilds the same stack. The kit adds `PendingFollowUps` and `followUpLabel`, and `ListRow` gains `describedBy` for pills.

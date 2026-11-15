---
"@schlessera/brain-ui-server": minor
---

A stale draft save can no longer bring back a snapshot whose send the host already accepted (#3733). When an acceptance releases a snapshot and keeps the draft (a newer revision exists, or the draft changed chats), the draft now moves to a new revision. A tab or device that read the draft before the acceptance used to save its old list under its `If-Match`, and the sent snapshot came back as a new `dispatched` one: it took a slot of the chat's ten and its files went back to `outgoing`. That save is now `409 DRAFT_CONFLICT` with `current`, as the `If-Match` contract already allows. The single-slot `outgoing` write follows the same rule.

---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Let a client that reloads, reconnects or comes back to a session learn from
the host what that session's latest work actually is. A host now advertises
`server_hello.capabilities.sessionRecovery` and answers
`GET /api/sessions/:id/recovery` with the latest accepted request (its
`requestId`, the `turnId` that runs it, and whether it is queued, running,
terminal with its Activity outcome, or unknown), a persisted revision that
orders acceptance, and the approvals and questions still waiting in the
session. A newer queued request is never reported as an older success, a
restart never resurrects a lost queue or turn, and whatever the host cannot
prove reads `unknown`. Replayed history may carry a host-proven `turnId` on
the answer that ended each turn. A `session_resume` now re-sends the
session's pending approvals, and the transcript draws a turn shell holding
the card, marked `restored`, when the replay ends on the user's message, so a
reload no longer loses a pending approval. Additive: the `SessionRecovery*`
types, `sessionRecoverySchema`, `classifySessionRecoveryResponse`, the
optional `SessionHistoryMessage.turnId`, and the React API client's
`sessionRecovery()`.

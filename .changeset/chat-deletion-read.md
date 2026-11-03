---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
---

An owner can read one chat deletion's outcome with
`GET /api/chat-deletions/:operationId` (#3455), so a client that lost the reply
to `POST /api/chat-deletions` can ask what happened without deleting anything.
It answers the current receipt, including `pending`, `partial` and `unknown`
cleanup, or one content-free 404 `not_admitted` when nothing is retired under
that operation for the caller. The read never admits a deletion, retries or
resumes cleanup, and reveals nothing about other principals' operations. The SDK
adds `ChatDeletionNotAdmitted`.

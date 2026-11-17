---
"@schlessera/brain-ui-server": minor
---
Typed chats can now be deleted by their owner. When an authenticated typed request creates a backend session, the host records a content-free owner binding, so `POST /api/chat-deletions` accepts that chat from its owner. Chats created before this change still refuse as `unavailable`, and other principals get the same answer as for a chat that does not exist. The session catalog's `persistSessionStub` takes an optional `ownerPrincipalId`.

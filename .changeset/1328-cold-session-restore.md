---
"@schlessera/brain-ui-react": patch
"@schlessera/brain-ui-server": patch
---

After a reload, the chat no longer shows the welcome screen while the next message would go into the previously selected conversation. Until that conversation's history arrives, Chat says "Restoring conversation", the composer keeps the draft and explains why sending waits, and no message can be sent into it from any surface. The history request is confirmed rather than fire-and-forget: it is asked for again on the next connection, and once on the session's next idle status, and a request nothing answers ends after 20 seconds in "Couldn't restore this conversation" with Retry and New chat, as does a load error. Retry only reads the history again; New chat starts a new conversation without the old session id. Nothing is sent automatically once the history arrives. The host logs one `session resume` line per `session_resume`, with the session id and its outcome (`loaded`, `error` or `unauthorized`).

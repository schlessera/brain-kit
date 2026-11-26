---
"@schlessera/brain-ui-react": patch
---

A sent attachment row now gets its read state after a reconnect that happens while the previous reads request is still out. Before, the second `server_hello` skipped its read because a request was already in flight, the first answer was then dropped as stale, and the rows claimed nothing until the next reconnect or until the session was reopened. Now the dropped answer asks once more for the newer connection when the session is still in view and unread. At most one request per session is out at a time, and a failed answer on the current connection is still not retried.

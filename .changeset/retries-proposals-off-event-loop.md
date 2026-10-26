---
"@schlessera/brain-ui-server": patch
---

Changed: the hosted server commits retained retry requests, retry receipts and policy proposal inserts and review saves on its SQLite write worker at FULL durability. Retry invalidation remains fail closed while queued or failed, reservations commit before dispatch, and policy publication waits for its writing review to commit.

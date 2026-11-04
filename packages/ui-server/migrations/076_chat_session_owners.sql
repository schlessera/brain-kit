-- Typed chat owner bindings (#3337). When an authenticated typed request
-- creates a backend session, the host records which principal created it, so
-- explicit deletion can name that chat's owner. Content-free by construction:
-- no prompt, title, label, transcript or free-form text. Written only when the
-- session row is first created; never backfilled for chats that already
-- existed, which keep refusing deletion as unknown ownership. Nothing here
-- references a content table, and no paging, retention or catalog read joins
-- it: it is consulted only when a chat is resolved for retirement.
CREATE TABLE chat_session_owners (
  session_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

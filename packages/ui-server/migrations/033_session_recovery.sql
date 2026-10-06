-- Session recovery (#964, D52 §6). Host-owned operational metadata; the
-- backend transcript remains the conversation, and brain.db is untouched.
--
-- The latest request the host accepted for each session, and the revision
-- that orders acceptance. `revision` only grows: each accepted request takes
-- the next value. `turn_id` and `started_at` are filled in when that request's
-- turn is dispatched; a request that never runs keeps them null. No prompt
-- text, attachment or credential is stored. No foreign key: a session the
-- backend imported can be resumed before the catalog has a row for it.
CREATE TABLE session_work (
  session_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  request_id TEXT,
  turn_id TEXT,
  backend_id TEXT,
  accepted_at INTEGER NOT NULL,
  started_at INTEGER
);

-- Where each turn's last answer sits in the backend transcript, observed by
-- the host after the turn: the answer's position among assistant messages and
-- a digest of the transcript up to it, so an edited or rebranched transcript
-- never inherits a turn identity.
CREATE TABLE turn_boundaries (
  session_id TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  assistant_ordinal INTEGER NOT NULL CHECK (assistant_ordinal >= 0),
  prefix_digest TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  PRIMARY KEY (session_id, backend_id, assistant_ordinal, prefix_digest)
);

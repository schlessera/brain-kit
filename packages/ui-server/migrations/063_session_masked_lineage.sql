-- The folders a born-masked conversation kept masked from every one of its
-- turns (#2726). Only a new conversation whose first turn masked provider
-- folders, or a handoff from one, gets a row; every later admitted turn of it
-- narrows `masked` in place to what that turn masked as well, on an allowed
-- route too, so the row never widens and losing it loses the proof. A turn
-- that masks a folder outside it refuses to continue the conversation.
-- `masked` is a JSON array of repo-relative folders. A new session is named
-- after admission, so its row carries the turn until the session id binds it.
CREATE TABLE session_masked_lineage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL,
  session_id TEXT UNIQUE,
  masked TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX session_masked_lineage_turn ON session_masked_lineage(turn_id);

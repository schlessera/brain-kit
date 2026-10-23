-- Which proven inference recipient an admitted turn showed which provider
-- folders to (#2695). The provider history of a session keeps what its turns
-- read, so a later turn of the same session, or a handoff from it, whose
-- recipient may not see those folders is refused. `visible` holds the turn's
-- provider folders and `hidden` those still masked from it, both JSON arrays
-- of repo-relative folders. A new session is named after admission, so its
-- rows carry the turn until the session id binds them.
CREATE TABLE session_provider_exposure (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT NOT NULL,
  session_id TEXT,
  recipient TEXT NOT NULL,
  visible TEXT NOT NULL,
  hidden TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX session_provider_exposure_session ON session_provider_exposure(session_id);
CREATE INDEX session_provider_exposure_turn ON session_provider_exposure(turn_id);

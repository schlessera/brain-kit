-- One retained host measurement per conversation. Replaying it never measures state again.
CREATE TABLE session_state_room (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  observation TEXT NOT NULL
);

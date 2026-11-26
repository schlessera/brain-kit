CREATE TABLE google_send_locks (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  brain_id TEXT NOT NULL,
  account TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  host_epoch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  PRIMARY KEY (session_id, card_id),
  UNIQUE (brain_id, account, draft_id)
);

CREATE TABLE google_inverses (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  inverse_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  brain_id TEXT NOT NULL,
  account_identity TEXT NOT NULL,
  operation TEXT NOT NULL,
  decision_event_id INTEGER NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('prepared', 'confirmed', 'unknown')),
  inverse_json TEXT NOT NULL
    CHECK (json_valid(inverse_json) AND json_type(inverse_json) = 'object'),
  precondition_json TEXT NOT NULL
    CHECK (json_valid(precondition_json)
      AND json_type(precondition_json) = 'object'),
  snapshot BLOB,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, inverse_id),
  UNIQUE (session_id, call_id),
  CHECK (
    expires_at > created_at AND
    expires_at <= created_at +
      CASE WHEN operation = 'gmail.trash'
           THEN 2592000000 ELSE 604800000 END
  )
);
CREATE INDEX google_inverses_expiry ON google_inverses(expires_at);

CREATE TABLE google_session_allowances (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  brain_id TEXT NOT NULL,
  account_identity TEXT NOT NULL,
  operation TEXT NOT NULL,
  entity TEXT NOT NULL,
  host_epoch TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  granted_card_id TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
    CHECK (expires_at > granted_at
      AND expires_at <= granted_at + 86400000),
  remaining_items INTEGER NOT NULL
    CHECK (remaining_items BETWEEN 0 AND 100),
  PRIMARY KEY (
    session_id, principal_id, brain_id,
    account_identity, operation, entity
  )
);

CREATE TABLE google_calendar_handles (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  handle TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  brain_id TEXT NOT NULL,
  account_identity TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  event_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, handle)
);

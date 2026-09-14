CREATE TABLE principals (
  id            TEXT PRIMARY KEY NOT NULL,  -- 22 chars base64url, server-generated
  kind          TEXT NOT NULL CHECK (kind IN ('owner','agent','ambient','system')),
  auth_method   TEXT NOT NULL CHECK (auth_method IN ('password','passkey','delegated','ambient')),
  label         TEXT NOT NULL,              -- ≤64 chars, never rendered as HTML
  credential_id TEXT,                       -- passkey_credentials.id, else NULL
  created_by    TEXT,                       -- minting principal, for delegation
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX idx_principals_live ON principals(revoked_at, expires_at);

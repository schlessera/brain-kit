-- WebAuthn passkey credentials (single-user app: no user_id column).
-- rp_id scopes each credential to the relying party it was registered on
-- (localhost dev credentials and prod-domain credentials coexist).
CREATE TABLE passkey_credentials (
  id TEXT PRIMARY KEY,                  -- base64url credential id
  public_key BLOB NOT NULL,             -- COSE public key bytes
  counter INTEGER NOT NULL DEFAULT 0,   -- signature counter (0 forever for cloud passkeys)
  transports TEXT,                      -- JSON array, e.g. ["internal","hybrid"], or NULL
  rp_id TEXT NOT NULL,
  aaguid TEXT,
  device_type TEXT,                     -- 'singleDevice' | 'multiDevice'
  backed_up INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX idx_passkey_credentials_rp_id ON passkey_credentials(rp_id);

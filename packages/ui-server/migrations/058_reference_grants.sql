-- Owner-managed reference-source grants (#2429). A live grant is the only
-- authority for private reference acquisition: it binds one served brain, one
-- principal, one repository prefix and one named existing host credential (or
-- none). A configured host credential never grants access by itself.
CREATE TABLE reference_grants (
  id                TEXT PRIMARY KEY NOT NULL,  -- server-generated, base64url
  brain             TEXT NOT NULL,              -- served brain identity at grant time
  principal_id      TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  repository_prefix TEXT NOT NULL,              -- canonical repository URL prefix
  credential        TEXT,                       -- named host credential, or NULL for none
  created_by        TEXT NOT NULL,              -- granting owner principal
  created_at        INTEGER NOT NULL,
  revoked_at        INTEGER
);
CREATE INDEX idx_reference_grants_principal ON reference_grants(principal_id, revoked_at);

-- Revocation cannot be undone by restoring an old principal row or policy.
CREATE TRIGGER google_allowances_principal_change
AFTER UPDATE OF kind, auth_method, expires_at, revoked_at ON principals
BEGIN
  DELETE FROM google_session_allowances WHERE principal_id=OLD.id;
END;
CREATE TRIGGER google_allowances_principal_delete AFTER DELETE ON principals
BEGIN
  DELETE FROM google_session_allowances WHERE principal_id=OLD.id;
END;
-- A known full hash changes brain-wide policy; missing evidence affects only its chat.
CREATE TRIGGER google_allowances_policy_change AFTER UPDATE OF policy_hash ON safety_collections
BEGIN
  DELETE FROM google_session_allowances WHERE (NEW.policy_hash IS NOT NULL AND policy_hash<>NEW.policy_hash)
    OR (NEW.policy_hash IS NULL AND session_id=NEW.session_id);
END;

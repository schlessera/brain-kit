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
-- Every admitted turn records the full governance hash, including non-Google policy changes.
CREATE TRIGGER google_allowances_policy_change AFTER UPDATE OF policy_hash ON safety_collections
BEGIN
  DELETE FROM google_session_allowances WHERE policy_hash<>COALESCE(NEW.policy_hash,'missing');
END;

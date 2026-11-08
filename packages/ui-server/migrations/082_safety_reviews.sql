-- Host-only request preparation. No HTTP or agent mutation surface.
-- Receipt space is reserved before issuing a handle; live receipts never evict.
CREATE TABLE safety_review_requests (
  id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL, history_owner_id TEXT NOT NULL, generation TEXT NOT NULL,
  occurrence_id TEXT NOT NULL, principal_id TEXT NOT NULL, channel TEXT NOT NULL,
  body_hash TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  terminal_at INTEGER, receipt TEXT NOT NULL,
  reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes=262144)
);
CREATE INDEX safety_reviews_session ON safety_review_requests(session_id);
CREATE INDEX safety_reviews_principal ON safety_review_requests(principal_id,terminal_at);
CREATE TRIGGER safety_review_identity BEFORE UPDATE ON safety_review_requests
 WHEN NEW.id!=OLD.id OR NEW.operation_id!=OLD.operation_id OR NEW.session_id!=OLD.session_id
 OR NEW.history_owner_id!=OLD.history_owner_id OR NEW.generation!=OLD.generation
 OR NEW.occurrence_id!=OLD.occurrence_id OR NEW.principal_id!=OLD.principal_id
 OR NEW.channel!=OLD.channel OR NEW.body_hash!=OLD.body_hash
 OR NEW.issued_at!=OLD.issued_at OR NEW.expires_at!=OLD.expires_at
 OR NEW.reserved_bytes!=OLD.reserved_bytes
 BEGIN SELECT RAISE(ABORT,'immutable safety review identity'); END;
CREATE TRIGGER safety_review_terminal BEFORE UPDATE ON safety_review_requests
 WHEN OLD.terminal_at IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'immutable safety review receipt'); END;

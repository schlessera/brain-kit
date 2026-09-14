-- Legacy subscriptions deliberately remain NULL and therefore inert until an
-- authenticated client re-registers the endpoint for its current principal.
ALTER TABLE push_subscriptions
  ADD COLUMN principal_id TEXT REFERENCES principals(id) ON DELETE SET NULL;

CREATE INDEX idx_push_subscriptions_principal
  ON push_subscriptions(principal_id);

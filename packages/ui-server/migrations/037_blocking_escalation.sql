-- Only the server's validated autonomous escalation path supplies this fact.
-- Keep it in immutable operational context, never in model/client Action data.
ALTER TABLE inbox_action_contexts ADD COLUMN blocking_escalation INTEGER NOT NULL DEFAULT 0
  CHECK (blocking_escalation IN (0, 1));

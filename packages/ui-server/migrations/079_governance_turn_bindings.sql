-- Content-free correlation survives catalog removal so a late callback cannot
-- orphan already-bound safety evidence or move it into a different chat.
CREATE TABLE governance_turn_bindings (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
);
INSERT INTO governance_turn_bindings(turn_id,session_id)
  SELECT turn_id,MIN(session_id) FROM governance_events
  WHERE turn_id IS NOT NULL AND session_id IS NOT NULL
  GROUP BY turn_id HAVING COUNT(DISTINCT session_id)=1;

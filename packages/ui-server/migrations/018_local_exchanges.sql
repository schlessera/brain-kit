-- Commands the client answered itself, without a turn (/stats; #582), kept as
-- part of the session. Neither backend's transcript can hold them, so the
-- host keeps them, the way it keeps message sources and classified blocks.
--
-- `seq` orders a session's exchanges. `delivered_at` is when the exchange's
-- context was handed to the agent with a prompt; NULL means the next prompt
-- in the session carries it. Replay places a delivered exchange before the
-- user message that carried it, and an undelivered one at the end.
CREATE TABLE IF NOT EXISTS local_exchanges (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  exchange_id TEXT NOT NULL,
  command TEXT NOT NULL,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL,
  context TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  UNIQUE (session_id, exchange_id)
);

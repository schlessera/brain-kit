-- Host identities and outcomes only. Never an executable replay queue.
CREATE TABLE conversation_epochs (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  session_id TEXT,
  agent_provider_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE conversation_tasks (
  conversation_id TEXT NOT NULL REFERENCES conversation_epochs(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL,
  native_handle TEXT NOT NULL,
  task_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  receipt TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, epoch, native_handle)
);

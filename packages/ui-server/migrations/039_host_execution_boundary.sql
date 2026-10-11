-- The host execution boundary (#1648; docs/decisions/governed-writable-workers.md).
--
-- writer_gate: who holds a brain's writer gate. Turns and credential-free
-- maintenance workers hold it shared; a credentialed maintenance worker holds
-- it exclusively. The server and the cron runner are separate processes, so
-- the gate lives here rather than in memory. A row whose process is gone is
-- stale and is removed by the next acquisition.
CREATE TABLE writer_gate (
  id TEXT PRIMARY KEY,
  brain TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shared', 'exclusive')),
  purpose TEXT NOT NULL,
  pid INTEGER NOT NULL,
  pid_start TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
);
CREATE INDEX writer_gate_brain ON writer_gate (brain);

-- governed_turn_manifests: the protected-path manifest of each governed turn,
-- written before its worker launches. A row without ended_at belongs to a
-- running turn, or to one whose server died mid-turn; boot reconciles the
-- latter before any maintenance worker or turn starts. Any row at all marks
-- the brain as one a governed turn may have changed.
CREATE TABLE governed_turn_manifests (
  turn_id TEXT PRIMARY KEY,
  brain TEXT NOT NULL,
  pid INTEGER NOT NULL,
  pid_start TEXT NOT NULL,
  manifest TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  reconciliation TEXT
);
CREATE INDEX governed_turn_manifests_brain ON governed_turn_manifests (brain, ended_at);

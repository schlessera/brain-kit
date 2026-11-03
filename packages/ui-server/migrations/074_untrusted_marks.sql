-- Files the user marked untrusted (G6, #2673), keyed by brain-relative path.
-- A mark outlives its file: a moved or deleted path keeps its record (rename
-- ruling B). `marked_by` names the principal without a foreign key, so
-- pruning an expired principal keeps the mark and only loses its label.
CREATE TABLE untrusted_marks (
  path TEXT PRIMARY KEY,
  marked_at INTEGER NOT NULL,
  marked_by TEXT
);

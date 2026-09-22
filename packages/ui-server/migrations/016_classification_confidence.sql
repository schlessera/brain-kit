-- Per-question confidence from the classification pass (D42 §5), so the swap
-- thresholds can be tuned on the distribution rather than on the handful of
-- swaps somebody happened to watch. One row per answered question per pass:
-- the candidate kind it was asked about, what came back, the line that answer
-- had to clear, and whether the candidate ended up drawn as a block or left
-- as markdown.
--
-- Instrumentation, not state. Nothing renders or replays from this table, the
-- pass works identically when it is empty, and dropping it costs the next
-- tuning pass its history and nothing else.
CREATE TABLE IF NOT EXISTS classification_confidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  candidate_kind TEXT NOT NULL,
  question TEXT NOT NULL,
  answer_type TEXT NOT NULL,
  choice TEXT,
  confidence REAL NOT NULL,
  -- The line in force when the row was written, so rows recorded either side
  -- of a threshold change stay separately readable.
  threshold REAL,
  cleared INTEGER NOT NULL,
  outcome TEXT NOT NULL
);

-- The distribution is read per candidate kind and question over a window.
CREATE INDEX IF NOT EXISTS idx_classification_confidence_slice
  ON classification_confidence (candidate_kind, question, recorded_at);
-- And the window is also how old rows are pruned.
CREATE INDEX IF NOT EXISTS idx_classification_confidence_age
  ON classification_confidence (recorded_at);

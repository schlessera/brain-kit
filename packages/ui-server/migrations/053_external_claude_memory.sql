-- Private host destinations never enter protocol replies or user requests.
CREATE TABLE turn_journal_claude_memory (
  turn_id TEXT NOT NULL REFERENCES turn_journal_turns(turn_id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  directory TEXT NOT NULL,
  device TEXT NOT NULL,
  inode TEXT NOT NULL,
  note TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  state TEXT NOT NULL,
  PRIMARY KEY (turn_id,path)
);

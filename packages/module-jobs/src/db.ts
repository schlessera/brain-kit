import { Database } from "bun:sqlite";

const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,

  title TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  company TEXT NOT NULL,
  company_normalized TEXT NOT NULL,
  description TEXT,
  description_text TEXT,
  url TEXT,
  source_url TEXT,

  location TEXT,
  remote_type TEXT,
  job_type TEXT,
  category TEXT,
  tags TEXT,

  salary_min INTEGER,
  salary_max INTEGER,
  salary_raw TEXT,
  salary_currency TEXT,

  published_at TEXT,
  expires_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  scraped_at TEXT NOT NULL,

  relevance_score REAL DEFAULT 0,
  score_breakdown TEXT,
  scored_at TEXT,
  review_status TEXT DEFAULT 'pending',
  reviewed_at TEXT,
  review_notes TEXT,

  is_duplicate INTEGER DEFAULT 0,
  duplicate_of INTEGER REFERENCES jobs(id),

  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_fingerprint ON jobs(fingerprint);
CREATE INDEX IF NOT EXISTS idx_jobs_company_normalized ON jobs(company_normalized);
CREATE INDEX IF NOT EXISTS idx_jobs_title_normalized ON jobs(title_normalized);
CREATE INDEX IF NOT EXISTS idx_jobs_review_status ON jobs(review_status);
CREATE INDEX IF NOT EXISTS idx_jobs_relevance_score ON jobs(relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_published_at ON jobs(published_at);
CREATE INDEX IF NOT EXISTS idx_jobs_last_seen_at ON jobs(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_is_duplicate ON jobs(is_duplicate);

CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  title, company, description_text, tags,
  content=jobs,
  content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  jobs_found INTEGER DEFAULT 0,
  jobs_new INTEGER DEFAULT 0,
  jobs_updated INTEGER DEFAULT 0,
  error TEXT,
  cursor TEXT
);

CREATE INDEX IF NOT EXISTS idx_scrape_runs_source ON scrape_runs(source);
`;

/**
 * Open (creating if needed) the jobs database at `path`. The path is supplied
 * by the caller — the CLI resolves it from module config (`dbPath`, default
 * `<root>/jobs.db`); tests pass `:memory:`.
 */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Check schema version and migrate if needed
  initSchema(db);
  return db;
}

function initSchema(db: Database): void {
  db.exec(SCHEMA_SQL);

  const row = db.query("SELECT value FROM jobs_metadata WHERE key = 'schema_version'").get() as
    | { value: string }
    | null;

  if (!row) {
    db.query("INSERT INTO jobs_metadata (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION)
    );
  } else {
    const version = Number(row.value);

    // v2: scored_at column — NULL means "not yet scored". Replaces the old
    // relevance_score = 0 sentinel, which re-scored legitimately zero-scored
    // jobs on every run.
    if (version < 2) {
      const columns = db.query("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "scored_at")) {
        db.exec("ALTER TABLE jobs ADD COLUMN scored_at TEXT");
      }
      // Backfill: any job with a score breakdown has been scored before.
      db.exec("UPDATE jobs SET scored_at = scraped_at WHERE score_breakdown IS NOT NULL");
      db.query("UPDATE jobs_metadata SET value = ? WHERE key = 'schema_version'").run("2");
    }
  }

  // Seed neutral classification-threshold fallbacks (idempotent). These are
  // overridden by the criteria file's `queueThreshold`/`dismissThreshold`.
  const seedDefault = db.query("INSERT OR IGNORE INTO jobs_metadata (key, value) VALUES (?, ?)");
  seedDefault.run("queue_threshold", "60");
  seedDefault.run("dismiss_threshold", "35");
}

export function getMetadata(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM jobs_metadata WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

export function setMetadata(db: Database, key: string, value: string): void {
  db.query("INSERT OR REPLACE INTO jobs_metadata (key, value) VALUES (?, ?)").run(key, value);
}

export function getLastCursor(db: Database, source: string): string | null {
  const row = db
    .query(
      "SELECT cursor FROM scrape_runs WHERE source = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1"
    )
    .get(source) as { cursor: string } | null;
  return row?.cursor ?? null;
}

export function logScrapeRun(
  db: Database,
  source: string,
  status: "running" | "completed" | "failed",
  stats?: { jobs_found?: number; jobs_new?: number; jobs_updated?: number; error?: string; cursor?: string }
): number {
  if (status === "running") {
    const result = db
      .query("INSERT INTO scrape_runs (source, started_at, status) VALUES (?, ?, ?)")
      .run(source, new Date().toISOString(), status);
    return Number(result.lastInsertRowid);
  }

  // Update existing run
  const lastRun = db
    .query("SELECT id FROM scrape_runs WHERE source = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1")
    .get(source) as { id: number } | null;

  if (lastRun) {
    db.query(
      `UPDATE scrape_runs SET status = ?, finished_at = ?, jobs_found = ?, jobs_new = ?, jobs_updated = ?, error = ?, cursor = ? WHERE id = ?`
    ).run(
      status,
      new Date().toISOString(),
      stats?.jobs_found ?? 0,
      stats?.jobs_new ?? 0,
      stats?.jobs_updated ?? 0,
      stats?.error ?? null,
      stats?.cursor ?? null,
      lastRun.id
    );
    return lastRun.id;
  }
  return -1;
}

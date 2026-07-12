import { Database } from "bun:sqlite";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./models";

const SCHEMA_VERSION = 7;

/** Embedding identity written into index_metadata; defaults come from models.ts. */
export interface SchemaOptions {
  embeddingModel?: string;
  embeddingDimensions?: number;
}

/**
 * Open the brain database, creating tables if needed.
 * Synchronous for broad compatibility.
 */
export function openDatabase(
  dbPath: string,
  options?: { readonly?: boolean } & SchemaOptions
): Database {
  const db = new Database(dbPath, {
    readonly: options?.readonly ?? false,
    create: !options?.readonly,
  });

  // Multiple processes share this db (MCP server per Claude session, CLI,
  // git hooks). Without a busy_timeout any lock contention fails instantly
  // with SQLITE_BUSY instead of waiting.
  db.run("PRAGMA busy_timeout=5000");

  if (!options?.readonly) {
    db.run("PRAGMA journal_mode=WAL");
    // NORMAL is durable under WAL (loses at most the last commit on power
    // failure, never corrupts) and avoids an fsync per autocommit write.
    db.run("PRAGMA synchronous=NORMAL");
    db.run("PRAGMA foreign_keys=ON");
    applySchema(db, options);
  }

  return db;
}

/**
 * Apply schema and run migrations.
 */
function applySchema(db: Database, options?: SchemaOptions): void {
  // index_metadata first — needed for version tracking
  db.run(`CREATE TABLE IF NOT EXISTS index_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  // Serialize migrations across processes: two fresh connections racing
  // through check-then-ALTER would otherwise both pass the check and one
  // would die on "duplicate column".
  const migrate = db.transaction(() => applyMigrations(db, options));
  migrate.immediate();
}

function applyMigrations(db: Database, options?: SchemaOptions): void {
  const embeddingModel = options?.embeddingModel ?? EMBEDDING_MODEL;
  const embeddingDimensions = options?.embeddingDimensions ?? EMBEDDING_DIMENSIONS;
  const currentVersion = getSchemaVersion(db);

  if (currentVersion < 1) {
    // Initial schema — core tables
    db.run(`CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      relevance TEXT DEFAULT 'primary',
      summary TEXT,
      created TEXT NOT NULL,
      updated TEXT NOT NULL,
      content TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS document_tags (
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (document_id, tag_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS links (
      source_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      target TEXT NOT NULL,
      target_id INTEGER,
      PRIMARY KEY (source_id, target)
    )`);

    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title, summary, content, tags,
      tokenize='porter unicode61'
    )`);

    db.run("CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(type)");
    db.run("CREATE INDEX IF NOT EXISTS idx_documents_relevance ON documents(relevance)");
    db.run("CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status)");
    db.run("CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated)");

    setSchemaVersion(db, 1);
  }

  if (currentVersion < 2) {
    // Migration: add content_hash column if missing
    const columns = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    const hasContentHash = columns.some((c) => c.name === "content_hash");
    if (!hasContentHash) {
      db.run("ALTER TABLE documents ADD COLUMN content_hash TEXT");
    }
    db.run("CREATE INDEX IF NOT EXISTS idx_documents_content_hash ON documents(content_hash)");

    // Ensure chunks table exists
    db.run(`CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      heading TEXT NOT NULL,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL
    )`);
    db.run("CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id)");

    setSchemaVersion(db, 2);
  }

  if (currentVersion < 3) {
    // Migration: add asset_type column for multimodal asset support
    const columns = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    const hasAssetType = columns.some((c) => c.name === "asset_type");
    if (!hasAssetType) {
      db.run("ALTER TABLE documents ADD COLUMN asset_type TEXT DEFAULT 'markdown'");
    }

    // Clear all vec_chunks — vector space changed (OpenAI → Gemini)
    try {
      db.run("DELETE FROM vec_chunks");
    } catch {
      // vec_chunks might not exist yet
    }

    // Store embedding model metadata for future migration detection
    db.run(
      "INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('embedding_model', ?)",
      [embeddingModel]
    );
    db.run(
      "INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('embedding_dimensions', ?)",
      [String(embeddingDimensions)]
    );

    setSchemaVersion(db, 3);
  }

  if (currentVersion < 4) {
    const columns = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];

    // Filesystem modification time — detects edits without frontmatter update
    if (!columns.some((c) => c.name === "file_mtime")) {
      db.run("ALTER TABLE documents ADD COLUMN file_mtime TEXT");
    }

    // Optional explicit deadline from frontmatter
    if (!columns.some((c) => c.name === "deadline")) {
      db.run("ALTER TABLE documents ADD COLUMN deadline TEXT");
    }

    // Optional review date from frontmatter
    if (!columns.some((c) => c.name === "next_review")) {
      db.run("ALTER TABLE documents ADD COLUMN next_review TEXT");
    }

    db.run("CREATE INDEX IF NOT EXISTS idx_documents_file_mtime ON documents(file_mtime)");
    db.run("CREATE INDEX IF NOT EXISTS idx_documents_deadline ON documents(deadline)");
    db.run("CREATE INDEX IF NOT EXISTS idx_documents_next_review ON documents(next_review)");

    setSchemaVersion(db, 4);
  }

  if (currentVersion < 5) {
    // Contextual retrieval: LLM-generated chunk context, prepended to the
    // embedded text so each chunk carries its place in the document
    const chunkColumns = db.prepare("PRAGMA table_info(chunks)").all() as { name: string }[];
    if (!chunkColumns.some((c) => c.name === "context")) {
      db.run("ALTER TABLE chunks ADD COLUMN context TEXT");
    }

    setSchemaVersion(db, 5);
  }

  if (currentVersion < 6) {
    // Baseline for silent-edit detection: file mtimes explicitly accepted as
    // non-suspicious (e.g. after mechanical migrations that deliberately do
    // not bump `updated`). Set via `brain accept-mtime`.
    const columns = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "accepted_mtime")) {
      db.run("ALTER TABLE documents ADD COLUMN accepted_mtime TEXT");
    }

    setSchemaVersion(db, 6);
  }

  if (currentVersion < SCHEMA_VERSION) {
    // v7 — cheap change detection for binary assets: an mtimeMs-size
    // fingerprint lets the indexer skip re-reading and re-hashing hundreds
    // of MB of unchanged assets on every --embeddings run.
    const columns = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "stat_fingerprint")) {
      db.run("ALTER TABLE documents ADD COLUMN stat_fingerprint TEXT");
    }

    setSchemaVersion(db, SCHEMA_VERSION);
  }
}

function getSchemaVersion(db: Database): number {
  try {
    const row = db.prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'").get() as { value: string } | null;
    return row ? parseInt(row.value, 10) : 0;
  } catch {
    return 0;
  }
}

function setSchemaVersion(db: Database, version: number): void {
  db.run(
    "INSERT OR REPLACE INTO index_metadata (key, value) VALUES ('schema_version', ?)",
    [String(version)]
  );
}

/**
 * Load sqlite-vec extension and create the vec_chunks virtual table with the
 * given embedding `dimensions`.
 * Returns true if vec support is now available.
 */
export async function initVecSupport(db: Database, dimensions: number): Promise<boolean> {
  try {
    const { load } = await import("sqlite-vec");
    load(db);

    // Cosine because it is scale-invariant: MRL-truncated Gemini vectors are
    // not guaranteed unit-length (gemini-embedding-2 normalizes truncated
    // output, but stored vectors may predate that) — switching to L2 or raw
    // dot product without re-normalizing stored vectors would rank wrongly.
    // Recreating the table drops all vectors; the self-healing backfill in the
    // indexer re-embeds them on the next --embeddings run.
    if (getMeta(db, "vec_distance_metric") !== "cosine") {
      try {
        db.run("DROP TABLE IF EXISTS vec_chunks");
        setMeta(db, "vec_distance_metric", "cosine");
      } catch {
        // Read-only connection — migration happens on the next writable run
      }
    }

    // v2 vec schema: metadata columns enable pre-filtered KNN. Without them,
    // archived chunks (~40% of the corpus after the archival pass) crowd the
    // KNN candidate window and get discarded post-filter, hurting recall.
    // Existing vectors are copied over — no re-embedding needed.
    if (getMeta(db, "vec_schema") !== "v2-metadata") {
      try {
        let existing: { chunk_id: number; embedding: Uint8Array; is_archived: number; doc_type: string }[] = [];
        try {
          existing = db
            .prepare(
              `SELECT vc.chunk_id, vc.embedding,
                      CASE WHEN d.status = 'archived' THEN 1 ELSE 0 END AS is_archived,
                      d.type AS doc_type
               FROM vec_chunks vc
               JOIN chunks c ON c.id = vc.chunk_id
               JOIN documents d ON d.id = c.document_id`
            )
            .all() as typeof existing;
        } catch {
          // old vec_chunks missing or empty — nothing to copy
        }

        db.run("DROP TABLE IF EXISTS vec_chunks");
        db.run(`CREATE VIRTUAL TABLE vec_chunks USING vec0(
          chunk_id INTEGER PRIMARY KEY,
          embedding float[${dimensions}] distance_metric=cosine,
          is_archived INTEGER,
          doc_type TEXT
        )`);

        if (existing.length > 0) {
          const insert = db.prepare(
            "INSERT INTO vec_chunks(chunk_id, embedding, is_archived, doc_type) VALUES (?, ?, ?, ?)"
          );
          for (const row of existing) {
            insert.run(row.chunk_id, row.embedding, row.is_archived, row.doc_type);
          }
        }
        setMeta(db, "vec_schema", "v2-metadata");
      } catch {
        // Read-only connection — migration happens on the next writable run
      }
    }

    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${dimensions}] distance_metric=cosine,
      is_archived INTEGER,
      doc_type TEXT
    )`);

    return true;
  } catch (e) {
    console.warn("sqlite-vec not available:", (e as Error).message);
    return false;
  }
}

/**
 * Check whether the database has sqlite-vec support loaded.
 */
export function hasVecSupport(db: Database): boolean {
  try {
    db.prepare("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a metadata value by key.
 */
export function getMeta(db: Database, key: string): string | null {
  try {
    const row = db.prepare("SELECT value FROM index_metadata WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Set a metadata key-value pair.
 */
export function setMeta(db: Database, key: string, value: string): void {
  db.run(
    "INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?, ?)",
    [key, value]
  );
}

import { Database } from "bun:sqlite";
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "./models.js";

/**
 * The brain.db schema this build writes, and the ONE place the number lives.
 *
 * Exported because it is a published contract, not an implementation detail:
 * `brain doctor` compares an existing database against it, the
 * integration-contract doc quotes it, and out-of-tree readers (ui-server's
 * graph reader and keyterm builder) gate their SQL on it. Those all used to
 * carry their own copy of the digit, so a bump meant four silent edits.
 * `tests/brain-db-contract.test.ts` now fails when any of them drifts.
 *
 * Bumping it is a contract change: update docs/integration-contract.md in the
 * same commit and re-check every floor the contract test lists.
 */
export const SCHEMA_VERSION = 11;

/** Embedding identity written into index_metadata; defaults come from models.ts. */
export interface SchemaOptions {
  embeddingModel?: string;
  embeddingDimensions?: number;
}

/**
 * The size SQLite shrinks `brain.db-wal` back to once a checkpoint has reset
 * it. Without a limit the file keeps the high-water size of the largest write
 * (a full reindex) for as long as any connection is open, and the MCP server
 * keeps one open for a whole agent session.
 */
export const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

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
    db.run(`PRAGMA journal_size_limit=${JOURNAL_SIZE_LIMIT_BYTES}`);
    db.run("PRAGMA foreign_keys=ON");
    applySchema(db, options);
  }

  return db;
}

const documentColumns = new WeakMap<Database, Set<string>>();

/**
 * Whether the `documents` table has a column. A read-only connection does
 * not migrate, so a database from an older schema lacks later columns until
 * a writable command opens it; readers of such a column check first.
 */
export function hasDocumentsColumn(db: Database, name: string): boolean {
  let columns = documentColumns.get(db);
  if (!columns) {
    columns = new Set((db.prepare("PRAGMA table_info(documents)").all() as { name: string }[]).map((c) => c.name));
    documentColumns.set(db, columns);
  }
  return columns.has(name);
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

  if (currentVersion < 7) {
    // v7 — cheap change detection for binary assets: an mtimeMs-size
    // fingerprint lets the indexer skip re-reading and re-hashing hundreds
    // of MB of unchanged assets on every --embeddings run.
    const columns = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "stat_fingerprint")) {
      db.run("ALTER TABLE documents ADD COLUMN stat_fingerprint TEXT");
    }

    setSchemaVersion(db, 7);
  }

  if (currentVersion < 8) {
    // v8 — derived wiki-link graph. Every table here is rebuilt wholesale by
    // lib/graph/precompute.ts on each index run (the `links` precedent): it is
    // cache, never authoritative state, and is never hand-written.
    db.run(`CREATE TABLE IF NOT EXISTS graph_metrics (
      document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      in_degree INTEGER NOT NULL DEFAULT 0,
      out_degree INTEGER NOT NULL DEFAULT 0,
      component INTEGER NOT NULL,
      pagerank REAL NOT NULL DEFAULT 0,
      community INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS graph_communities (
      community INTEGER PRIMARY KEY,
      size INTEGER NOT NULL,
      label TEXT,
      top_terms TEXT
    )`);

    // distance is measured from the DEFAULT root only. A virtual root (an
    // index-excluded entry file such as AGENTS.md) has no documents row, so
    // its ring-1 targets carry distance 1 with a NULL parent.
    db.run(`CREATE TABLE IF NOT EXISTS graph_root_distances (
      document_id INTEGER PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      distance INTEGER NOT NULL,
      parent_id INTEGER
    )`);

    // `mode` is keyed for future layouts (semantic, radial); v1 writes
    // 'clusters' only.
    db.run(`CREATE TABLE IF NOT EXISTS graph_layouts (
      mode TEXT NOT NULL,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      x REAL NOT NULL,
      y REAL NOT NULL,
      PRIMARY KEY (mode, document_id)
    )`);

    db.run("CREATE INDEX IF NOT EXISTS idx_graph_metrics_community ON graph_metrics(community)");

    setSchemaVersion(db, 8);
  }

  if (currentVersion < 9) {
    // v9 — "what links to this document" is a lookup, not a scan. The links
    // primary key leads with source_id, so without this every backlink query
    // (brain_graph direction "incoming") read the whole table. Built from the
    // rows already there: an upgraded brain needs no reindex.
    db.run("CREATE INDEX IF NOT EXISTS idx_links_target_id ON links(target_id)");

    setSchemaVersion(db, 9);
  }

  if (currentVersion < 10) {
    // v10 — the chunker version each document was chunked by. An index run
    // re-chunks a document whose version is older, once, even when its file
    // is unchanged. Existing rows start NULL: chunked before versions were
    // recorded, so the next run re-chunks them.
    const columns = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "chunker_version")) {
      db.run("ALTER TABLE documents ADD COLUMN chunker_version INTEGER");
    }

    setSchemaVersion(db, 10);
  }

  if (currentVersion < SCHEMA_VERSION) {
    // v11 — `generated_from` frontmatter (#430): the source a document is
    // produced from. Clearing the markdown rows' content hash makes the next
    // index run re-read every file, so the column is filled without
    // `--force`; unchanged chunks keep their rows and vectors.
    const columns = db.prepare("PRAGMA table_info(documents)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "generated_from")) {
      db.run("ALTER TABLE documents ADD COLUMN generated_from TEXT");
      db.run("UPDATE documents SET content_hash = NULL WHERE asset_type = 'markdown'");
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
 * Why vectors are not queryable on a connection.
 *
 * `extension-unavailable` means sqlite-vec itself could not be loaded — a
 * broken install. `no-vector-table` means the extension loaded fine and the
 * brain has simply never been embedded. They point at different fixes, which
 * is why one boolean was not enough.
 */
export type VecUnavailableReason = "extension-unavailable" | "no-vector-table";

export interface VecSupport {
  /** True when `vec_chunks` can be queried on this connection. */
  ok: boolean;
  reason?: VecUnavailableReason;
  /** The underlying error message, when there was one. */
  detail?: string;
}

/**
 * Make stored vectors readable on this connection. Writes nothing.
 *
 * This is the READ path. It loads the sqlite-vec extension — which lives in
 * the connection, not the file, so every connection that touches `vec_chunks`
 * needs it — and reports whether the table is there. It never creates,
 * migrates or drops anything, so a surface that only answers questions cannot
 * destroy the vector index whatever kind of connection it holds. Callers that
 * are about to write vectors want `migrateVecSchema` instead.
 */
export async function loadVecSupport(db: Database): Promise<VecSupport> {
  // The extension is per-connection, so a caller that holds one connection for
  // a session (the MCP server) asks repeatedly. Only the table's existence can
  // still change once it is in — another process embedding this brain — so a
  // repeat call is two cheap queries rather than an import and a reload.
  if (!hasVecSupport(db)) {
    try {
      const { load } = await import("sqlite-vec");
      load(db);
    } catch (e) {
      // A genuinely missing extension is worth saying out loud: the caller's
      // own warning ("vector search unavailable") cannot name the cause.
      console.warn("sqlite-vec not available:", (e as Error).message);
      return { ok: false, reason: "extension-unavailable", detail: (e as Error).message };
    }
  }

  if (!vecTableExists(db)) return { ok: false, reason: "no-vector-table" };
  return { ok: true };
}

/**
 * True when the `vec_chunks` virtual table has been created in this database.
 * Read from `sqlite_master`, so it needs no extension and loads none.
 */
export function vecTableExists(db: Database): boolean {
  try {
    const row = db
      .prepare("SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'")
      .get() as { n: number } | null;
    return row !== null;
  } catch {
    return false;
  }
}

/**
 * Create `vec_chunks` at `dimensions` and bring it up to the current vector
 * schema. Returns true if vec support is now available.
 *
 * This is the WRITE path and it is DESTRUCTIVE: the cosine migration drops
 * every stored vector, and only the indexer's self-healing backfill puts them
 * back — at the price of a fresh embedding run. Call it only from a caller
 * that is about to (re-)embed, and pass the width that caller will write at.
 * Anything that merely reads vectors wants `loadVecSupport`.
 */
export async function migrateVecSchema(db: Database, dimensions: number): Promise<boolean> {
  try {
    const { load } = await import("sqlite-vec");
    load(db);
  } catch (e) {
    console.warn("sqlite-vec not available:", (e as Error).message);
    return false;
  }

  try {
    // Cosine because it is scale-invariant: MRL-truncated Gemini vectors are
    // not guaranteed unit-length (gemini-embedding-2 normalizes truncated
    // output, but stored vectors may predate that) — switching to L2 or raw
    // dot product without re-normalizing stored vectors would rank wrongly.
    // Recreating the table drops all vectors; the self-healing backfill in the
    // indexer re-embeds them on the next --embeddings run.
    //
    // Each migration runs in a transaction. Half of one — a table dropped and
    // not rebuilt, or rebuilt and not refilled — is the vector index gone, and
    // these used to swallow their own failure and still report success.
    if (getMeta(db, "vec_distance_metric") !== "cosine") {
      db.transaction(() => {
        db.run("DROP TABLE IF EXISTS vec_chunks");
        setMeta(db, "vec_distance_metric", "cosine");
      })();
    }

    // v2 vec schema: metadata columns enable pre-filtered KNN. Without them,
    // archived chunks (~40% of the corpus after the archival pass) crowd the
    // KNN candidate window and get discarded post-filter, hurting recall.
    // Existing vectors are copied over — no re-embedding needed.
    if (getMeta(db, "vec_schema") !== "v2-metadata") {
      db.transaction(() => {
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
      })();
    }

    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${dimensions}] distance_metric=cosine,
      is_archived INTEGER,
      doc_type TEXT
    )`);

    return true;
  } catch (e) {
    // The extension loaded — this is the schema work failing, most often a
    // connection that cannot write. Saying "sqlite-vec not available" here
    // sent readers off to reinstall a dependency that was fine, and saying
    // nothing at all let a caller act on vectors this function had dropped.
    console.warn("vector schema migration failed:", (e as Error).message);
    return false;
  }
}

/** sqlite-vec's hard cap on a vec0 vector column; 8193 fails at CREATE. */
const VEC_MAX_DIMENSIONS = 8192;

/**
 * A width that can actually be used in a `float[...]` column declaration, or
 * null. Plain decimal only: `Number()` reads "0x10" as 16 and "1e2" as 100,
 * and a width that arrived in either spelling is corruption rather than
 * intent. Out of range is rejected for the same reason it must be — a CREATE
 * at 8193 throws after the DROP has already happened.
 */
function usableVectorWidth(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const width = Number(value);
  return width >= 1 && width <= VEC_MAX_DIMENSIONS ? width : null;
}

/** The width `vec_chunks` is physically declared at, or null if it is absent. */
function declaredVectorWidth(db: Database): number | null {
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'vec_chunks'")
      .get() as { sql: string } | null;
    return usableVectorWidth(row?.sql.match(/\bembedding\s+float\[(\d+)\]/i)?.[1] ?? null);
  } catch {
    return null;
  }
}

/**
 * The width the stored vectors are in: the table's own declaration, then
 * `index_metadata`, then `configured`.
 *
 * Callers that are not about to re-embed must pass this rather than the
 * configured provider's width: the two differ whenever the provider changed,
 * and recreating the table at the configured width strands every stored
 * vector. `brain doctor` learned this first. The physical table outranks the
 * metadata because the metadata describes the last provider, not necessarily
 * the table — `indexer/vectors.ts` reads the declared width the same way —
 * and because a corrupt `embedding_dimensions` would otherwise pick a width
 * whose CREATE throws with the old table already dropped.
 */
export function storedVectorWidth(db: Database, configured: number): number {
  return (
    declaredVectorWidth(db) ??
    usableVectorWidth(getMeta(db, "embedding_dimensions")) ??
    configured
  );
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
 * Does `stored` (the embedding identity recorded when the vectors were written)
 * describe the same vector space as `current` (the configured provider's id)?
 *
 * Exact match aside, this accepts one legacy form: `index_metadata.embedding_model`
 * used to be seeded by the schema-v3 migration with the bare model name from
 * models.ts ("gemini-embedding-2"), while providers report a namespaced id
 * ("gemini:gemini-embedding-2"). A brain last embedded before the indexer began
 * recording `provider.id` therefore carries perfectly good vectors under a name
 * that can never compare equal — search-engine skips vector search forever, and
 * `brain index --embeddings` refuses to repair it without `--force`, which bills
 * a full re-embed for a pure naming difference. Treat a bare stored value as
 * matching when it is exactly the model half of the current id.
 */
export function embeddingIdentityMatches(
  stored: string | null,
  current: string
): boolean {
  if (!stored) return false;
  if (stored === current) return true;
  if (stored.includes(":")) return false;
  const separator = current.indexOf(":");
  return separator !== -1 && current.slice(separator + 1) === stored;
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

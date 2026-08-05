import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

let db: Database | null = null;
let configuredPath: string | null = null;

/**
 * Override the database path before the first `getDb()` call (used by
 * `createApp({ dbPath })`). Configuring after the handle exists would silently
 * split state across two files — refuse instead.
 */
export function configureDb(dbPath: string): void {
  if (db && configuredPath !== dbPath) {
    throw new Error(
      "configureDb() called after the database was opened; set dbPath before the first use"
    );
  }
  configuredPath = dbPath;
}

export function getDb(): Database {
  if (!db) {
    const dbPath =
      configuredPath || process.env.DB_PATH || join(process.cwd(), "brain-ui.db");
    db = new Database(dbPath, { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

function runMigrations(database: Database) {
  // Ensure _migrations table exists
  database.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    )
  `);

  // The migrations ship inside the package (they are listed in `files`).
  // src/db/ and dist/db/ sit at the same depth, so the relative hop to the
  // package root resolves identically for the Bun (src) and Node (dist) paths.
  const migrationsDir = join(import.meta.dir, "../../migrations");
  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    console.warn("[db] No migrations directory found, skipping migrations");
    return;
  }

  const applied = new Set(
    database
      .query("SELECT filename FROM _migrations")
      .all()
      .map((r: any) => r.filename)
  );

  for (const file of files) {
    if (applied.has(file)) continue;

    console.log(`[db] Applying migration: ${file}`);
    const sql = readFileSync(join(migrationsDir, file), "utf-8");

    database.transaction(() => {
      database.exec(sql);
      database
        .prepare("INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)")
        .run(file, Date.now());
    })();
  }
}

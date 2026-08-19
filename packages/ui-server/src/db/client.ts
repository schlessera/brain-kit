import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * The UI's OWN SQLite database (sessions, passkeys, settings, cron runs) —
 * distinct from the brain database, which is opened read-only via
 * src/db/brain-db.ts.
 *
 * No module-level handle: `createApp()` opens one per app instance and threads
 * it to every consumer, so two apps with different configuration can coexist
 * in one process and a test gets an isolated database by construction.
 */
export function createUiDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
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

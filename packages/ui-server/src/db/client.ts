import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import type { Logger } from "@opentelemetry/api-logs";

/**
 * The UI's OWN SQLite database (sessions, passkeys, settings, cron runs) —
 * distinct from the brain database, which is opened read-only via
 * src/db/brain-db.ts.
 *
 * No module-level handle: `createApp()` opens one per app instance and threads
 * it to every consumer, so two apps with different configuration can coexist
 * in one process and a test gets an isolated database by construction.
 */
export interface CreateUiDbOptions {
  /**
   * Where migration progress is reported. Optional so a test can open a
   * database without wiring observability; absent means silence, never
   * console output.
   */
  log?: Logger;
}

export function createUiDb(dbPath: string, options: CreateUiDbOptions = {}): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Two processes write this database (the server and the cron wrapper). The
  // timeout makes a writer wait for a held lock instead of failing on it.
  // It does NOT rescue a deferred transaction that loses the snapshot-upgrade
  // race (that still throws SQLITE_BUSY) — which is why activity writes use
  // immediate transactions; see src/activity/store.ts.
  db.exec("PRAGMA busy_timeout = 5000");
  runMigrations(db, options.log);
  return db;
}

function runMigrations(database: Database, log?: Logger) {
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
    log?.emit({ severityText: "WARN", body: "no migrations directory; skipping migrations" });
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

    log?.emit({ severityText: "INFO", body: "applying migration", attributes: { file } });
    const sql = readFileSync(join(migrationsDir, file), "utf-8");

    try {
      database.transaction(() => {
        database.exec(sql);
        database
          .prepare("INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)")
          .run(file, Date.now());
      })();
    } catch (err) {
      // Two processes racing a first boot: the loser's transaction fails on
      // the UNIQUE _migrations.filename insert (or on DDL the winner already
      // ran). If the file is now recorded as applied, treat it as such and
      // move on; anything else is a real migration failure.
      const nowApplied = database
        .query("SELECT 1 FROM _migrations WHERE filename = ?")
        .get(file);
      const uniqueViolation =
        err instanceof Error &&
        err.message.includes("UNIQUE constraint failed: _migrations.filename");
      if (!nowApplied && !uniqueViolation) throw err;
      log?.emit({
        severityText: "INFO",
        body: "migration applied concurrently by another process; skipping",
        attributes: { file },
      });
    }
  }
}

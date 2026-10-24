import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import type { Logger } from "@opentelemetry/api-logs";

import { attachJournalDatabase, JOURNAL_MIGRATIONS_TABLE, JOURNAL_SPLIT_MIGRATION, journalMigrationReceipts, moveJournalTables } from "./journal-database.js";

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
  // Server and cron can race WAL recovery or startup. Install the existing
  // timeout before journal_mode so that initialization waits for its lock.
  // It does not rescue a deferred transaction that loses a snapshot-upgrade
  // race (SQLITE_BUSY); activity writes still use immediate transactions.
  // See src/activity/store.ts.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // The journal has its own file (#2789). Migrations still create its tables
  // unqualified here; each start then moves whatever they created into it.
  attachJournalDatabase(db, dbPath);
  runMigrations(db, options.log);
  const moved = moveJournalTables(db);
  if (moved) options.log?.emit({ severityText: "INFO", body: "moved journal tables into the journal database", attributes: { tables: moved } });
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
  const journalApplied = journalMigrationReceipts(database);

  let moved = false;
  for (const file of files) {
    if (applied.has(file) || journalApplied.has(file)) continue;
    // Later migrations find the journal tables in the journal file (#2789).
    if (!moved && file.slice(0, JOURNAL_SPLIT_MIGRATION.length) > JOURNAL_SPLIT_MIGRATION) { moveJournalTables(database); moved = true; }
    const journal = file.endsWith(".journal.sql");

    log?.emit({ severityText: "INFO", body: "applying migration", attributes: { file } });
    const sql = readFileSync(join(migrationsDir, file), "utf-8");

    try {
      database.transaction(() => {
        const uiSchema = (database.query("PRAGMA main.schema_version").get() as { schema_version: number }).schema_version;
        database.exec(sql);
        // A journal migration commits with its receipt only if it stays in the journal file.
        if (journal && (database.query("PRAGMA main.schema_version").get() as { schema_version: number }).schema_version !== uiSchema)
          throw new Error(`Journal migration ${file} changed the UI database; create journal objects as journal.<name>.`);
        // Each receipt commits in the file its migration changed.
        database
          .prepare(journal ? `INSERT INTO ${JOURNAL_MIGRATIONS_TABLE} (filename, applied_at) VALUES (?, ?)` : "INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)")
          .run(file, Date.now());
      })();
    } catch (err) {
      // Two processes racing a first boot: the loser's transaction fails on
      // the UNIQUE _migrations.filename insert (or on DDL the winner already
      // ran). If the file is now recorded as applied, treat it as such and
      // move on; anything else is a real migration failure.
      const nowApplied = database
        .query(journal ? `SELECT 1 FROM ${JOURNAL_MIGRATIONS_TABLE} WHERE filename = ?` : "SELECT 1 FROM _migrations WHERE filename = ?")
        .get(file);
      const uniqueViolation =
        err instanceof Error &&
        err.message.includes(journal ? `UNIQUE constraint failed: ${JOURNAL_MIGRATIONS_TABLE}.filename` : "UNIQUE constraint failed: _migrations.filename");
      if (!nowApplied && !uniqueViolation) throw err;
      log?.emit({
        severityText: "INFO",
        body: "migration applied concurrently by another process; skipping",
        attributes: { file },
      });
    }
  }
}

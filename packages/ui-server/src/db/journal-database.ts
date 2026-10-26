import type { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, openSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The turn journal's own SQLite file (#2789), attached to every UI connection
 * as `journal`. Every page in it is the journal's, so its capacity is the
 * file's own page count and WAL, with no walk. Unqualified `turn_journal_*`
 * names resolve to it once the tables have moved.
 */
export const JOURNAL_SCHEMA = "journal";

/**
 * The last migration written before the split. Later migrations see the
 * journal tables in the journal file: one that changes them is named
 * `*.journal.sql`, touches nothing else, and records its receipt there.
 */
export const JOURNAL_SPLIT_MIGRATION = "063";
export const JOURNAL_MIGRATIONS_TABLE = "turn_journal_migrations";

/** Beside the UI database's physical file, so every alias of DB_PATH names one journal. */
export function journalDatabasePath(dbPath: string): string {
  if (dbPath === "" || dbPath === ":memory:") return ":memory:";
  const database = resolve(dbPath);
  return `${existsSync(database) ? realpathSync(database) : database}.journal.db`;
}

/** Attaches the journal database once per connection, creating it like the UI database. */
export function attachJournalDatabase(db: Database, dbPath: string): void {
  if ((db.query("PRAGMA database_list").all() as { name: string }[]).some(row => row.name === JOURNAL_SCHEMA)) return;
  const path = journalDatabasePath(dbPath);
  if (path !== ":memory:" && !existsSync(path)) {
    // The same permission bits as the UI database it sits beside, within the
    // process umask; SQLite gives its -wal and -shm files the file's bits.
    const mode = existsSync(resolve(dbPath)) ? statSync(resolve(dbPath)).mode & 0o666 : 0o600;
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, mode)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  db.query(`ATTACH DATABASE ? AS ${JOURNAL_SCHEMA}`).run(path);
  // Chosen before the file's first table; a later restart can then return
  // released pages to the file system without a full VACUUM.
  db.exec(`PRAGMA ${JOURNAL_SCHEMA}.auto_vacuum = INCREMENTAL`);
  db.exec(`PRAGMA ${JOURNAL_SCHEMA}.journal_mode = WAL`);
}

/** Receipts of `*.journal.sql` migrations, kept in the file they change so each commits with its change. */
export function journalMigrationReceipts(db: Database): Set<string> {
  db.exec(`CREATE TABLE IF NOT EXISTS ${JOURNAL_SCHEMA}.${JOURNAL_MIGRATIONS_TABLE} (filename TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  return new Set((db.query(`SELECT filename FROM ${JOURNAL_MIGRATIONS_TABLE}`).all() as { filename: string }[]).map(row => row.filename));
}

type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null };

/**
 * Moves every `turn_journal_*` table, with its rows, indexes and triggers,
 * from the UI database into the journal database. Migrations up to
 * `JOURNAL_SPLIT_MIGRATION` create journal tables in the UI database, so this
 * runs before any later migration and again after all of them. Copying writes
 * only the journal file and dropping only the UI file, so each step commits
 * atomically on its own: a crash between them leaves both copies, and the
 * next start rebuilds the copy before dropping. Every writer of the UI
 * database must be stopped while an older release's tables move: a write to
 * the UI copy between the two steps would be dropped with it.
 */
export function moveJournalTables(db: Database): number {
  const definitions = () => db.query("SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE tbl_name GLOB 'turn_journal_*' AND sql IS NOT NULL ORDER BY rowid").all() as SchemaRow[];
  if (!definitions().some(row => row.type === "table")) return 0;
  const qualify = (row: SchemaRow) => {
    // Rename the created object into the journal schema; references inside
    // it (foreign keys, an index's table) stay unqualified and resolve there.
    // No journal table uses AUTOINCREMENT, so no sqlite_sequence row moves.
    const kind = row.type === "table" ? "TABLE" : row.type === "index" ? "(?:UNIQUE )?INDEX" : "TRIGGER";
    // The name token stays exactly as written: SQLite stores the definition
    // without the schema, so the text is the same in either file.
    const rewritten = row.sql!.replace(new RegExp(`^CREATE (${kind})\\s+("[^"]+"|\\w+)`, "i"), `CREATE $1 ${JOURNAL_SCHEMA}.$2`);
    if (rewritten === row.sql) throw new Error(`The journal move cannot rewrite the definition of ${row.name}.`);
    return rewritten;
  };
  const count = (schema: string, table: string) => (db.query(`SELECT count(*) AS n FROM ${schema}."${table}"`).get() as { n: number }).n;
  // A copy of consistent rows needs no enforcement while it runs, only a
  // check before it commits. Enforcement is a connection setting, so it
  // changes only outside a transaction; with it off, dropping a table runs
  // no implicit delete and no trigger fires.
  const enforced = (db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    // Under the write lock: another process starting at the same time may
    // already have moved them.
    const tables = db.transaction(() => {
      const rows = definitions(), tables = rows.filter(row => row.type === "table");
      for (const table of tables) {
        // An interrupted earlier move left a copy: rebuild it, so no copied
        // trigger runs on its rows.
        if (db.query(`SELECT 1 FROM ${JOURNAL_SCHEMA}.sqlite_schema WHERE type = 'table' AND name = ?`).get(table.name)) db.exec(`DROP TABLE ${JOURNAL_SCHEMA}."${table.name}"`);
        db.exec(qualify(table));
        db.exec(`INSERT INTO ${JOURNAL_SCHEMA}."${table.name}" SELECT * FROM main."${table.name}"`);
        const copied = count(JOURNAL_SCHEMA, table.name), original = count("main", table.name);
        if (copied !== original) throw new Error(`The journal move copied ${copied} of ${original} rows of ${table.name}; the UI database keeps them.`);
      }
      // Indexes and triggers after the rows, so no trigger runs on the copy.
      for (const row of rows) if (row.type !== "table") db.exec(qualify(row));
      if (db.query(`PRAGMA ${JOURNAL_SCHEMA}.foreign_key_check`).all().length) throw new Error("The journal move found dangling references; the UI database keeps the journal tables.");
      return tables;
    }).immediate();
    db.transaction(() => { for (const table of [...tables].reverse()) db.exec(`DROP TABLE IF EXISTS main."${table.name}"`); }).immediate();
    return tables.length;
  } finally { db.exec(`PRAGMA foreign_keys = ${enforced ? "ON" : "OFF"}`); }
}

/** Derived performance state: admitted at runtime, omitted from canonical backup images. */
export const JOURNAL_OBJECT_REFS_INDEX = {
  name: "turn_journal_object_refs_hash",
  sql: "CREATE INDEX turn_journal_object_refs_hash ON turn_journal_object_refs(hash)",
} as const;

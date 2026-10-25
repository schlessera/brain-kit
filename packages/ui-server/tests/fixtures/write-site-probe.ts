/**
 * A write-worker procedure module for tests (#2850): on the write connection,
 * it refuses any write to the watched tables below `synchronous=FULL` and logs
 * each one, in commit order.
 */
import type { Database } from "bun:sqlite";

export const url = import.meta.url;

export function setup(db: Database, options: { tables: string[] }) {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS odysseus_write_log (n INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL)");
  for (const table of options.tables) for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${table}_full_${event.toLowerCase()} BEFORE ${event} ON main.${table}
      WHEN (SELECT synchronous FROM pragma_synchronous) IS NOT 2 BEGIN SELECT RAISE(ABORT, 'WRITE_BELOW_FULL ${table}'); END`);
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${table}_log_${event.toLowerCase()} AFTER ${event} ON main.${table}
      BEGIN INSERT INTO odysseus_write_log (tbl) VALUES ('${table}'); END`);
  }
  return {
    /** Every watched write the worker committed, in commit order. */
    log() { return (db.query("SELECT tbl FROM odysseus_write_log ORDER BY n").all() as { tbl: string }[]).map(row => row.tbl); },
  };
}

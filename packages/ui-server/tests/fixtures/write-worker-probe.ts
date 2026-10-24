/** A write-worker procedure module for tests (#2814): Odysseus's log, one row per call. */
import type { Database } from "bun:sqlite";

export const url = import.meta.url;

export function setup(db: Database, options: { table: string }) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${options.table} (n INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL)`);
  const insert = (label: string) => db.query(`INSERT INTO ${options.table} (label) VALUES (?)`).run(label).changes;
  return {
    log(label: string) { return db.transaction(() => insert(label)).immediate(); },
    /** Holds the commit for `ms`, as a slow fsync would. */
    slow(label: string, ms: number) {
      return db.transaction(() => { insert(label); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); return 1; }).immediate();
    },
    lowered(label: string) { db.exec("PRAGMA synchronous = NORMAL"); return db.transaction(() => insert(label)).immediate(); },
    loweredAutocommit(label: string) { db.exec("PRAGMA synchronous = NORMAL"); return insert(label); },
    /** Counts the log twice across a held gap, outside any transaction. */
    gap(ms: number) {
      const count = () => (db.query(`SELECT count(*) AS n FROM ${options.table}`).get() as { n: number }).n;
      const before = count(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); return [before, count()];
    },
    level() { return (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous; },
    levelOf(schema: string) { return (db.query(`PRAGMA "${schema}".synchronous`).get() as { synchronous: number }).synchronous; },
    loweredIn(schema: string, label: string) { db.exec(`PRAGMA "${schema}".synchronous = NORMAL`); return db.transaction(() => insert(label)).immediate(); },
    refuse(message: string) { throw Object.assign(new Error(message), { reason: "odysseus_refused" }); },
  };
}

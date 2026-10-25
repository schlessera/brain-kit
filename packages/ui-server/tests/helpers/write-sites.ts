/**
 * Where a moved write commits (#2850). The app connection refuses every write
 * to the watched tables; the write worker's connection refuses one below
 * `synchronous=FULL` and logs the rest, in commit order. Temporary triggers
 * belong to the connection that made them, so each side checks only itself.
 */
import type { Database } from "bun:sqlite";
import type { SqliteWriter } from "../../src/db/write-worker.js";
import * as probe from "../fixtures/write-site-probe.js";

export async function watchWriteSites(db: Database, writer: SqliteWriter, tables: string[]) {
  for (const table of tables) for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${table}_app_${event.toLowerCase()} BEFORE ${event} ON main.${table}
      BEGIN SELECT RAISE(ABORT, 'APP_CONNECTION_WRITE ${table}'); END`);
  }
  const channel = writer.channel(probe, { tables });
  await channel.ready;
  return {
    /** The watched tables each committed write landed in, in commit order, once everything submitted so far has committed. */
    async log() { await writer.idle(); return channel.call<string[]>("log"); },
  };
}

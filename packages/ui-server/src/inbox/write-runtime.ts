/** The hosted inbox uses the app's single SQLite write queue (#3001). */
import type { Database } from "bun:sqlite";
import type { SqliteWriter } from "../db/write-worker.js";

const writers = new WeakMap<Database, SqliteWriter>();

export function registerInboxWrites(db: Database, writer: SqliteWriter): void {
  writers.set(db, writer);
}

export function inboxWriter(db: Database): SqliteWriter | undefined {
  return writers.get(db);
}

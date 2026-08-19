/**
 * The one place ui-server opens the BRAIN database (`$BRAIN_PATH/brain.db`).
 *
 * core owns that schema and versions it independently, so every reader on this
 * side of the package boundary must check `schema_version` before trusting the
 * shape — a reader without the gate breaks at some later `brain index` with an
 * error pointing nowhere near the cause. A repo-level lint bans `new Database(`
 * in ui-server/src outside src/db/, so a new reader cannot skip this wrapper.
 *
 * (src/db/client.ts is unrelated: that is the UI's OWN database — sessions,
 * passkeys, settings — whose schema this package owns and migrates itself.)
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { join } from "path";

/**
 * The oldest brain.db schema the SQL in this package is written against:
 * v3 added `documents.asset_type`, which both the graph reader and the
 * keyterm extractor select on.
 */
export const MIN_BRAIN_SCHEMA_VERSION = 3;

export type BrainDbUnavailableReason = "missing" | "schema";

/** brain.db cannot be read: absent, or older than the caller's floor. */
export class BrainDbUnavailableError extends Error {
  constructor(
    readonly reason: BrainDbUnavailableReason,
    readonly schemaVersion: number
  ) {
    super(`brain_db_unavailable: ${reason} (schema_version=${schemaVersion})`);
    this.name = "BrainDbUnavailableError";
  }
}

export interface OpenBrainDbOptions {
  /**
   * Refuse (throw {@link BrainDbUnavailableError}) below this schema_version.
   * Defaults to {@link MIN_BRAIN_SCHEMA_VERSION}. Callers with a newer floor
   * (the graph tables arrived in v8) still gate per-feature on the returned
   * `schemaVersion` — degrading, not throwing, where a partial read is useful.
   */
  minSchemaVersion?: number;
}

export interface BrainDbHandle {
  db: Database;
  /** schema_version from index_metadata; 0 when unreadable. */
  schemaVersion: number;
}

function readSchemaVersion(db: Database): number {
  try {
    const row = db
      .query<{ value: string }, []>(
        "SELECT value FROM index_metadata WHERE key = 'schema_version'"
      )
      .get();
    const parsed = Number.parseInt(row?.value ?? "", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Open brain.db read-only and assert its schema_version. Opened per call, not
 * cached (the keyterm-builder precedent): WAL makes concurrent readers cheap,
 * and a short-lived handle means a `brain sync` swapping the file underneath
 * can never leave the server on a stale page cache.
 */
export function openBrainDb(
  brainPath: string,
  options: OpenBrainDbOptions = {}
): BrainDbHandle {
  const min = options.minSchemaVersion ?? MIN_BRAIN_SCHEMA_VERSION;
  const dbPath = join(brainPath, "brain.db");
  if (!existsSync(dbPath)) {
    throw new BrainDbUnavailableError("missing", 0);
  }
  const db = new Database(dbPath, { readonly: true });
  const schemaVersion = readSchemaVersion(db);
  if (schemaVersion < min) {
    db.close();
    throw new BrainDbUnavailableError("schema", schemaVersion);
  }
  return { db, schemaVersion };
}

/** Open, run `fn`, close — the shape every per-request reader wants. */
export function withBrainDb<T>(
  brainPath: string,
  options: OpenBrainDbOptions,
  fn: (db: Database, schemaVersion: number) => T
): T {
  const { db, schemaVersion } = openBrainDb(brainPath, options);
  try {
    return fn(db, schemaVersion);
  } finally {
    db.close();
  }
}

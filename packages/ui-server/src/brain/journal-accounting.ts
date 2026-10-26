import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { attachJournalDatabase, JOURNAL_MIGRATIONS_TABLE, JOURNAL_SCHEMA, journalDatabasePath } from "../db/journal-database.js";
import { JournalCapacityError, type JournalObjectAccounting } from "./journal-objects.js";
import { processAlive, SELF } from "./writer-gate.js";

/** The approved aggregate persistent-disk bound, shared by every retained/active turn. */
export const JOURNAL_CAP_BYTES = 10 * 1024 ** 3;

export class JournalStorageUnavailable extends Error {
  readonly reason = "journal_storage_unavailable";
  constructor(message: string) { super(`The change journal cannot safely retain this observation: ${message}`); }
}

/**
 * Connection-local triggers: a journal row changed outside an accounted
 * write is refused, so no journal storage reaches the disk unadmitted.
 */
export function installEscapeGuard(db: Database) {
  const tables = (db.query(`SELECT name FROM ${JOURNAL_SCHEMA}.sqlite_schema WHERE type='table' AND name GLOB 'turn_journal_*' AND name NOT IN ('turn_journal_allocation', '${JOURNAL_MIGRATIONS_TABLE}')`).all() as { name: string }[]).map(row => row.name);
  for (const table of tables) for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${table}_accounted_${event.toLowerCase()} BEFORE ${event} ON ${JOURNAL_SCHEMA}.${table}
      WHEN (SELECT writing FROM turn_journal_allocation WHERE id = 1) IS NOT 1
      BEGIN SELECT RAISE(ABORT, 'journal storage write outside capacity accounting'); END`);
  }
}

export function createJournalAccounting(db: Database, dbPath: string, options: {
  capBytes?: number;
  /** An internal deterministic scheduling hook; production does not supply one. */
  afterCheckpoint?: () => void;
} = {}): JournalObjectAccounting & {
  write<T>(operation: () => T): T;
  usage(): number;
  /** Admitted, retryable schema upgrade; false leaves integrity-checked collection usable. */
  ensureObjectRefIndex(): boolean;
  openRead(hash: string, assertOwner?: () => void): string;
  releaseRead(id: string): void;
  reserveTemporary(bytes: number): { id: string; release(): void };
  recover(objects: { has(hash: string): boolean; verify(hash: string, bytes: number): boolean; discardPending(id: string): void }): void;
} {
  const cap = options.capBytes ?? JOURNAL_CAP_BYTES;
  const memory = dbPath === ":memory:" || dbPath === "";
  // Whichever connection keeps the ledger, the journal's own file is attached
  // to it, with the references between journal tables enforced. Both are
  // connection settings that cannot change inside a transaction.
  if (db.inTransaction) throw new JournalStorageUnavailable("the journal ledger cannot start inside another transaction");
  attachJournalDatabase(db, dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  // CREATE INDEX may sort on disk even with cache spill disabled. Choose
  // memory before installing TEMP guards: changing temp_store deletes the
  // entire TEMP schema. Never discard a caller's existing TEMP objects.
  if (!db.query("SELECT 1 FROM sqlite_temp_schema LIMIT 1").get()) db.exec("PRAGMA temp_store = MEMORY");
  // SQLite keeps the WAL beside the file a link resolves to.
  const real = (path: string) => memory ? path : realpathSync(path);
  const file = real(journalDatabasePath(dbPath)), uiWal = memory ? "" : `${real(resolve(dbPath))}-wal`;
  const pageSize = (db.query(`PRAGMA ${JOURNAL_SCHEMA}.page_size`).get() as { page_size: number }).page_size;
  const size = (path: string) => { if (memory) return 0; try { return statSync(path).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; } };
  const wal = () => size(`${file}-wal`);
  installEscapeGuard(db);
  /**
   * Every page of the journal's file is the journal's: its b-tree pages, the
   * pages it released and page 1. So the measurement is the file's extent,
   * read without walking anything.
   */
  function measure(additionalPages = 0) {
    const logicalPages = (db.query(`PRAGMA ${JOURNAL_SCHEMA}.page_count`).get() as { page_count: number }).page_count;
    const free = (db.query(`PRAGMA ${JOURNAL_SCHEMA}.freelist_count`).get() as { freelist_count: number }).freelist_count;
    const pages = (memory ? logicalPages : Math.max(logicalPages, Math.ceil(size(file) / pageSize))) + additionalPages;
    // One spill-disabled commit writes each page of the file at most once,
    // free-list trunk pages included. Keep this temporary capacity reserved
    // even after checkpoint so a crash cannot lose the accounting before
    // reconciliation.
    const walCapacity = memory ? 0 : 32 + (pages + Math.ceil(pages / (pageSize / 4 - 2))) * (pageSize + 24);
    const physical = memory ? 0 : pages * pageSize;
    const objects = (db.query("SELECT coalesce(sum(bytes),0) AS bytes FROM turn_journal_objects WHERE state='present'").get() as { bytes: number }).bytes;
    const pending = (db.query("SELECT coalesce(sum(bytes),0) AS bytes FROM turn_journal_reservations").get() as { bytes: number }).bytes;
    return { pages, free, walCapacity, bytes: physical + walCapacity + objects + pending };
  }
  class CheckpointRace extends Error {}
  class WalDebt extends Error {}
  function checkpoint() {
    if (!memory) {
      const result = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (result.busy) throw new JournalStorageUnavailable("a database reader still holds journal write-ahead data");
    }
    options.afterCheckpoint?.();
  }
  /**
   * One accounted transaction. Writes do not truncate the WAL first, so
   * admission charges the journal file's whole WAL as it stands: earlier
   * journal commits and any failed commit's tail. The measurement's WAL
   * capacity covers this commit. `fresh` requires empty WALs under this
   * write lock, right after a checkpoint, as every write used to.
   */
  function admit<T>(operation: () => T, fresh: boolean, retryable: boolean) {
    return db.transaction(() => {
      const walBefore = wal();
      // Checkpoint and BEGIN cannot be one SQLite critical section. A
      // writer that won between them is detected under this write lock;
      // roll back before any journal mutation and retry the checkpoint.
      if (fresh && (walBefore !== 0 || size(uiWal) !== 0)) throw new CheckpointRace();
      const before = measure();
      if (retryable && walBefore > 0 && before.bytes + walBefore > cap) throw new WalDebt();
      db.query("UPDATE turn_journal_allocation SET writing = 1 WHERE id = 1").run();
      const result = operation();
      for (let pass = 0; pass < 10; pass++) {
        const measured = measure();
        if (measured.bytes + walBefore > cap) throw retryable && walBefore > 0 ? new WalDebt() : new JournalCapacityError();
        // The WAL after this commit stays within what it held plus this commit.
        const reserved = walBefore + measured.walCapacity;
        const prior = db.query("SELECT wal_reserved,writing FROM turn_journal_allocation WHERE id = 1").get() as { wal_reserved: number; writing: number };
        if (prior.wal_reserved === reserved && prior.writing === 0) return result;
        db.query("UPDATE turn_journal_allocation SET wal_reserved = ?,writing = 0 WHERE id = 1").run(reserved);
      }
      throw new JournalStorageUnavailable("allocation accounting did not stabilize");
    }).immediate();
  }
  let established = false;
  /** Every journal commit stays FULL: it is durable before the turn proceeds. */
  const write = <T>(operation: () => T): T => {
    if (db.inTransaction) throw new JournalStorageUnavailable("a journal write cannot run inside another transaction");
    const spill = (db.query("PRAGMA cache_spill").get() as { cache_spill: number }).cache_spill;
    // Each attached file has its own level: the journal's commit is FULL.
    const synchronous = (db.query(`PRAGMA ${JOURNAL_SCHEMA}.synchronous`).get() as { synchronous: number }).synchronous;
    db.exec(`PRAGMA ${JOURNAL_SCHEMA}.synchronous = FULL`);
    db.exec("PRAGMA cache_spill = OFF");
    try {
      // A ledger's first write starts from an empty WAL. Later writes take no
      // checkpoint unless the WAL they would carry refuses admission; then
      // they truncate and retry, as every write used to.
      let fresh = !established;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (fresh) checkpoint();
        try {
          const result = admit(operation, fresh, !fresh);
          established = true;
          return result;
        } catch (error) {
          if (error instanceof WalDebt) { fresh = true; continue; }
          if (!(error instanceof CheckpointRace)) throw error;
        }
      }
      throw new JournalStorageUnavailable("another database writer repeatedly won checkpoint admission");
    } finally { db.exec(`PRAGMA cache_spill = ${spill}`); db.exec(`PRAGMA ${JOURNAL_SCHEMA}.synchronous = ${synchronous}`); }
  };
  const usage = (): number => {
    const measured = measure();
    // The standing charge keeps at least one commit of WAL headroom reserved.
    return measured.bytes - measured.walCapacity + Math.max(measured.walCapacity, wal());
  };
  /**
   * Runtime migration (#2913), deliberately outside the unconditional SQL
   * migrations. The existing schema entry is its atomic completion receipt.
   * Admission reserves an allowance for new b-tree/schema/pointer-map pages
   * and their FULL commit's WAL before CREATE INDEX. No freelist credit is
   * assumed. The measured build must fit that allowance as well as the cap.
   *
   * Sorter data stays in memory; write() disables cache spill, so an aborted
   * or underestimated build allocates no persistent pages or WAL frames.
   * Both checks run under the same write lock as the build and commit.
   */
  function ensureObjectRefIndex(): boolean {
    const exists = () => Boolean(db.query(`SELECT 1 FROM ${JOURNAL_SCHEMA}.sqlite_schema WHERE type='index' AND name='turn_journal_object_refs_hash'`).get());
    if (exists()) return true;
    // A SQLite build forcing file-backed temps, or a caller owning TEMP
    // state with another setting, keeps the slower path without changing it.
    if ((db.query("PRAGMA temp_store").get() as { temp_store: number }).temp_store !== 2
      || db.query("SELECT 1 FROM pragma_compile_options WHERE compile_options='TEMP_STORE=0'").get()) return false;
    try {
      write(() => {
        if (exists()) return; // Another process may have installed it before this lock.
        // Hash payload plus record, rowid and cell overhead; double the
        // allowance for b-tree fill and interior pages, plus fixed overhead.
        // This is an allowance, not trusted size prediction: check the actual
        // extent before commit, while all newly built pages are still cached.
        const payload = (db.query("SELECT coalesce(sum(length(CAST(hash AS BLOB))+32),0) AS bytes FROM turn_journal_object_refs").get() as { bytes: number }).bytes;
        const pages = 8 + 2 * Math.ceil(payload / (pageSize - 128));
        const before = measure(), projected = measure(pages), debt = wal();
        if (projected.bytes + debt > cap) {
          if (debt > 0) throw new WalDebt();
          throw new JournalCapacityError();
        }
        db.exec(`CREATE INDEX ${JOURNAL_SCHEMA}.turn_journal_object_refs_hash ON turn_journal_object_refs(hash)`);
        if (measure().pages > before.pages + pages) throw new JournalCapacityError("The journal reference index exceeded its admitted page allowance.");
      });
      return true;
    } catch (error) {
      if (!(error instanceof JournalCapacityError || error instanceof JournalStorageUnavailable)) throw error;
      return false;
    }
  }
  // While the server starts, truncate and return the pages released before
  // the last stop to the file system, as one admitted FULL write. A pinned
  // WAL or an over-cap store leaves this to the first write, which refuses
  // or recovers as it always did.
  try {
    write(() => db.exec(`PRAGMA ${JOURNAL_SCHEMA}.incremental_vacuum`));
    // The file shrinks when its pages leave the WAL; a pinned reader only delays that.
    if (!memory) db.query(`PRAGMA ${JOURNAL_SCHEMA}.wal_checkpoint(TRUNCATE)`).get();
  } catch (error) { if (!(error instanceof JournalStorageUnavailable || error instanceof JournalCapacityError)) throw error; }
  return {
    write, usage, ensureObjectRefIndex,
    openRead(hash, assertOwner) {
      const id = crypto.randomUUID();
      write(() => {
        assertOwner?.();
        if (!db.query("SELECT 1 FROM turn_journal_objects WHERE hash=? AND state='present'").get(hash)) throw new JournalStorageUnavailable("the retained object is unavailable");
        db.query("INSERT INTO turn_journal_reservations (id,bytes,pid,pid_start,created_at,hash,kind) VALUES (?,0,?,?,?,?,'read')").run(id, SELF.pid, SELF.start, Date.now(), hash);
      }); return id;
    },
    releaseRead(id) { write(() => db.query("DELETE FROM turn_journal_reservations WHERE id=? AND kind='read'").run(id)); },
    reserveTemporary(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new JournalStorageUnavailable("invalid temporary copy reservation size");
      const id = crypto.randomUUID();
      write(() => db.query("INSERT INTO turn_journal_reservations (id,bytes,pid,pid_start,created_at,hash,kind) VALUES (?,?,?,?,?,NULL,'temporary')")
        .run(id, bytes, SELF.pid, SELF.start, Date.now()));
      let released = false;
      return { id, release() {
        if (released) return;
        write(() => db.query("DELETE FROM turn_journal_reservations WHERE id=? AND kind='temporary'").run(id)); released = true;
      } };
    },
    recover(objects) {
      const rows = db.query("SELECT * FROM turn_journal_reservations").all() as { id: string; hash: string; bytes: number; pid: number; pid_start: string; kind: string }[];
      for (const row of rows) {
        if (processAlive(row.pid, row.pid_start)) continue;
        if (row.kind === "read") { write(() => db.query("DELETE FROM turn_journal_reservations WHERE id=?").run(row.id)); continue; }
        if (row.kind === "temporary") {
          write(() => {
            const current = db.query("SELECT pid,pid_start FROM turn_journal_reservations WHERE id=? AND kind='temporary'").get(row.id) as { pid: number; pid_start: string } | null;
            if (!current || processAlive(current.pid, current.pid_start)) return;
            objects.discardPending(row.id);
            db.query("DELETE FROM turn_journal_reservations WHERE id=? AND kind='temporary'").run(row.id);
          });
          continue;
        }
        const published = objects.has(row.hash);
        if (published && !objects.verify(row.hash, row.bytes)) throw new JournalStorageUnavailable("a published interrupted object failed integrity verification");
        write(() => {
          // Verify liveness again under the database write lock; neither a live
          // writer nor a new reservation sharing this hash is collected.
          const current = db.query("SELECT pid,pid_start FROM turn_journal_reservations WHERE id=?").get(row.id) as { pid: number; pid_start: string } | null;
          if (!current || processAlive(current.pid, current.pid_start)) return;
          objects.discardPending(row.id);
          if (published) db.query("UPDATE turn_journal_objects SET state='present' WHERE hash=?").run(row.hash);
          db.query("DELETE FROM turn_journal_reservations WHERE id=?").run(row.id);
          if (!published) db.query("DELETE FROM turn_journal_objects WHERE hash=? AND state='pending' AND NOT EXISTS (SELECT 1 FROM turn_journal_reservations WHERE hash=?)").run(row.hash, row.hash);
        });
      }
    },
    reserve(bytes, hash) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new JournalStorageUnavailable("invalid content reservation size");
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new JournalStorageUnavailable("invalid content identity");
      const id = crypto.randomUUID();
      write(() => {
        db.query("INSERT OR IGNORE INTO turn_journal_objects VALUES (?, ?, 'pending')").run(hash, bytes);
        db.query("INSERT INTO turn_journal_reservations (id,bytes,pid,pid_start,created_at,hash) VALUES (?, ?, ?, ?, ?, ?)").run(id, bytes, SELF.pid, SELF.start, Date.now(), hash);
      });
      return {
        id,
        finish(actualHash, size, _duplicate) {
          if (actualHash !== hash || size !== bytes) throw new JournalStorageUnavailable("content does not match its admitted identity");
          write(() => {
            db.query("UPDATE turn_journal_objects SET state='present' WHERE hash=?").run(hash);
            db.query("DELETE FROM turn_journal_reservations WHERE id = ?").run(id);
          });
        },
        cancel() { write(() => {
          db.query("DELETE FROM turn_journal_reservations WHERE id = ?").run(id);
          db.query("DELETE FROM turn_journal_objects WHERE hash=? AND state='pending' AND NOT EXISTS (SELECT 1 FROM turn_journal_reservations WHERE hash=?)").run(hash, hash);
        }); },
      };
    },
  };
}

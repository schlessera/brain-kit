import type { JournalRecoveryStatus } from "@schlessera/brain-ui-sdk/protocol";
import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { attachJournalDatabase, JOURNAL_CHANGE_PATH_INDEX, JOURNAL_CONFLICT_TABLES, JOURNAL_CONFLICT_GUARDS, JOURNAL_MIGRATIONS_TABLE, JOURNAL_OBJECT_REFS_INDEX, JOURNAL_SCRUB_QUARANTINE, JOURNAL_SCRUB_GUARDS, JOURNAL_SCHEMA, journalDatabasePath } from "../db/journal-database.js";
import { JournalCapacityError, type JournalObjectAccounting } from "./journal-objects.js";
import { processAlive, SELF } from "./writer-gate.js";

/** The approved aggregate persistent-disk bound, shared by every retained/active turn. */
export const JOURNAL_CAP_BYTES = 10 * 1024 ** 3;

export class JournalStorageUnavailable extends Error {
  readonly reason = "journal_storage_unavailable";
  constructor(message: string) { super(`The change journal cannot safely retain this observation: ${message}`); }
}

/** A known quarantined hash is local to one captured path, not the journal. */
export class JournalObjectQuarantined extends Error {
  constructor() { super("The retained object is quarantined."); }
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
  reserveBatch(entries: { bytes: number; hash: string; turnIds?: readonly string[] }[]): (string | null)[];
  finishBatch(entries: { id: string; hash: string; bytes: number; turnIds?: readonly string[] }[], turnIds: string[]): void;
  cancelBatchReservation(id: string, objects: { has(hash: string): boolean }): void;
  usage(): number;
  /** Admitted, retryable schema upgrade; false leaves integrity-checked collection usable. */
  ensureObjectRefIndex(): boolean;
  ensureScrubQuarantine(): boolean;
  ensureChangePathIndex(): boolean;
  ensureConflictTables(): boolean;
  openRead(hash: string, assertOwner?: () => void): string;
  releaseRead(id: string): void;
  reserveTemporary(bytes: number): { id: string; release(): void };
  recover(objects: { has(hash: string): boolean; verify(hash: string, bytes: number): boolean; discardPending(id: string): void }): JournalRecoveryStatus;
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
  const scrubSchemaExists=()=>Boolean(db.query(`SELECT 1 FROM ${JOURNAL_SCHEMA}.sqlite_schema WHERE type='table' AND name=?`).get(JOURNAL_SCRUB_QUARANTINE.name));
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
    const quarantined = scrubSchemaExists() ? (db.query("SELECT coalesce(sum(bytes),0) AS bytes FROM turn_journal_scrub_quarantine").get() as { bytes: number }).bytes : 0;
    const pending = (db.query("SELECT coalesce(sum(bytes),0) AS bytes FROM turn_journal_reservations").get() as { bytes: number }).bytes;
    return { pages, free, walCapacity, bytes: physical + walCapacity + objects + pending + quarantined };
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
  /** Inside one admitted transaction: absence plus pending state is only an intent. */
  function discardUnpublishedIntent(id: string, hash: string): boolean {
    const object = db.query("SELECT state FROM turn_journal_objects WHERE hash=?").get(hash) as { state: string } | null;
    // A present row or committed version metadata proves earlier publication;
    // its absent bytes must still quarantine, never become a clean intent.
    const committed = object?.state === "present" || db.query(`SELECT 1 FROM (
      SELECT json_extract(before_json,'$.hash') AS hash FROM turn_journal_changes UNION ALL SELECT json_extract(after_json,'$.hash') FROM turn_journal_changes
      UNION ALL SELECT json_extract(before_json,'$.hash') FROM turn_journal_claude_memory UNION ALL SELECT json_extract(after_json,'$.hash') FROM turn_journal_claude_memory
      UNION ALL SELECT json_extract(before_json,'$.hash') FROM turn_journal_revert_paths UNION ALL SELECT json_extract(after_json,'$.hash') FROM turn_journal_revert_paths
      UNION ALL SELECT json_extract(file.value,'$.retained.hash') FROM turn_journal_storage_operations s, json_each(s.private_versions) file
    ) WHERE hash=? LIMIT 1`).get(hash);
    if (committed) return false;
    db.query("DELETE FROM turn_journal_reservations WHERE id=?").run(id);
    // Another copy may still own its intent pins. Only the last unpublished
    // reservation releases those pins and the never-published object row.
    if (!db.query("SELECT 1 FROM turn_journal_reservations WHERE hash=? LIMIT 1").get(hash)) {
      db.query("DELETE FROM turn_journal_object_refs WHERE hash=?").run(hash);
      db.query("DELETE FROM turn_journal_objects WHERE hash=? AND state='pending'").run(hash);
    }
    return true;
  }
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
  function ensureIndex(index: { name: string; sql: string }, payloadSql: string): boolean {
    const exists = () => Boolean(db.query(`SELECT 1 FROM ${JOURNAL_SCHEMA}.sqlite_schema WHERE type='index' AND name=?`).get(index.name));
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
        const payload = (db.query(payloadSql).get() as { bytes: number }).bytes;
        const pages = 8 + 2 * Math.ceil(payload / (pageSize - 128));
        const before = measure(), projected = measure(pages), debt = wal();
        if (projected.bytes + debt > cap) {
          if (debt > 0) throw new WalDebt();
          throw new JournalCapacityError();
        }
        db.exec(index.sql.replace("CREATE INDEX ", `CREATE INDEX ${JOURNAL_SCHEMA}.`));
        if (measure().pages > before.pages + pages) throw new JournalCapacityError("The journal reference index exceeded its admitted page allowance.");
      });
      return true;
    } catch (error) {
      if (!(error instanceof JournalCapacityError || error instanceof JournalStorageUnavailable)) throw error;
      return false;
    }
  }
  /** Like the reference index, optional scrub DDL is quota-admitted, not a
   * boot migration. Eight pages cover the table, primary-key index, schema and
   * pointer maps; reserve their FULL WAL too, then verify before commit.
   */
  const scrubSchemaReady=()=>scrubSchemaExists()&&(db.query("SELECT count(*) AS n FROM journal.sqlite_schema WHERE type='trigger' AND name IN (SELECT value FROM json_each(?))").get(JSON.stringify(JOURNAL_SCRUB_GUARDS.map(guard=>guard.name))) as {n:number}).n===JOURNAL_SCRUB_GUARDS.length;
  function ensureScrubQuarantine(): boolean {
    if(scrubSchemaReady())return true;
    try {
      write(()=>{
        if(scrubSchemaReady())return;
        const pages=8,before=measure(),projected=measure(pages),debt=wal();
        if(projected.bytes+debt>cap){if(debt>0)throw new WalDebt();throw new JournalCapacityError();}
        if(!scrubSchemaExists())db.exec(JOURNAL_SCRUB_QUARANTINE.sql);
        for(const guard of JOURNAL_SCRUB_GUARDS)if(!db.query("SELECT 1 FROM journal.sqlite_schema WHERE type='trigger' AND name=?").get(guard.name))
          db.exec(guard.sql.replace("CREATE TRIGGER ","CREATE TRIGGER journal."));
        installEscapeGuard(db);
        if(measure().pages>before.pages+pages)throw new JournalCapacityError("The scrub schema exceeded its admitted page allowance.");
      });
      return true;
    }catch(error){
      if(!(error instanceof JournalCapacityError||error instanceof JournalStorageUnavailable))throw error;
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
    write, usage, ensureScrubQuarantine,
    ensureConflictTables() {
      const row = db.query("SELECT count(*) AS n FROM journal.sqlite_schema WHERE type='table' AND name IN ('turn_journal_path_peers','turn_journal_path_conflicts')").get() as { n: number };
      const guards = db.query("SELECT count(*) AS n FROM journal.sqlite_schema WHERE type='trigger' AND name IN (SELECT value FROM json_each(?))").get(JSON.stringify(JOURNAL_CONFLICT_GUARDS.map(guard => guard.name))) as { n: number };
      if (row.n === 2 && guards.n === JOURNAL_CONFLICT_GUARDS.length) return true;
      write(() => {
        for (const table of JOURNAL_CONFLICT_TABLES) if (!db.query("SELECT 1 FROM journal.sqlite_schema WHERE type='table' AND name=?").get(table.name))
          db.exec(table.sql.replace("CREATE TABLE ", "CREATE TABLE journal."));
        for (const guard of JOURNAL_CONFLICT_GUARDS) if (!db.query("SELECT 1 FROM journal.sqlite_schema WHERE type='trigger' AND name=?").get(guard.name))
          db.exec(guard.sql.replace("CREATE TRIGGER ", "CREATE TRIGGER journal."));
      });
      installEscapeGuard(db); return true;
    },
    ensureObjectRefIndex: () => ensureIndex(JOURNAL_OBJECT_REFS_INDEX, "SELECT coalesce(sum(length(CAST(hash AS BLOB))+32),0) AS bytes FROM turn_journal_object_refs"),
    ensureChangePathIndex: () => ensureIndex(JOURNAL_CHANGE_PATH_INDEX, "SELECT coalesce(sum(length(CAST(turn_id AS BLOB))+length(CAST(path AS BLOB))+48),0) AS bytes FROM turn_journal_changes"),
    openRead(hash, assertOwner) {
      const id = crypto.randomUUID();
      write(() => {
        assertOwner?.();
        if (db.query("SELECT 1 FROM turn_journal_object_quarantine WHERE hash=?").get(hash)) throw new JournalStorageUnavailable("the retained object is quarantined");
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
      const report: JournalRecoveryStatus = { unresolvedRecords: 0, firstCause: null };
      const rows = db.query("SELECT * FROM turn_journal_reservations").all() as { id: string; hash: string; bytes: number; pid: number; pid_start: string; kind: string; recovery_failure: string | null }[];
      const recordFailure=(row:typeof rows[number],error:unknown)=>{
          // An I/O refusal proves neither existence nor corruption. Keep the
          // reservation and its state untouched for the next recovery pass.
          const fresh: NonNullable<JournalRecoveryStatus["firstCause"]> = {
            reservationId: row.id, hash: row.hash ?? "", site: "journal-accounting.recover", at: Date.now(),
            errorClass: error instanceof Error ? error.name : "Error", message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
          // A damaged stored cause is a diagnostic, never a boot refusal.
          let stored: unknown;
          try { stored = row.recovery_failure ? JSON.parse(row.recovery_failure) : undefined; } catch { stored = undefined; }
          const cause: NonNullable<JournalRecoveryStatus["firstCause"]> = stored && typeof stored === "object" && typeof (stored as { at?: unknown }).at === "number"
            ? stored as NonNullable<JournalRecoveryStatus["firstCause"]> : fresh;
          let diagnosticError: string | undefined;
          try {
            // The cause belongs to the existing reservation: it disappears only
            // when that reservation resolves, never by clearing its charge early.
            write(() => db.query("UPDATE turn_journal_reservations SET recovery_failure=coalesce(recovery_failure,?) WHERE id=?")
              .run(JSON.stringify(cause), row.id));
          } catch (failure) { diagnosticError = String(failure); }
          // A full/unwritable diagnostic store cannot turn a local I/O refusal
          // into a boot refusal. Return the cause to the owner even in that case.
          report.unresolvedRecords++;
          if (!report.firstCause || cause.at < report.firstCause.at) report.firstCause = cause;
          process.stderr.write(JSON.stringify({ kind: "journal_object_recovery_pending", ...cause,
            ...(cause !== fresh ? { currentErrorClass: fresh.errorClass, currentError: fresh.message } : {}), ...(diagnosticError ? { diagnosticError } : {}) }) + "\n");
      };
      for (const row of rows) {
        try {
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
        let published = false, corrupt: unknown;
        {
          // Retire the dead reservation's exact temporary name before checking
          // the digest: a crash may have left these as two links to one inode.
          // This is physical cleanup of the dead owner's temporary name, not
          // a ledger commit. Releasing its charge and publishing its durable
          // state below must be one admission, even when that charge is over cap.
          objects.discardPending(row.id);
          published = objects.has(row.hash);
          if (published && !objects.verify(row.hash, row.bytes)) corrupt = new Error("Published interrupted object failed integrity verification");
        }
        let quarantined = false;
        write(() => {
          // Verify liveness again under the database write lock; neither a live
          // writer nor a new reservation sharing this hash is collected.
          const current = db.query("SELECT pid,pid_start FROM turn_journal_reservations WHERE id=?").get(row.id) as { pid: number; pid_start: string } | null;
          if (!current || processAlive(current.pid, current.pid_start)) return;
          objects.discardPending(row.id);
          if (!published && !corrupt) {
            if (discardUnpublishedIntent(row.id, row.hash)) return;
            corrupt = new Error("Retained interrupted object is absent");
          }
          if (corrupt) {
            const cause = { errorClass: corrupt instanceof Error ? corrupt.name : "Error", message: (corrupt instanceof Error ? corrupt.message : String(corrupt)).slice(0, 2000) };
            db.query("INSERT OR IGNORE INTO turn_journal_object_quarantine VALUES (?,?,?,?,?)").run(row.hash, Date.now(), cause.errorClass, cause.message, "journal-accounting.recover");
            // Logical quarantine keeps the bytes at their original hash, charged,
            // but no read or replacement reservation can use them. Only normal
            // expiry/collection removes them after their owners release them.
            db.query("UPDATE turn_journal_objects SET state='present' WHERE hash=?").run(row.hash);
            const owners = db.query("SELECT t.turn_id,t.missing FROM turn_journal_turns t JOIN turn_journal_object_refs r ON r.turn_id=t.turn_id WHERE r.hash=?").all(row.hash) as {turn_id:string;missing:string}[];
            for (const owner of owners) {
              const paths = db.query(`SELECT path FROM turn_journal_changes WHERE turn_id=?1 AND (json_extract(before_json,'$.hash')=?2 OR json_extract(after_json,'$.hash')=?2)
                UNION SELECT checkout AS path FROM turn_journal_code_receipts WHERE turn_id=?1 AND pack_hash=?2
                UNION SELECT path FROM turn_journal_claude_memory WHERE turn_id=?1 AND (json_extract(before_json,'$.hash')=?2 OR json_extract(after_json,'$.hash')=?2)
                UNION SELECT p.path FROM turn_journal_revert_paths p JOIN turn_journal_revert_operations o ON o.id=p.operation_id WHERE o.journal_turn_id=?1 AND (json_extract(p.before_json,'$.hash')=?2 OR json_extract(p.after_json,'$.hash')=?2)`)
                .all(owner.turn_id, row.hash) as {path:string}[];
              const missing = JSON.parse(owner.missing) as {path:string;reason:string}[];
              for (const {path} of paths.length ? paths : [{path:"."}]) if (!missing.some(item => item.path === path && item.reason === "retained_object_corrupt")) missing.push({path,reason:"retained_object_corrupt"});
              db.query("UPDATE turn_journal_turns SET state=CASE WHEN state='expired' OR ended_at IS NULL THEN state ELSE 'partial' END,missing=? WHERE turn_id=?").run(JSON.stringify(missing), owner.turn_id);
            }
            quarantined = true;
          } else if (published) db.query("UPDATE turn_journal_objects SET state='present' WHERE hash=?").run(row.hash);
          db.query("DELETE FROM turn_journal_reservations WHERE id=?").run(row.id);
          if (!published && !corrupt) db.query("DELETE FROM turn_journal_objects WHERE hash=? AND state='pending' AND NOT EXISTS (SELECT 1 FROM turn_journal_reservations WHERE hash=?)").run(row.hash, row.hash);
        });
        if (quarantined) process.stderr.write(JSON.stringify({ kind: "journal_object_quarantined", hash: row.hash, site: "journal-accounting.recover", at: Date.now(),
          errorClass: corrupt instanceof Error ? corrupt.name : "Error", message: corrupt instanceof Error ? corrupt.message : String(corrupt) }) + "\n");
        }catch(error){recordFailure(row,error);}
      }
      return report;
    },
    reserveBatch(entries) {
      const ids: (string | null)[] = entries.map(() => crypto.randomUUID());
      write(() => {
        for (const [i, entry] of entries.entries()) {
          if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.hash)) throw new JournalStorageUnavailable("invalid batched content reservation");
          if (db.query("SELECT 1 FROM turn_journal_object_quarantine WHERE hash=?").get(entry.hash)) { ids[i] = null; continue; }
          db.query("INSERT OR IGNORE INTO turn_journal_objects VALUES (?,?,'pending')").run(entry.hash, entry.bytes);
          db.query("INSERT INTO turn_journal_reservations (id,bytes,pid,pid_start,created_at,hash) VALUES (?,?,?,?,?,?)")
            .run(ids[i]!, entry.bytes, SELF.pid, SELF.start, Date.now(), entry.hash);
          // The checkpoint may be recovered before completion batching runs.
          // Reserve owner pins with the copy intent, before any bytes publish.
          for (const turnId of entry.turnIds ?? []) db.query("INSERT OR IGNORE INTO turn_journal_object_refs VALUES (?,?)").run(turnId, entry.hash);
        }
      });
      return ids;
    },
    finishBatch(entries, turnIds) {
      write(() => {
        for (const entry of entries) {
          const row = db.query("SELECT hash,bytes FROM turn_journal_reservations WHERE id=? AND kind='copy'").get(entry.id) as { hash: string; bytes: number } | null;
          if (!row || row.hash !== entry.hash || row.bytes !== entry.bytes) throw new JournalStorageUnavailable("content does not match its batched reservation");
          db.query("UPDATE turn_journal_objects SET state='present' WHERE hash=?").run(entry.hash);
          for (const turnId of entry.turnIds ?? turnIds) db.query("INSERT OR IGNORE INTO turn_journal_object_refs VALUES (?,?)").run(turnId, entry.hash);
          db.query("DELETE FROM turn_journal_reservations WHERE id=?").run(entry.id);
        }
      });
    },
    cancelBatchReservation(id, objects) {
      write(() => {
        const row = db.query("SELECT hash FROM turn_journal_reservations WHERE id=? AND kind='copy'").get(id) as { hash: string } | null;
        if (!row) throw new JournalStorageUnavailable("the batched content reservation is unknown");
        if (!objects.has(row.hash) && discardUnpublishedIntent(id, row.hash)) return;
        // A duplicate or already published copy keeps its owner pins/charge.
        db.query("UPDATE turn_journal_objects SET state='present' WHERE hash=?").run(row.hash);
        db.query("DELETE FROM turn_journal_reservations WHERE id=?").run(id);
      });
    },
    reserve(bytes, hash) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new JournalStorageUnavailable("invalid content reservation size");
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new JournalStorageUnavailable("invalid content identity");
      const id = crypto.randomUUID();
      write(() => {
        if (db.query("SELECT 1 FROM turn_journal_object_quarantine WHERE hash=?").get(hash)) throw new JournalObjectQuarantined();
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

import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
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
function installEscapeGuard(db: Database) {
  const tables = (db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'turn_journal_*' AND name != 'turn_journal_allocation'").all() as { name: string }[]).map(row => row.name);
  for (const table of tables) for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${table}_accounted_${event.toLowerCase()} BEFORE ${event} ON main.${table}
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
  openRead(hash: string, assertOwner?: () => void): string;
  releaseRead(id: string): void;
  reserveTemporary(bytes: number): { id: string; release(): void };
  recover(objects: { has(hash: string): boolean; verify(hash: string, bytes: number): boolean; discardPending(id: string): void }): void;
} {
  const cap = options.capBytes ?? JOURNAL_CAP_BYTES;
  const memory = dbPath === ":memory:" || dbPath === "";
  const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size;
  const wal = () => { if (memory) return 0; try { return statSync(`${dbPath}-wal`).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; } };
  installEscapeGuard(db);
  function measure() {
    const prior = db.query("SELECT pages FROM turn_journal_allocation WHERE id = 1").get() as { pages: string };
    const logicalPages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
    const extent = memory ? logicalPages : Math.max(logicalPages, Math.ceil(statSync(dbPath).size / pageSize));
    const historical = new Set<number>((JSON.parse(prior.pages) as number[]).filter(page => page <= extent));
    const names = (db.query("SELECT name FROM sqlite_schema WHERE tbl_name GLOB 'turn_journal_*'").all() as { name: string }[]).map(row => row.name);
    // Only the journal's own b-trees are walked, never the whole database.
    const journal = new Set<number>();
    for (const name of names) for (const row of db.query("SELECT pageno FROM dbstat WHERE name = ?").iterate(name) as Iterable<{ pageno: number }>) journal.add(row.pageno);
    const owned = journal.size;
    const free = (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
    // Formerly-owned pages outside the journal stay charged while they can
    // still be free. Without walking other b-trees, a page another component
    // reused looks the same as a free one, so at most as many stay charged as
    // SQLite has unallocated pages: never fewer than the pages truly free.
    let released = [...historical].filter(page => !journal.has(page));
    const unallocated = free + Math.max(0, extent - logicalPages);
    if (released.length > unallocated) released = released.slice(released.length - unallocated);
    const retainedFree = released.length;
    for (const page of released) journal.add(page);
    const pages = journal;
    // One spill-disabled commit writes each journal page at most once. Global
    // allocation can also touch page 1 and free-list trunk pages, not unrelated
    // Activity payload pages. Keep this temporary capacity reserved even after
    // checkpoint so a crash cannot lose the accounting before reconciliation.
    const walCapacity = memory ? 0 : 32 + (owned + retainedFree + 1 + Math.ceil((free + owned) / (pageSize / 4 - 2))) * (pageSize + 24);
    const physical = memory ? 0 : (owned + retainedFree + 1) * pageSize;
    const objects = (db.query("SELECT coalesce(sum(bytes),0) AS bytes FROM turn_journal_objects WHERE state='present'").get() as { bytes: number }).bytes;
    const pending = (db.query("SELECT coalesce(sum(bytes),0) AS bytes FROM turn_journal_reservations").get() as { bytes: number }).bytes;
    return { pages: [...pages].sort((a, b) => a - b), walCapacity, bytes: physical + walCapacity + objects + pending };
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
   * One accounted transaction. Writes no longer truncate the WAL first, so
   * admission charges the whole WAL file as it stands, whoever wrote it:
   * earlier journal commits, an abandoned or failed commit's tail, other
   * components' frames. The measurement's WAL capacity covers this commit.
   * `fresh` requires an empty WAL under this write lock, right after a
   * checkpoint, as every write used to.
   */
  function admit<T>(operation: () => T, fresh: boolean, retryable: boolean) {
    return db.transaction(() => {
      const walBefore = wal();
      // Checkpoint and BEGIN cannot be one SQLite critical section. A
      // writer that won between them is detected under this write lock;
      // roll back before any journal mutation and retry the checkpoint.
      if (fresh && walBefore !== 0) throw new CheckpointRace();
      const before = measure();
      if (retryable && walBefore > 0 && before.bytes + walBefore > cap) throw new WalDebt();
      db.query("UPDATE turn_journal_allocation SET pages = ?, writing = 1 WHERE id = 1").run(JSON.stringify(before.pages));
      const result = operation();
      for (let pass = 0; pass < 10; pass++) {
        const measured = measure();
        if (measured.bytes + walBefore > cap) throw retryable && walBefore > 0 ? new WalDebt() : new JournalCapacityError();
        // The WAL after this commit stays within what it held plus this commit.
        const pages = JSON.stringify(measured.pages), reserved = walBefore + measured.walCapacity;
        const prior = db.query("SELECT pages,wal_reserved,writing FROM turn_journal_allocation WHERE id = 1").get() as { pages: string; wal_reserved: number; writing: number };
        if (prior.pages === pages && prior.wal_reserved === reserved && prior.writing === 0) return result;
        db.query("UPDATE turn_journal_allocation SET pages = ?,wal_reserved = ?,writing = 0 WHERE id = 1").run(pages, reserved);
      }
      throw new JournalStorageUnavailable("allocation accounting did not stabilize");
    }).immediate();
  }
  let established = false;
  /** Every journal commit stays FULL: it is durable before the turn proceeds. */
  const write = <T>(operation: () => T): T => {
    if (db.inTransaction) throw new JournalStorageUnavailable("a journal write cannot run inside another transaction");
    const spill = (db.query("PRAGMA cache_spill").get() as { cache_spill: number }).cache_spill;
    const synchronous = (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
    db.exec("PRAGMA synchronous = FULL");
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
    } finally { db.exec(`PRAGMA cache_spill = ${spill}`); db.exec(`PRAGMA synchronous = ${synchronous}`); }
  };
  const usage = (): number => {
    const measured = measure();
    // The standing charge keeps at least one commit of WAL headroom reserved.
    return measured.bytes - measured.walCapacity + Math.max(measured.walCapacity, wal());
  };
  // Truncate while the server starts. A pinned WAL or an over-cap store
  // leaves this to the first write, which refuses or recovers as it always did.
  try { write(() => {}); } catch (error) { if (!(error instanceof JournalStorageUnavailable || error instanceof JournalCapacityError)) throw error; }
  return {
    write, usage,
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

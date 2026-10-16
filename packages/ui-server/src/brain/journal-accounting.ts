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

export function createJournalAccounting(db: Database, dbPath: string, options: {
  capBytes?: number;
  /** An internal deterministic scheduling hook; production does not supply one. */
  afterCheckpoint?: () => void;
} = {}): JournalObjectAccounting & {
  write<T>(operation: () => T): T;
  usage(): number;
  openRead(hash: string, assertOwner?: () => void): string;
  releaseRead(id: string): void;
  recover(objects: { has(hash: string): boolean; verify(hash: string, bytes: number): boolean; discardPending(id: string): void }): void;
} {
  const cap = options.capBytes ?? JOURNAL_CAP_BYTES;
  const memory = dbPath === ":memory:" || dbPath === "";
  const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number }).page_size;
  const wal = () => { try { return statSync(`${dbPath}-wal`).size; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; } };
  function measure() {
    const prior = db.query("SELECT pages FROM turn_journal_allocation WHERE id = 1").get() as { pages: string };
    const logicalPages = (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
    const extent = memory ? logicalPages : Math.max(logicalPages, Math.ceil(statSync(dbPath).size / pageSize));
    const historical = new Set<number>((JSON.parse(prior.pages) as number[]).filter(page => page <= extent));
    const names = new Set((db.query("SELECT name FROM sqlite_schema WHERE tbl_name GLOB 'turn_journal_*'").all() as { name: string }[]).map(row => row.name));
    let owned = 0;
    // Start with formerly-owned pages. Those still on SQLite's free list stay
    // charged; a page reassigned to another component no longer belongs here.
    let retainedFree = historical.size;
    for (const row of db.query("SELECT pageno, name FROM dbstat").iterate() as Iterable<{ pageno: number; name: string }>) {
      if (historical.has(row.pageno)) retainedFree--;
      if (names.has(row.name)) { owned++; historical.add(row.pageno); }
      else historical.delete(row.pageno);
    }
    const free = (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
    // One spill-disabled commit writes each journal page at most once. Global
    // allocation can also touch page 1 and free-list trunk pages, not unrelated
    // Activity payload pages. Keep this temporary capacity reserved even after
    // checkpoint so a crash cannot lose the accounting before reconciliation.
    const walCapacity = memory ? 0 : 32 + (owned + retainedFree + 1 + Math.ceil((free + owned) / (pageSize / 4 - 2))) * (pageSize + 24);
    const physical = memory ? 0 : (owned + retainedFree + 1) * pageSize;
    const objects = (db.query("SELECT coalesce(sum(bytes),0) AS bytes FROM turn_journal_objects WHERE state='present'").get() as { bytes: number }).bytes;
    const pending = (db.query("SELECT coalesce(sum(bytes),0) AS bytes FROM turn_journal_reservations").get() as { bytes: number }).bytes;
    return { pages: [...historical].sort((a, b) => a - b), walCapacity, bytes: physical + walCapacity + objects + pending };
  }
  class CheckpointRace extends Error {}
  const write = <T>(operation: () => T): T => {
    if (db.inTransaction) throw new JournalStorageUnavailable("a journal write cannot checkpoint inside another transaction");
    const spill = (db.query("PRAGMA cache_spill").get() as { cache_spill: number }).cache_spill;
    const synchronous = (db.query("PRAGMA synchronous").get() as { synchronous: number }).synchronous;
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA cache_spill = OFF");
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!memory) {
          const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
          if (checkpoint.busy) throw new JournalStorageUnavailable("a database reader still holds journal write-ahead data");
        }
        options.afterCheckpoint?.();
        try {
          return db.transaction(() => {
            // Checkpoint and BEGIN cannot be one SQLite critical section. A
            // writer that won between them is detected under this write lock;
            // roll back before any journal mutation and retry the checkpoint.
            if (!memory && wal() !== 0) throw new CheckpointRace();
            const before = measure();
            db.query("UPDATE turn_journal_allocation SET pages = ? WHERE id = 1").run(JSON.stringify(before.pages));
            const result = operation();
            for (let pass = 0; pass < 10; pass++) {
              const measured = measure();
              if (measured.bytes > cap) throw new JournalCapacityError();
              const pages = JSON.stringify(measured.pages);
              const prior = db.query("SELECT pages,wal_reserved FROM turn_journal_allocation WHERE id = 1").get() as { pages: string; wal_reserved: number };
              if (prior.pages === pages && prior.wal_reserved === measured.walCapacity) return result;
              db.query("UPDATE turn_journal_allocation SET pages = ?,wal_reserved = ? WHERE id = 1").run(pages, measured.walCapacity);
            }
            throw new JournalStorageUnavailable("allocation accounting did not stabilize");
          }).immediate();
        } catch (error) { if (!(error instanceof CheckpointRace)) throw error; }
      }
      throw new JournalStorageUnavailable("another database writer repeatedly won checkpoint admission");
    } finally { db.exec(`PRAGMA cache_spill = ${spill}`); db.exec(`PRAGMA synchronous = ${synchronous}`); }
  };
  const usage = (): number => measure().bytes;
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
    recover(objects) {
      const rows = db.query("SELECT * FROM turn_journal_reservations").all() as { id: string; hash: string; bytes: number; pid: number; pid_start: string; kind: string }[];
      for (const row of rows) {
        if (processAlive(row.pid, row.pid_start)) continue;
        if (row.kind === "read") { write(() => db.query("DELETE FROM turn_journal_reservations WHERE id=?").run(row.id)); continue; }
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

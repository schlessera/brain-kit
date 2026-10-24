import type { Database } from "bun:sqlite";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { endianness } from "node:os";
import { JournalCapacityError, type JournalObjectAccounting } from "./journal-objects.js";
import { processAlive, SELF } from "./writer-gate.js";

/** The approved aggregate persistent-disk bound, shared by every retained/active turn. */
export const JOURNAL_CAP_BYTES = 10 * 1024 ** 3;

export class JournalStorageUnavailable extends Error {
  readonly reason = "journal_storage_unavailable";
  constructor(message: string) { super(`The change journal cannot safely retain this observation: ${message}`); }
}

/**
 * Connection-local triggers. A journal row changed outside an accounted write
 * is refused, so no journal storage reaches the disk unadmitted. Inside an
 * accounted write, no other component's row may be updated or deleted: the
 * pages a journal commit can newly own are then only file growth and pages
 * that were already free, which is what admission charges without a walk.
 */
function installGuards(db: Database) {
  const tables = (db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name);
  for (const table of tables) {
    if (table === "turn_journal_allocation") continue;
    const journal = table.startsWith("turn_journal_");
    for (const event of journal ? ["INSERT", "UPDATE", "DELETE"] : ["UPDATE", "DELETE"]) {
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS "${table}_accounted_${event.toLowerCase()}" BEFORE ${event} ON main."${table}"
        WHEN (SELECT writing FROM turn_journal_allocation WHERE id = 1) IS ${journal ? "NOT 1" : "1"}
        BEGIN SELECT RAISE(ABORT, '${journal ? "journal storage write outside capacity accounting" : "a journal write cannot release pages another component owns"}'); END`);
    }
  }
}

/**
 * What a connection knows between its journal commits: the pages its last
 * commit wrote, read back from that commit's WAL frames, and the database
 * state they are valid for. Shared by every ledger on one connection.
 */
interface Tracking { pending: Set<number>; current: boolean; dataVersion: number; layout: string; pageCount: number }
const tracking = new WeakMap<Database, Tracking>();

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
  const pageCount = () => (db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
  const freelist = () => (db.query("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count;
  const dataVersion = () => (db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
  const layout = () => (db.query("SELECT group_concat(name || ':' || rootpage, ',') AS layout FROM (SELECT name, rootpage FROM sqlite_schema WHERE tbl_name GLOB 'turn_journal_*' ORDER BY name)").get() as { layout: string | null }).layout ?? "";
  const allocation = () => db.query("SELECT pages, charged_pages FROM turn_journal_allocation WHERE id = 1").get() as { pages: string; charged_pages: number | null };
  const totals = () => (db.query("SELECT (SELECT coalesce(sum(bytes),0) FROM turn_journal_objects WHERE state='present') + (SELECT coalesce(sum(bytes),0) FROM turn_journal_reservations) AS bytes").get() as { bytes: number }).bytes;
  // One spill-disabled commit writes each page at most once: journal pages,
  // pages it allocates, page 1 and free-list trunk pages. Keep this temporary
  // capacity reserved even after checkpoint so a crash cannot lose the
  // accounting before reconciliation.
  const walCapacity = (pages: number, free: number) => memory ? 0 : 32 + (pages + 1 + Math.ceil((free + pages) / (pageSize / 4 - 2))) * (pageSize + 24);
  // Tables created later get their guards before the next journal write.
  const schemaVersion = () => (db.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version;
  let guarded = -1;
  const guard = () => { const version = schemaVersion(); if (version !== guarded) { installGuards(db); guarded = version; } };
  guard();
  if (!tracking.has(db)) tracking.set(db, { pending: new Set(), current: false, dataVersion: 0, layout: "", pageCount: 0 });
  const tracked = tracking.get(db)!;

  /**
   * #2172's page-identity measurement, by walking every b-tree: the journal's
   * pages, plus formerly charged pages that are now in no b-tree. A page
   * reassigned to another component no longer belongs here. It runs when a
   * ledger starts, when another connection has committed, when the journal's
   * schema or the file shrank, and before any refusal, never on an ordinary
   * write.
   */
  function walk(extra: Iterable<number>) {
    const logicalPages = pageCount();
    const extent = memory ? logicalPages : Math.max(logicalPages, Math.ceil(statSync(dbPath).size / pageSize));
    const charged = (db.query("SELECT pageno FROM turn_journal_pages").values() as [number][]).map(row => row[0]);
    const historical = new Set<number>([...(JSON.parse(allocation().pages) as number[]), ...charged, ...extra].filter(page => page <= extent));
    const names = new Set((db.query("SELECT name FROM sqlite_schema WHERE tbl_name GLOB 'turn_journal_*'").all() as { name: string }[]).map(row => row.name));
    let owned = 0;
    let retainedFree = historical.size;
    for (const row of db.query("SELECT pageno, name FROM dbstat").iterate() as Iterable<{ pageno: number; name: string }>) {
      if (historical.has(row.pageno)) retainedFree--;
      if (names.has(row.name)) { owned++; historical.add(row.pageno); }
      else historical.delete(row.pageno);
    }
    const free = freelist();
    const capacity = memory ? 0 : 32 + (owned + retainedFree + 1 + Math.ceil((free + owned) / (pageSize / 4 - 2))) * (pageSize + 24);
    const physical = memory ? 0 : (owned + retainedFree + 1) * pageSize;
    return { pages: historical, walCapacity: capacity, bytes: physical + capacity + totals() };
  }
  /** Replaces the charged page set with an exact measurement; true when it changed. */
  function store(pages: Set<number>) {
    const charged = new Set((db.query("SELECT pageno FROM turn_journal_pages").values() as [number][]).map(row => row[0]));
    let changed = false;
    for (const page of charged) if (!pages.has(page)) { db.query("DELETE FROM turn_journal_pages WHERE pageno = ?").run(page); changed = true; }
    for (const page of pages) if (!charged.has(page)) { db.query("INSERT INTO turn_journal_pages (pageno) VALUES (?)").run(page); changed = true; }
    db.query("UPDATE turn_journal_allocation SET pages = '[]', charged_pages = ? WHERE id = 1").run(pages.size);
    return changed;
  }
  /** Adds the pages the last commit wrote; any of them may now be the journal's. */
  function record(pages: Iterable<number>) {
    let added = 0;
    for (const page of pages) added += db.query("INSERT OR IGNORE INTO turn_journal_pages (pageno) VALUES (?)").run(page).changes;
    if (added) db.query("UPDATE turn_journal_allocation SET charged_pages = charged_pages + ? WHERE id = 1").run(added);
  }
  const nativeEndian = endianness() === "LE";
  /** The WAL index header SQLite keeps in `-shm`: committed frame count and salts. */
  function walIndex(): { frames: number; salt: string } | null {
    if (memory) return null;
    let fd: number;
    try { fd = openSync(`${dbPath}-shm`, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const header = Buffer.alloc(96);
      // Both copies agree once a commit has finished writing them.
      if (readSync(fd, header, 0, 96, 0) !== 96 || !header.subarray(0, 48).equals(header.subarray(48, 96)) || header[12] !== 1) return null;
      const size = nativeEndian ? header.readUInt16LE(14) : header.readUInt16BE(14);
      if ((size === 1 ? 65536 : size) !== pageSize) return null;
      return { frames: nativeEndian ? header.readUInt32LE(16) : header.readUInt32BE(16), salt: header.subarray(32, 40).toString("hex") };
    } finally { closeSync(fd); }
  }
  /** Page numbers of committed frames (from, to], or null if the WAL no longer holds them. */
  function framePages(from: number, to: number, salt: string): number[] | null {
    let fd: number;
    try { fd = openSync(`${dbPath}-wal`, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const header = Buffer.alloc(32), frame = Buffer.alloc(24), pages: number[] = [];
      if (readSync(fd, header, 0, 32, 0) !== 32 || header.subarray(16, 24).toString("hex") !== salt) return null;
      for (let index = from + 1; index <= to; index++) {
        if (readSync(fd, frame, 0, 24, 32 + (index - 1) * (pageSize + 24)) !== 24 || frame.subarray(8, 16).toString("hex") !== salt) return null;
        pages.push(frame.readUInt32BE(0));
      }
      return pages;
    } finally { closeSync(fd); }
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
   * One accounted transaction. The charge is the whole WAL file as it stands,
   * whoever wrote it, plus the journal's charged pages, plus this commit's WAL
   * capacity. On an ordinary write the charged pages are every page a journal
   * commit has written since the last walk, and this commit may newly own any
   * page the file grows by or that was free when it began. Only when that
   * charge would refuse does the write walk, and then it is exact. `fresh`
   * requires an empty WAL under this write lock, right after a checkpoint.
   */
  function admit<T>(operation: () => T, fresh: boolean, retryable: boolean) {
    return db.transaction(() => {
      const walBefore = wal();
      // Checkpoint and BEGIN cannot be one SQLite critical section. A
      // writer that won between them is detected under this write lock;
      // roll back before any journal mutation and retry the checkpoint.
      if (fresh && walBefore !== 0) throw new CheckpointRace();
      const index = walIndex(), version = dataVersion(), shape = layout(), pages0 = pageCount(), free0 = freelist();
      // Another connection's commit, a changed journal schema or a shrunk
      // file can move pages this connection never saw being written.
      const walked = fresh || !tracked.current || (!memory && index === null) || version !== tracked.dataVersion
        || shape !== tracked.layout || pages0 < tracked.pageCount || allocation().charged_pages === null;
      db.query("UPDATE turn_journal_allocation SET writing = 1 WHERE id = 1").run();
      if (!walked) record(tracked.pending);
      const result = operation();
      let reserved: number | undefined;
      if (!walked) {
        const charged = allocation().charged_pages! + Math.max(0, pageCount() - pages0) + free0;
        const capacity = walCapacity(charged, free0);
        if ((memory ? 0 : (charged + 1) * pageSize) + capacity + walBefore + totals() <= cap) reserved = walBefore + capacity;
      }
      for (let pass = 0; reserved === undefined; pass++) {
        if (pass === 10) throw new JournalStorageUnavailable("allocation accounting did not stabilize");
        const measured = walk(tracked.pending);
        if (measured.bytes + walBefore > cap) throw retryable && walBefore > 0 ? new WalDebt() : new JournalCapacityError();
        // Storing the set can allocate pages of its own; measure until it does not.
        if (!store(measured.pages)) reserved = walBefore + measured.walCapacity;
      }
      db.query("UPDATE turn_journal_allocation SET wal_reserved = ?, writing = 0 WHERE id = 1").run(reserved);
      return { result, index, version, shape };
    }).immediate();
  }
  /** Learns which pages the commit just made wrote, from its own WAL frames. */
  function observe(committed: { index: { frames: number; salt: string } | null; version: number; shape: string }) {
    const index = walIndex(), version = dataVersion();
    let pages: number[] | null = [];
    if (!memory) pages = index && committed.index && version === committed.version
      ? framePages(index.salt === committed.index.salt ? committed.index.frames : 0, index.frames, index.salt) : null;
    // Unknown pages leave nothing to trust: the next write walks.
    Object.assign(tracked, pages ? { pending: new Set(pages), current: true, dataVersion: version, layout: committed.shape, pageCount: pageCount() } : { current: false });
  }
  let established = false;
  /** Every journal commit stays FULL: it is durable before the turn proceeds. */
  const write = <T>(operation: () => T): T => {
    if (db.inTransaction) throw new JournalStorageUnavailable("a journal write cannot run inside another transaction");
    guard();
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
          const committed = admit(operation, fresh, !fresh);
          established = true;
          observe(committed);
          return committed.result;
        } catch (error) {
          if (error instanceof WalDebt) { fresh = true; continue; }
          if (!(error instanceof CheckpointRace)) throw error;
        }
      }
      throw new JournalStorageUnavailable("another database writer repeatedly won checkpoint admission");
    } finally { db.exec(`PRAGMA cache_spill = ${spill}`); db.exec(`PRAGMA synchronous = ${synchronous}`); }
  };
  const usage = (): number => {
    const charged = allocation().charged_pages;
    if (!tracked.current || charged === null || dataVersion() !== tracked.dataVersion || layout() !== tracked.layout || pageCount() < tracked.pageCount) {
      const measured = walk(tracked.pending);
      return measured.bytes - measured.walCapacity + Math.max(measured.walCapacity, wal());
    }
    const unrecorded = [...tracked.pending].filter(page => !db.query("SELECT 1 FROM turn_journal_pages WHERE pageno = ?").get(page)).length;
    const pages = charged + unrecorded, free = freelist();
    // The standing charge keeps at least one commit of WAL headroom reserved.
    return (memory ? 0 : (pages + 1) * pageSize) + Math.max(walCapacity(pages, free), wal()) + totals();
  };
  // Measure and truncate while the server starts. A pinned WAL or an over-cap
  // store leaves this to the first write, which refuses or recovers as it always did.
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

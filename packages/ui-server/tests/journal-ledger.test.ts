import { expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createJournalAccounting } from "../src/brain/journal-accounting.js";
import { JournalCapacityError } from "../src/brain/journal-objects.js";

const turn = (db: Database, id: string, summary: string) => db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state,summary) VALUES (?,'interactive','governed',0,'active',?)").run(id, summary);
function fixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `journal-ledger-${prefix}-odysseus-`)), path = join(root, "ui.db");
  return { root, path, db: createUiDb(path), close(...dbs: Database[]) { for (const db of dbs) db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const reserved = (db: Database) => (db.query("SELECT wal_reserved FROM turn_journal_allocation WHERE id=1").get() as { wal_reserved: number }).wal_reserved;

test("a journal write after startup takes no WAL checkpoint and walks no b-tree", () => {
  const f = fixture("path");
  let checkpoints = 0;
  const ledger = createJournalAccounting(f.db, f.path, { afterCheckpoint() { checkpoints++; } });
  const statements: string[] = [];
  const original = f.db.query.bind(f.db);
  const query = spyOn(f.db, "query").mockImplementation(((sql: string) => { statements.push(sql); return original(sql); }) as typeof f.db.query);
  try {
    const startup = checkpoints;
    for (let index = 0; index < 5; index++) {
      ledger.write(() => turn(f.db, `odysseus-${index}`, "Ithaca".repeat(400)));
      ledger.write(() => f.db.query("UPDATE turn_journal_turns SET session_id='penelope' WHERE turn_id=?").run(`odysseus-${index}`));
    }
    const reservation = ledger.reserveTemporary(4096); reservation.release();
    expect(statements.filter(sql => /wal_checkpoint/i.test(sql)), "JOURNAL_WRITE_RUNS_NO_CHECKPOINT").toEqual([]);
    expect(statements.filter(sql => /dbstat/i.test(sql)), "JOURNAL_WRITE_WALKS_NO_BTREE").toEqual([]);
    expect(checkpoints - startup, "JOURNAL_WRITE_TAKES_NO_CHECKPOINT").toBe(0);
    expect(startup, "JOURNAL_STARTUP_ESTABLISHES_EMPTY_WAL").toBe(1);
    expect(reserved(f.db), "JOURNAL_WAL_DEBT_STAYS_RESERVED").toBeGreaterThanOrEqual(statSync(`${f.path}-wal`).size);
  } finally { query.mockRestore(); f.close(f.db); }
});

test("a journal row changed outside accounting is refused on every journal table", () => {
  const f = fixture("escape");
  const ledger = createJournalAccounting(f.db, f.path);
  try {
    const tables = (f.db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'turn_journal_*' AND name != 'turn_journal_allocation'").all() as { name: string }[]).map(row => row.name);
    const guarded = new Set((f.db.query("SELECT tbl_name,sql FROM sqlite_temp_schema WHERE type='trigger' AND sql LIKE '%outside capacity accounting%'").all() as { tbl_name: string; sql: string }[])
      .map(row => `${row.tbl_name}:${/BEFORE (INSERT|UPDATE|DELETE)/.exec(row.sql)![1]}`));
    expect(tables.length).toBeGreaterThanOrEqual(10);
    for (const table of tables) for (const event of ["INSERT", "UPDATE", "DELETE"]) expect(guarded.has(`${table}:${event}`), `JOURNAL_GUARD_${table}_${event}`).toBe(true);
    ledger.write(() => turn(f.db, "odysseus", "Ithaca"));
    const before = ledger.usage();
    expect(() => turn(f.db, "athena", "Ithaca".repeat(2_000)), "JOURNAL_UNACCOUNTED_INSERT_REFUSED").toThrow("outside capacity accounting");
    expect(() => f.db.query("UPDATE turn_journal_turns SET summary=? WHERE turn_id='odysseus'").run("Ithaca".repeat(2_000)), "JOURNAL_UNACCOUNTED_UPDATE_REFUSED").toThrow("outside capacity accounting");
    expect(() => f.db.query("DELETE FROM turn_journal_turns").run(), "JOURNAL_UNACCOUNTED_DELETE_REFUSED").toThrow("outside capacity accounting");
    expect(() => f.db.transaction(() => f.db.query("INSERT INTO turn_journal_objects VALUES (?,6,'present')").run("b".repeat(64)))(), "JOURNAL_UNACCOUNTED_OBJECT_REFUSED").toThrow("outside capacity accounting");
    expect(f.db.query("SELECT turn_id,summary FROM turn_journal_turns").all()).toEqual([{ turn_id: "odysseus", summary: "Ithaca" }]);
    expect(f.db.query("SELECT writing FROM turn_journal_allocation WHERE id=1").get(), "JOURNAL_WRITING_FLAG_NEVER_COMMITTED").toEqual({ writing: 0 });
    expect(ledger.usage()).toBe(before);
  } finally { f.close(f.db); }
});

test("journal storage another connection wrote is charged at the next accounted write", () => {
  const f = fixture("other");
  const other = createUiDb(f.path);
  try {
    const ledger = createJournalAccounting(f.db, f.path);
    ledger.write(() => turn(f.db, "odysseus", "Ithaca"));
    const bounded = createJournalAccounting(f.db, f.path, { capBytes: ledger.usage() + 64 * 1024 });
    // A connection without a ledger has no guard; the full measurement still sees its pages.
    turn(other, "athena", "Ithaca".repeat(40_000));
    // Its WAL frames are gone after a checkpoint; only its commit having happened is left to notice.
    other.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    expect(() => bounded.write(() => {}), "JOURNAL_UNGUARDED_WRITER_STILL_CHARGED").toThrow(JournalCapacityError);
    expect(ledger.usage(), "JOURNAL_UNGUARDED_PAGES_IN_USAGE").toBeGreaterThan(240_000);
  } finally { f.close(other, f.db); }
});

test("WAL debt alone never refuses a write: it truncates and admits as before", () => {
  const f = fixture("debt");
  let checkpoints = 0;
  const ledger = createJournalAccounting(f.db, f.path, { afterCheckpoint() { checkpoints++; } });
  try {
    for (let index = 0; index < 20; index++) ledger.write(() => turn(f.db, `odysseus-${index}`, "Ithaca".repeat(300)));
    const debt = statSync(`${f.path}-wal`).size;
    expect(debt, "JOURNAL_COMMITS_ACCUMULATE_WAL").toBeGreaterThan(20 * 4_096);
    expect(reserved(f.db), "JOURNAL_WAL_DEBT_STAYS_RESERVED").toBeGreaterThanOrEqual(debt);
    const standing = ledger.usage();
    // A cap that admits the store and one commit, but not unbounded debt.
    const bounded = createJournalAccounting(f.db, f.path, { capBytes: standing, afterCheckpoint() { checkpoints++; } });
    const startup = checkpoints;
    for (let index = 0; index < 100; index++) bounded.write(() => f.db.query("UPDATE turn_journal_turns SET session_id=? WHERE turn_id=?").run(`penelope-${index}`, `odysseus-${index % 20}`));
    expect(checkpoints - startup, "JOURNAL_DEBT_TRUNCATES_ONLY_WHEN_IT_REFUSES").toBeGreaterThan(0);
    expect(checkpoints - startup, "JOURNAL_DEBT_TRUNCATION_IS_AMORTIZED").toBeLessThan(10);
    expect(bounded.usage(), "JOURNAL_DEBT_WITHIN_CAP").toBeLessThanOrEqual(standing);
    expect(reserved(f.db)).toBeGreaterThanOrEqual(statSync(`${f.path}-wal`).size);
  } finally { f.close(f.db); }
});

test("the charge never falls below formerly-owned journal pages still free, whoever reuses free pages", () => {
  const f = fixture("identity");
  const ledger = createJournalAccounting(f.db, f.path);
  const ever = new Set<number>();
  /** The page-identity truth from a full database walk, kept by the test only. */
  const truth = () => {
    const rows = f.db.query("SELECT pageno,name FROM dbstat").all() as { pageno: number; name: string }[];
    const names = new Set((f.db.query("SELECT name FROM sqlite_schema WHERE tbl_name GLOB 'turn_journal_*'").all() as { name: string }[]).map(row => row.name));
    const inTree = new Set(rows.map(row => row.pageno)), owned = rows.filter(row => names.has(row.name));
    for (const row of owned) ever.add(row.pageno);
    return owned.length + [...ever].filter(page => !inTree.has(page)).length;
  };
  // A no-op write records what the previous commit wrote; the oracle then reads the charged set.
  const charged = () => { ledger.write(() => {}); return (f.db.query("SELECT count(*) AS n FROM turn_journal_pages").get() as { n: number }).n; };
  const check = (label: string) => { expect(charged(), `JOURNAL_CHARGE_COVERS_RELEASED_PAGES_${label}`).toBeGreaterThanOrEqual(truth()); };
  try {
    f.db.exec("CREATE TABLE fixture_activity (value TEXT)");
    f.db.query("INSERT INTO fixture_activity VALUES (?)").run("Penelope".repeat(60_000));
    ledger.write(() => turn(f.db, "odysseus", "Ithaca".repeat(80_000))); check("GROWN");
    ledger.write(() => f.db.query("UPDATE turn_journal_turns SET summary='Journal detail expired' WHERE turn_id='odysseus'").run()); check("RELEASED");
    f.db.query("DELETE FROM fixture_activity").run(); check("OTHER_RELEASED");
    // The journal grows into free pages that may be the other component's.
    ledger.write(() => turn(f.db, "athena", "Ithaca".repeat(40_000))); check("JOURNAL_REUSED");
    // A journal write may not free another component's pages (governance expiry runs after it).
    f.db.query("INSERT INTO fixture_activity VALUES (?)").run("Telemachus".repeat(30_000));
    expect(() => ledger.write(() => { f.db.query("DELETE FROM fixture_activity").run(); turn(f.db, "telemachus", "Ithaca"); }), "JOURNAL_WRITE_CANNOT_FREE_FOREIGN_PAGES").toThrow("pages another component owns");
    f.db.query("DELETE FROM fixture_activity").run();
    ledger.write(() => turn(f.db, "telemachus", "Ithaca".repeat(30_000))); check("REUSED_FOREIGN_RELEASE");
    f.db.query("INSERT INTO fixture_activity VALUES (?)").run("Eumaeus".repeat(120_000));
    ledger.write(() => turn(f.db, "eumaeus", "Ithaca")); check("OTHER_REUSED");
  } finally { f.close(f.db); }
});

test("a store over its cap still constructs, so recovery can release abandoned reservations", () => {
  const db = createUiDb(":memory:");
  try {
    db.query("INSERT INTO turn_journal_reservations (id,bytes,pid,pid_start,created_at,hash,kind) VALUES (?,8192,2147483647,'',0,NULL,'temporary')").run(crypto.randomUUID());
    const ledger = createJournalAccounting(db, ":memory:", { capBytes: 4096 });
    const discarded: string[] = [];
    ledger.recover({ has() { throw Error("Temporary bytes name no object"); }, verify() { throw Error("Temporary bytes have no hash"); }, discardPending(id) { discarded.push(id); } });
    expect(discarded, "JOURNAL_OVER_CAP_STARTUP_RECOVERS").toHaveLength(1);
    expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

test("a large write onto a large WAL truncates first, so the store and the WAL it carries fit the cap", () => {
  const f = fixture("growth");
  let checkpoints = 0;
  const ledger = createJournalAccounting(f.db, f.path, { afterCheckpoint() { checkpoints++; } });
  try {
    ledger.write(() => turn(f.db, "odysseus", "Ithaca"));
    const cap = ledger.usage() + 600 * 1024, bounded = createJournalAccounting(f.db, f.path, { capBytes: cap, afterCheckpoint() { checkpoints++; } });
    for (let index = 0; index < 500 && statSync(`${f.path}-wal`).size < 400 * 1024; index++) bounded.write(() => f.db.query("UPDATE turn_journal_turns SET session_id=? WHERE turn_id='odysseus'").run(`penelope-${index}`));
    expect(statSync(`${f.path}-wal`).size, "JOURNAL_SMALL_WRITES_GROW_THE_WAL").toBeGreaterThanOrEqual(400 * 1024);
    const before = checkpoints;
    bounded.write(() => turn(f.db, "athena", "Ithaca".repeat(42_000)));
    expect(checkpoints - before, "JOURNAL_LARGE_WRITE_TRUNCATES_A_LARGE_WAL").toBe(1);
    expect(bounded.usage(), "JOURNAL_ADMITTED_WRITE_FITS_WITH_ITS_WAL").toBeLessThanOrEqual(cap);
  } finally { f.close(f.db); }
});

test("pages a write can take from the free list or the file's growth are charged before admission", () => {
  for (const source of ["free list", "file growth"]) {
    const f = fixture(source === "free list" ? "free" : "growth-cap");
    const ledger = createJournalAccounting(f.db, f.path);
    try {
      ledger.write(() => turn(f.db, "odysseus", "Ithaca"));
      if (source === "free list") {
        // Another component releases pages the journal then reuses: no file growth.
        f.db.exec("CREATE TABLE fixture_activity (value TEXT)");
        f.db.query("INSERT INTO fixture_activity VALUES (?)").run("Penelope".repeat(60_000));
        f.db.query("DELETE FROM fixture_activity").run();
      }
      f.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      const bounded = createJournalAccounting(f.db, f.path, { capBytes: ledger.usage() + 96 * 1024 });
      const pages = f.db.query("PRAGMA page_count").get();
      expect(() => bounded.write(() => turn(f.db, "athena", "Ithaca".repeat(40_000))), `JOURNAL_NEW_PAGES_FROM_${source.toUpperCase().replace(" ", "_")}_CHARGED`).toThrow(JournalCapacityError);
      if (source === "free list") expect(f.db.query("PRAGMA page_count").get(), "JOURNAL_FIXTURE_REUSES_FREE_PAGES").toEqual(pages);
    } finally { f.close(f.db); }
  }
});

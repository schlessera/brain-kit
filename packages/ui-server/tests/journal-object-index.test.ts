import { expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import * as journalStore from "../src/brain/journal-store.js";
import { createJournalAccounting } from "../src/brain/journal-accounting.js";
import { createJournalObjects } from "../src/brain/journal-objects.js";
import { journalDatabasePath } from "../src/db/journal-database.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const CANDIDATES = "SELECT hash,bytes FROM turn_journal_objects WHERE state='present' AND hash NOT IN (SELECT hash FROM turn_journal_object_refs) AND hash NOT IN (SELECT hash FROM turn_journal_reservations WHERE hash IS NOT NULL)";
const indexed = (db: Database) => Boolean(db.query("SELECT 1 FROM journal.sqlite_schema WHERE name='turn_journal_object_refs_hash' AND type='index'").get());
const size = (path: string) => existsSync(path) ? statSync(path).size : 0;
const extent = (path: string) => [size(journalDatabasePath(path)), size(`${journalDatabasePath(path)}-wal`)];
function plan(db: Database, sql: string, ...params: string[]) {
  const query = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  try { return query.all(...params); } finally { query.finalize(); }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "journal-index-cap-odysseus-")), path = join(root, "ui.db"), objects = join(root, "objects");
  const db = createUiDb(path);
  return { root, path, objects, db, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** The actual migrated journal schema, with separately pinned and collectible objects. */
function seed(db: Database, pins: number, freed: number) {
  db.transaction(() => {
    const object = db.query("INSERT INTO turn_journal_objects VALUES (?,0,'present')");
    for (let i = 0; i < 50; i++) object.run(sha(`Ithaca pin ${i}`));
    for (let i = 0; i < freed; i++) object.run(sha(`Ithaca unused ${i}`));
    const turn = db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,ended_at,state) VALUES (?,'interactive','governed',1,2,'complete')");
    const pin = db.query("INSERT INTO turn_journal_object_refs VALUES (?,?)");
    for (let i = 0; i < Math.ceil(pins / 50); i++) {
      const id = `voyage-${i}`; turn.run(id);
      for (let j = 0; j < Math.min(50, pins - i * 50); j++) pin.run(id, sha(`Ithaca pin ${j}`));
    }
  }).immediate();
}

test("ordinary collection uses indexed foreign-key checks, independently of pin count (#2913)", () => {
  const timings: { pins: number; candidates: number; collection: number }[] = [];
  for (const pins of [1_000, 100_000]) {
    const root = mkdtempSync(join(tmpdir(), "journal-object-index-odysseus-")), db = createUiDb(":memory:");
    let store: ReturnType<typeof journalStore.setup> | undefined;
    try {
      seed(db, pins, 2_000);
      store = journalStore.setup(db, { dbPath: ":memory:", objectsRoot: join(root, "objects") });
      const candidatePlan = plan(db, CANDIDATES);
      const deletePlan = plan(db, "DELETE FROM turn_journal_objects WHERE hash=?", sha("Ithaca unused 0"));
      const started = performance.now();
      expect(db.query(CANDIDATES).all()).toHaveLength(2_000);
      const selected = performance.now();
      store.collectObjects!();
      const collected = performance.now();
      const timing = { pins, candidates: selected - started, collection: collected - selected };
      timings.push(timing);
      console.log(JSON.stringify({ ...timing, candidatePlan, deletePlan }));
      expect(db.query("SELECT count(*) AS n FROM turn_journal_objects").get(), "COLLECTION_KEEPS_ALL_PINNED_OBJECTS").toEqual({ n: 50 });
      expect(db.query("SELECT count(*) AS n FROM turn_journal_object_refs").get(), "COLLECTION_KEEPS_ALL_PINS").toEqual({ n: pins });
      expect(db.query("PRAGMA foreign_keys").get(), "COLLECTION_FOREIGN_KEYS_ENABLED").toEqual({ foreign_keys: 1 });
      // Main takes several seconds for 2,000 * 100,000 child-key visits;
      // the indexed path takes tens of milliseconds, including the candidate scan.
      expect(timing.collection, "COLLECTION_NO_PER_OBJECT_PIN_SCAN").toBeLessThan(1_500);
      if (pins === 100_000) expect(JSON.stringify(deletePlan), "COLLECTION_FK_LOOKUP_USES_HASH_INDEX").toContain("turn_journal_object_refs_hash");
      expect(db.query("PRAGMA journal.foreign_key_check").all()).toEqual([]);
    } finally { store?.close?.(); db.close(); rmSync(root, { recursive: true, force: true }); }
  }
  // Candidate selection visits the pin set once. Increasing it 100-fold
  // must not multiply the 2,000 foreign-key checks by 100.
  expect(timings[1]!.collection, "COLLECTION_PIN_COUNT_DOES_NOT_MULTIPLY_DELETES").toBeLessThan(timings[0]!.collection * 12 + 300);
});

test("fresh and upgraded journals admit index pages and WAL before an atomic, idempotent build (#2913)", () => {
  for (const pins of [0, 10_000]) {
    const f = fixture();
    try {
      if (pins) seed(f.db, pins, 0);
      expect(indexed(f.db), "INDEX_NOT_INSTALLED_BY_UNACCOUNTED_SQL_MIGRATIONS").toBe(false);
      const ledger = createJournalAccounting(f.db, f.path);
      const before = ledger.usage(), physical = extent(f.path);
      let builds = 0;
      const exec = f.db.exec.bind(f.db);
      const observe = spyOn(f.db, "exec").mockImplementation(sql => {
        const result = exec(sql);
        if (sql.startsWith("CREATE INDEX journal.turn_journal_object_refs_hash")) {
          builds++;
          expect(f.db.inTransaction, "INDEX_BUILD_HOLDS_WRITE_TRANSACTION").toBe(true);
          expect(f.db.query("PRAGMA cache_spill").get(), "INDEX_BUILD_DOES_NOT_SPILL_PAGES").toEqual({ cache_spill: 0 });
          expect(f.db.query("PRAGMA temp_store").get(), "INDEX_BUILD_SORTS_IN_MEMORY").toEqual({ temp_store: 2 });
          expect(extent(f.path), "INDEX_BUILD_ALLOCATES_NO_DISK_BEFORE_FINAL_ADMISSION").toEqual(physical);
        }
        return result;
      });
      try {
        expect(ledger.ensureObjectRefIndex(), "INDEX_ADMITTED").toBe(true);
        expect(ledger.ensureObjectRefIndex(), "INDEX_RETRY_IDEMPOTENT").toBe(true);
        expect(builds, "INDEX_BUILT_ONCE").toBe(1);
      } finally { observe.mockRestore(); }
      expect(ledger.usage(), "INDEX_PAGES_AND_WAL_COUNT_IN_USAGE").toBeGreaterThan(before);
      const reserved = (f.db.query("SELECT wal_reserved FROM turn_journal_allocation WHERE id=1").get() as { wal_reserved: number }).wal_reserved;
      expect(reserved, "INDEX_FULL_COMMIT_WAL_RESERVED").toBeGreaterThanOrEqual(size(`${journalDatabasePath(f.path)}-wal`));
      expect(f.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      const restarted = createUiDb(f.path);
      try {
        const reopened = createJournalAccounting(restarted, f.path);
        expect(reopened.ensureObjectRefIndex(), "INDEX_RESTART_IDEMPOTENT").toBe(true);
        expect(indexed(restarted)).toBe(true);
        expect(restarted.query("PRAGMA journal.foreign_key_check").all()).toEqual([]);
      } finally { restarted.close(); }
    } finally { f.close(); }
  }
});

test("near-cap index refusal preserves slower expiry, which frees room for an automatic retry (#2913)", async () => {
  const f = fixture(), brain = join(f.root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  const native = createNativeJournalFixture(brain, f.root);
  let journal: ReturnType<typeof createTurnJournal> | undefined;
  try {
    seed(f.db, 1_000, 0);
    const now = Date.UTC(2026, 6, 12), old = now - 31 * 24 * 60 * 60 * 1_000;
    f.db.query("UPDATE turn_journal_turns SET started_at=?,ended_at=?").run(now - 1, now);
    const ledger = createJournalAccounting(f.db, f.path), objects = createJournalObjects(f.objects, ledger);
    let expired: string, reserved: string, read: string;
    try {
      expired = await objects.putBytes(Buffer.from("The voyage home.\n".repeat(65_536)));
      reserved = await objects.putBytes(Buffer.from("Penelope still reads this."));
      read = ledger.openRead(reserved);
      ledger.write(() => {
        f.db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,ended_at,state) VALUES ('old-voyage','interactive','governed',?,?,'complete')").run(old - 1, old);
        f.db.query("INSERT INTO turn_journal_object_refs VALUES ('old-voyage',?)").run(expired);
        f.db.query("UPDATE turn_journal_allocation SET index_purge=2 WHERE id=1").run();
      });
    } finally { objects.close(); }
    // Checkpoint existing debt first; leave only two pages beyond the store
    // and its standing WAL charge, much less than even an empty index allowance.
    const reconciled = createJournalAccounting(f.db, f.path), cap = reconciled.usage() + 8_192;
    const bounded = createJournalAccounting(f.db, f.path, { capBytes: cap }), physical = extent(f.path);
    let builds = 0;
    const exec = f.db.exec.bind(f.db), observe = spyOn(f.db, "exec").mockImplementation(sql => {
      if (sql.startsWith("CREATE INDEX journal.turn_journal_object_refs_hash")) builds++;
      return exec(sql);
    });
    try { expect(bounded.ensureObjectRefIndex(), "NEAR_CAP_INDEX_REFUSED").toBe(false); }
    finally { observe.mockRestore(); }
    expect(builds, "NEAR_CAP_INDEX_REFUSED_BEFORE_CREATION").toBe(0);
    expect(extent(f.path), "NEAR_CAP_REFUSAL_ALLOCATES_NO_PAGES_OR_WAL").toEqual(physical);
    expect(bounded.usage(), "NEAR_CAP_REFUSAL_WITHIN_CAP").toBeLessThanOrEqual(cap);
    expect(f.db.query("PRAGMA foreign_keys").get(), "REFUSED_INDEX_KEEPS_FOREIGN_KEYS").toEqual({ foreign_keys: 1 });
    journal = createTurnJournal(f.db, { nativeManager: native.manager, brainPath: brain, dbPath: f.path, objectsRoot: f.objects, capBytes: cap, now: () => now });
    await journal.ready;
    expect(indexed(f.db), "NEAR_CAP_RESTART_STILL_DEFERS_INDEX").toBe(false);
    // Real host expiry: begin drops only the old turn's pin and invokes
    // ordinary worker collection with FK enforcement. The newly freed object
    // bytes admit the index, before the new turn starts.
    await journal.begin("return", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
    expect(f.db.query("SELECT 1 FROM turn_journal_turns WHERE turn_id='old-voyage'").get(), "NEAR_CAP_EXPIRY_COMMITS_WITHOUT_INDEX").toBeNull();
    expect(existsSync(join(f.objects, expired!)), "NEAR_CAP_COLLECTION_FREES_EXPIRED_BYTES").toBe(false);
    expect(indexed(f.db), "COLLECTION_RETRIES_INDEX_AFTER_FREEING_CAPACITY").toBe(true);
    expect(existsSync(join(f.objects, reserved!)), "NEAR_CAP_EXPIRY_KEEPS_RESERVED_OBJECT").toBe(true);
    expect(f.db.query("SELECT count(*) AS n FROM turn_journal_object_refs").get(), "NEAR_CAP_EXPIRY_KEEPS_OTHER_PINS").toEqual({ n: 1_000 });
    expect(bounded.usage(), "NEAR_CAP_RETRY_WITHIN_CAP").toBeLessThanOrEqual(cap);
    expect(f.db.query("PRAGMA journal.foreign_key_check").all()).toEqual([]);
    await journal.finish("return");
    await journal.close(); journal = undefined;
    bounded.releaseRead(read!);
  } finally { await journal?.close(); await native.close(); f.close(); }
});

test("ordinary collection and its index preserve pinned, read-reserved and copy-reserved bytes (#2913)", async () => {
  const f = fixture(), ledger = createJournalAccounting(f.db, f.path), objects = createJournalObjects(f.objects, ledger);
  let store: ReturnType<typeof journalStore.setup> | undefined;
  try {
    const contents = ["Odysseus keeps the bow.", "Penelope reads the loom.", "Telemachus copies the map.", "The suitors left."];
    const hashes: string[] = [];
    for (const text of contents) hashes.push(await objects.putBytes(Buffer.from(text)));
    const [pinned, reading, copying, unused] = hashes as [string, string, string, string];
    ledger.write(() => {
      f.db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state) VALUES ('voyage','interactive','governed',1,'recording')").run();
      f.db.query("INSERT INTO turn_journal_object_refs VALUES ('voyage',?)").run(pinned);
    });
    const read = ledger.openRead(reading), copy = await ledger.reserve(Buffer.byteLength(contents[2]!), copying);
    store = journalStore.setup(f.db, { dbPath: f.path, objectsRoot: f.objects });
    let failure: unknown;
    try { store.collectObjects!(); } catch (error) { failure = error; }
    for (const [i, label] of ["PINNED", "READ_RESERVED", "COPY_RESERVED"].entries()) {
      expect(existsSync(join(f.objects, hashes[i]!)), `COLLECTION_${label}_BYTES_SURVIVE`).toBe(true);
      expect(readFileSync(join(f.objects, hashes[i]!)).toString(), `COLLECTION_${label}_BYTES_UNCHANGED`).toBe(contents[i]!);
    }
    expect(failure, "CORRECT_COLLECTION_COMMITS").toBeUndefined();
    expect(existsSync(join(f.objects, unused)), "COLLECTION_REMOVES_UNPINNED_UNRESERVED_OBJECT").toBe(false);
    expect(() => ledger.write(() => f.db.query("DELETE FROM turn_journal_objects WHERE hash=?").run(pinned)), "SQLITE_STILL_REFUSES_PINNED_OBJECT_DELETE").toThrow("FOREIGN KEY constraint failed");
    expect(f.db.query("PRAGMA foreign_keys").get(), "SUCCESSFUL_COLLECTION_KEEPS_FOREIGN_KEYS").toEqual({ foreign_keys: 1 });
    expect(f.db.query("PRAGMA journal.foreign_key_check").all()).toEqual([]);
    ledger.releaseRead(read); copy.cancel();
  } finally { store?.close?.(); objects.close(); f.close(); }
});

test("a failed or killed index build rolls back and restarts without losing pins or enforcement (#2913)", () => {
  for (const killed of [false, true]) {
    const f = fixture();
    let objects: ReturnType<typeof createJournalObjects> | undefined;
    try {
      seed(f.db, 1_000, 0);
      const ledger = createJournalAccounting(f.db, f.path);
      objects = createJournalObjects(f.objects, ledger);
      // Keep both an active reservation and a real pinned file through the
      // failed build, in addition to the large pin set.
      const content = Buffer.from("Odysseus keeps these bytes during the upgrade."), hash = sha(content.toString());
      const object = join(f.objects, hash);
      // This test is synchronous so the crash can happen immediately after
      // CREATE INDEX; seed the same admitted object/reservation rows directly.
      ledger.write(() => {
        f.db.query("INSERT INTO turn_journal_objects VALUES (?,?,'present')").run(hash, content.length);
        f.db.query("INSERT INTO turn_journal_object_refs VALUES ('voyage-0',?)").run(hash);
      });
      writeFileSync(object, content, { mode: 0o600 });
      ledger.reserve(content.length, hash);
      const before = f.db.query("SELECT * FROM turn_journal_object_refs ORDER BY turn_id,hash").all();
      const reservations = f.db.query("SELECT * FROM turn_journal_reservations ORDER BY id").all();
      if (killed) {
        const client = new URL("../src/db/client.ts", import.meta.url).pathname;
        const accounting = new URL("../src/brain/journal-accounting.ts", import.meta.url).pathname;
        const child = `import {createUiDb} from ${JSON.stringify(client)};import {createJournalAccounting} from ${JSON.stringify(accounting)};
          const db=createUiDb(process.argv[1]),ledger=createJournalAccounting(db,process.argv[1]),exec=db.exec.bind(db);
          db.exec=sql=>{const result=exec(sql);if(sql.startsWith("CREATE INDEX journal.turn_journal_object_refs_hash"))process.kill(process.pid,"SIGKILL");return result;};
          ledger.ensureObjectRefIndex();process.exit(9);`;
        const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", child, f.path], { stdout: "pipe", stderr: "pipe" });
        expect(result.signalCode, result.stderr.toString()).toBe("SIGKILL");
      } else {
        const exec = f.db.exec.bind(f.db);
        const interrupt = spyOn(f.db, "exec").mockImplementation(sql => {
          const result = exec(sql);
          if (sql.startsWith("CREATE INDEX journal.turn_journal_object_refs_hash")) throw Error("interrupted reference index build");
          return result;
        });
        try { expect(() => ledger.ensureObjectRefIndex(), "FAILED_INDEX_BUILD_REPORTED").toThrow("interrupted reference index build"); }
        finally { interrupt.mockRestore(); }
      }
      expect(indexed(f.db), "INTERRUPTED_INDEX_NOT_RECORDED").toBe(false);
      expect(f.db.query("PRAGMA foreign_keys").get(), "FAILED_INDEX_KEEPS_FOREIGN_KEYS").toEqual({ foreign_keys: 1 });
      expect(readFileSync(object), "INTERRUPTED_INDEX_KEEPS_PINNED_RESERVED_BYTES").toEqual(content);
      const restarted = createUiDb(f.path);
      try {
        expect(restarted.query("SELECT * FROM turn_journal_object_refs ORDER BY turn_id,hash").all(), "INTERRUPTED_INDEX_KEEPS_EVERY_PIN").toEqual(before);
        expect(restarted.query("SELECT * FROM turn_journal_reservations ORDER BY id").all(), "INTERRUPTED_INDEX_KEEPS_EVERY_RESERVATION").toEqual(reservations);
        expect(createJournalAccounting(restarted, f.path).ensureObjectRefIndex(), "INTERRUPTED_INDEX_RESTART_RETRIES").toBe(true);
        expect(restarted.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
        expect(restarted.query("PRAGMA journal.foreign_key_check").all()).toEqual([]);
      } finally { restarted.close(); }
    } finally { objects?.close(); f.close(); }
  }
});

test("index setup never discards existing TEMP state to change sorter storage (#2913)", () => {
  const f = fixture();
  try {
    f.db.exec("PRAGMA temp_store=FILE; CREATE TEMP TABLE loom (note TEXT); INSERT INTO loom VALUES ('Penelope')");
    const ledger = createJournalAccounting(f.db, f.path);
    expect(ledger.ensureObjectRefIndex(), "UNSAFE_TEMP_STORE_CHANGE_DEFERRED").toBe(false);
    expect(f.db.query("SELECT note FROM temp.loom").all(), "CALLER_TEMP_STATE_PRESERVED").toEqual([{ note: "Penelope" }]);
    expect(() => f.db.query("INSERT INTO turn_journal_objects VALUES (?,0,'present')").run(sha("bow")), "DEFERRED_INDEX_KEEPS_ACCOUNTING_GUARDS").toThrow("outside capacity accounting");
    expect(f.db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  } finally { f.close(); }
});

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createJournalAccounting, JournalStorageUnavailable } from "../src/brain/journal-accounting.js";
import { createJournalObjects, JournalCapacityError } from "../src/brain/journal-objects.js";

test("the aggregate cap charges actual SQLite journal pages, WAL capacity and in-flight bytes before admission", () => {
  const root = mkdtempSync(join(tmpdir(), "journal-ledger-odysseus-")), path = join(root, "ui.db");
  const db = createUiDb(path), ledger = createJournalAccounting(db, path, { capBytes: 1024 * 1024 });
  try {
    ledger.write(() => db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state,summary) VALUES ('odysseus','interactive','governed',0,'complete',?)").run("Ithaca".repeat(20_000)));
    expect(ledger.usage(), "JOURNAL_SQLITE_PHYSICAL_METADATA_CHARGED").toBeGreaterThan(120_000);
    expect(() => ledger.reserve(1024 * 1024, "a".repeat(64)), "JOURNAL_CAP_REFUSES_BEFORE_INFLIGHT_WRITE").toThrow(JournalCapacityError);
    expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations").get()).toEqual({ n: 0 });
    expect(ledger.usage()).toBeLessThanOrEqual(1024 * 1024);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a real Activity writer winning between checkpoint and BEGIN is detected before the journal operation and retried", () => {
  const root = mkdtempSync(join(tmpdir(), "journal-race-odysseus-")), path = join(root, "ui.db");
  const db = createUiDb(path), other = createUiDb(path);
  db.exec("CREATE TABLE fixture_activity (value TEXT)");
  let checkpointed = 0, changed = 0;
  const ledger = createJournalAccounting(db, path, { afterCheckpoint() {
    if (checkpointed++ === 0) other.query("INSERT INTO fixture_activity VALUES (?)").run("Athena observed the plan.");
  } });
  try {
    ledger.write(() => { changed++; db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state) VALUES ('odysseus','interactive','governed',0,'active')").run(); });
    expect(checkpointed, "JOURNAL_CHECKPOINT_BEGIN_RACE_RETRIED").toBe(2);
    expect(changed, "JOURNAL_RACE_MUTATION_RUNS_ONCE").toBe(1);
    expect(other.query("SELECT value FROM fixture_activity").all()).toEqual([{ value: "Athena observed the plan." }]);
  } finally { other.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("reader-pinned WAL refuses a journal mutation with a named unavailable outcome", () => {
  const root = mkdtempSync(join(tmpdir(), "journal-reader-odysseus-")), path = join(root, "ui.db");
  const db = createUiDb(path), reader = createUiDb(path);
  db.exec("PRAGMA busy_timeout=10;CREATE TABLE fixture_activity (value TEXT)");
  db.query("INSERT INTO fixture_activity VALUES (?)").run("Ithaca");
  db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  reader.exec("BEGIN"); reader.query("SELECT * FROM fixture_activity").all();
  db.query("INSERT INTO fixture_activity VALUES (?)").run("Athena");
  let changed = false;
  const ledger = createJournalAccounting(db, path);
  try {
    expect(() => ledger.write(() => { changed = true; }), "JOURNAL_READER_PIN_REFUSES_BEFORE_MUTATION").toThrow(JournalStorageUnavailable);
    expect(changed).toBe(false);
    expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations").get()).toEqual({ n: 0 });
  } finally { reader.exec("ROLLBACK"); reader.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const secureDelete of [0, 1]) test(`physical page and WAL accounting covers deletion with secure_delete=${secureDelete}`, () => {
  const root = mkdtempSync(join(tmpdir(), "journal-pages-odysseus-")), path = join(root, "ui.db");
  const db = createUiDb(path), ledger = createJournalAccounting(db, path);
  db.exec(`PRAGMA secure_delete=${secureDelete}`);
  try {
    ledger.write(() => db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state,summary) VALUES ('odysseus','interactive','governed',0,'complete',?)").run("Ithaca".repeat(50_000)));
    const before = ledger.usage();
    ledger.write(() => db.query("UPDATE turn_journal_turns SET summary='Journal detail expired' WHERE turn_id='odysseus'").run());
    const allocation = db.query("SELECT wal_reserved FROM turn_journal_allocation WHERE id=1").get() as { wal_reserved: number };
    expect(allocation.wal_reserved, "JOURNAL_WAL_COMMIT_WITHIN_RESERVED_BYTES").toBeGreaterThanOrEqual(statSync(path + "-wal").size);
    expect(ledger.usage(), "JOURNAL_FREED_METADATA_PAGES_REMAIN_CHARGED").toBeGreaterThanOrEqual(before - 2 * 4096);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("already charged free journal pages can hold new metadata without a second reservation for the same pages", () => {
  const root = mkdtempSync(join(tmpdir(), "journal-reuse-odysseus-")), path = join(root, "ui.db");
  const db = createUiDb(path), ledger = createJournalAccounting(db, path);
  try {
    ledger.write(() => db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state,summary) VALUES ('odysseus','interactive','governed',0,'complete',?)").run("Ithaca".repeat(50_000)));
    ledger.write(() => db.query("UPDATE turn_journal_turns SET summary='Journal detail expired' WHERE turn_id='odysseus'").run());
    const charged = ledger.usage(), bounded = createJournalAccounting(db, path, { capBytes: charged });
    bounded.write(() => db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state,summary) VALUES ('athena','interactive','governed',1,'active',?)").run("Ithaca".repeat(50_000)));
    expect(bounded.usage(), "JOURNAL_REUSES_CHARGED_FREE_PAGES").toBeLessThanOrEqual(charged);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an external SQLite vacuum relocates ownership without charging pages beyond the physical database extent", () => {
  const root = mkdtempSync(join(tmpdir(), "journal-vacuum-odysseus-")), path = join(root, "ui.db");
  const db = createUiDb(path), ledger = createJournalAccounting(db, path);
  try {
    ledger.write(() => db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state,summary) VALUES ('odysseus','interactive','governed',0,'complete',?)").run("Ithaca".repeat(50_000)));
    ledger.write(() => db.query("UPDATE turn_journal_turns SET summary='Journal detail expired' WHERE turn_id='odysseus'").run());
    const before = ledger.usage();
    // Fixture-owned operator action only: the implementation does not run VACUUM.
    db.exec("VACUUM"); db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
    const reopened = createJournalAccounting(db, path);
    expect(reopened.usage(), "JOURNAL_VACUUM_DROPS_NONEXISTENT_PAGE_DEBT").toBeLessThan(before / 2);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an actual writer crash after object publication keeps bytes charged and recovery preserves the valid object", () => {
  const root = mkdtempSync(join(tmpdir(), "journal-crash-odysseus-")), path = join(root, "ui.db");
  const db = createUiDb(path);
  const modules = ["../src/db/client.ts", "../src/brain/journal-accounting.ts", "../src/brain/journal-objects.ts"].map(path => new URL(path, import.meta.url).pathname);
  const child = `
    import {createUiDb} from ${JSON.stringify(modules[0])};
    import {createJournalAccounting} from ${JSON.stringify(modules[1])};
    import {createJournalObjects} from ${JSON.stringify(modules[2])};
    import {openSync,writeFileSync} from "node:fs";
    const root=process.argv[1],db=createUiDb(root+"/ui.db"),ledger=createJournalAccounting(db,root+"/ui.db");
    const objects=createJournalObjects(root+"/objects",{reserve(bytes,hash){const real=ledger.reserve(bytes,hash);return {...real,finish(){throw new Error("Fixture interruption after publication")}}}});
    writeFileSync(root+"/source","Ithaca");
    try{objects.putFile(openSync(root+"/source","r"),6)}catch(error){if(!String(error).includes("Fixture interruption"))throw error}
    writeFileSync(root+"/committed","yes");
    process.kill(process.pid,"SIGKILL");
  `;
  let objects: ReturnType<typeof createJournalObjects> | undefined;
  try {
    const crashed = Bun.spawnSync([process.execPath, "--no-env-file", "-e", child, root], { cwd: root, env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    expect(crashed.exitCode, crashed.stderr.toString()).toBeNull();
    expect(crashed.signalCode).toBe("SIGKILL");
    expect(readFileSync(join(root, "committed"), "utf8")).toBe("yes");
    const pending = db.query("SELECT hash,bytes FROM turn_journal_reservations").get() as { hash: string; bytes: number };
    expect(pending.bytes, "JOURNAL_CRASH_RETAINS_INFLIGHT_CHARGE").toBe(6);
    const ledger = createJournalAccounting(db, path);
    objects = createJournalObjects(join(root, "objects"), ledger);
    expect(objects.read(pending.hash, 6)).toEqual(Buffer.from("Ithaca"));
    const before = ledger.usage(); ledger.recover(objects);
    expect(db.query("SELECT count(*) AS n FROM turn_journal_reservations").get()).toEqual({ n: 0 });
    expect(db.query("SELECT bytes,state FROM turn_journal_objects WHERE hash=?").get(pending.hash)).toEqual({ bytes: 6, state: "present" });
    expect(ledger.usage()).toBeLessThanOrEqual(before);
    expect(objects.read(pending.hash, 6), "JOURNAL_RECOVERY_PRESERVES_PUBLISHED_BYTES").toEqual(Buffer.from("Ithaca"));
  } finally { objects?.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

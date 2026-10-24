import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { JOURNAL_SPLIT_MIGRATION, journalDatabasePath, moveJournalTables } from "../src/db/journal-database.js";
import { createJournalAccounting } from "../src/brain/journal-accounting.js";
import { replaySteeringEvents } from "../src/brain/journal-governance.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { exportInboxSnapshot, restoreInboxSnapshot, writeInboxSnapshot } from "../src/inbox/snapshot.js";

function fixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), `journal-database-${prefix}-odysseus-`)), path = join(root, "ui.db");
  return { root, path, close(...dbs: Database[]) { for (const db of dbs) db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const journalTables = (db: Database, schema: string) => (db.query(`SELECT name FROM ${schema}.sqlite_schema WHERE type='table' AND name GLOB 'turn_journal_*' ORDER BY name`).all() as { name: string }[]).map(row => row.name);
// The receipts of later journal migrations exist only in the journal file.
const counts = (db: Database, schema: string) => Object.fromEntries(journalTables(db, schema).filter(name => name !== "turn_journal_migrations").map(name => [name, (db.query(`SELECT count(*) AS n FROM ${schema}."${name}"`).get() as { n: number }).n]));

/**
 * A database as releases before #2789 left it: the shipped migrations applied
 * the way their runner did, with no journal file, so every journal table is
 * in the UI database. Rows reference each other (a cascading child included)
 * and one journal table carries a persistent trigger.
 */
function legacyDatabase(path: string) {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL)");
  const migrations = join(import.meta.dir, "../migrations");
  for (const file of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
    if (file.slice(0, 3) > JOURNAL_SPLIT_MIGRATION) break;
    db.transaction(() => { db.exec(readFileSync(join(migrations, file), "utf8")); db.query("INSERT INTO _migrations (filename, applied_at) VALUES (?, 0)").run(file); })();
  }
  db.transaction(() => {
    db.query("INSERT INTO turn_journal_turns (turn_id,session_id,actor,profile,started_at,ended_at,state,summary) VALUES ('voyage','ithaca','interactive','governed',1,2,'complete',?)").run("Ithaca".repeat(4_000));
    db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json,class,actor,overlaps) VALUES ('voyage',1,'notes/steering.md','brain',NULL,?,'steering','agent','[]')").run(JSON.stringify({ kind: "file", hash: "a".repeat(64), bytes: 6 }));
    db.query("INSERT INTO turn_journal_objects VALUES (?,6,'present')").run("a".repeat(64));
    db.query("INSERT INTO turn_journal_object_refs VALUES ('voyage',?)").run("a".repeat(64));
    db.query("INSERT INTO turn_journal_claude_memory VALUES ('voyage','memory/athena.md','/claude','1','2','athena.md',NULL,NULL,'saved')").run();
  })();
  db.exec("CREATE TRIGGER fixture_keep_turns BEFORE DELETE ON turn_journal_turns WHEN OLD.turn_id = 'voyage' BEGIN SELECT RAISE(ABORT, 'fixture keeps the voyage'); END");
  const before = counts(db, "main");
  db.close();
  return before;
}

test("a database from before the journal file moves every journal table, row and index into it", () => {
  const f = fixture("move");
  const before = legacyDatabase(f.path);
  expect(Object.values(before).reduce((total, n) => total + n, 0)).toBeGreaterThan(4);
  const db = createUiDb(f.path);
  try {
    expect(journalTables(db, "main"), "JOURNAL_MOVE_LEAVES_NO_TABLE_IN_UI_DATABASE").toEqual([]);
    expect(counts(db, "journal"), "JOURNAL_MOVE_KEEPS_EVERY_ROW").toEqual(before);
    expect(db.query("SELECT count(*) AS n FROM journal.sqlite_schema WHERE type='index' AND name='turn_journal_session'").get(), "JOURNAL_MOVE_KEEPS_INDEXES").toEqual({ n: 1 });
    expect(db.query("PRAGMA journal.foreign_key_check").all(), "JOURNAL_MOVE_KEEPS_REFERENCES").toEqual([]);
    expect(db.query("SELECT name FROM journal.sqlite_schema WHERE type='trigger'").all(), "JOURNAL_MOVE_KEEPS_TRIGGERS").toEqual([{ name: "fixture_keep_turns" }]);
    expect(() => db.query("DELETE FROM turn_journal_turns WHERE turn_id='voyage'").run(), "JOURNAL_MOVED_TRIGGER_STILL_GUARDS").toThrow("fixture keeps the voyage");
    // Unqualified journal SQL, as every caller writes it, reaches the moved rows.
    expect(db.query("SELECT summary FROM turn_journal_turns WHERE turn_id='voyage'").get()).toEqual({ summary: "Ithaca".repeat(4_000) });
    expect(db.query("PRAGMA journal.auto_vacuum").get(), "JOURNAL_FILE_RETURNS_RELEASED_PAGES").toEqual({ auto_vacuum: 2 });
    expect(statSync(journalDatabasePath(f.path)).mode & 0o777).toBe(statSync(f.path).mode & 0o777);
  } finally { f.close(db); }
});

test("a move interrupted after copying is copied again, never duplicated, before the UI tables drop", () => {
  const f = fixture("crash");
  const before = legacyDatabase(f.path);
  // The copy committed in the journal file; the crash came before the drop.
  const half = new Database(f.path);
  half.query("ATTACH DATABASE ? AS journal").run(journalDatabasePath(f.path));
  const definitions = half.query("SELECT type, name, sql FROM main.sqlite_schema WHERE tbl_name GLOB 'turn_journal_*' AND sql IS NOT NULL ORDER BY rowid").all() as { type: string; name: string; sql: string }[];
  const into = (sql: string) => sql.replace(/^CREATE (TABLE|(?:UNIQUE )?INDEX|TRIGGER)\s+("[^"]+"|\w+)/i, "CREATE $1 journal.$2");
  for (const row of definitions) if (row.type === "table") { half.exec(into(row.sql)); half.exec(`INSERT INTO journal."${row.name}" SELECT * FROM main."${row.name}"`); }
  // The copied trigger refuses deleting a copied row: a rerun must not run it.
  for (const row of definitions) if (row.type !== "table") half.exec(into(row.sql));
  half.close();
  const db = createUiDb(f.path);
  try {
    expect(journalTables(db, "main"), "JOURNAL_RERUN_DROPS_UI_COPIES").toEqual([]);
    expect(counts(db, "journal"), "JOURNAL_RERUN_COPIES_EACH_ROW_ONCE").toEqual(before);
  } finally { f.close(db); }
});

test("a journal table a later migration creates in the UI database moves on the next start", () => {
  const f = fixture("later");
  let db = createUiDb(f.path);
  db.exec("CREATE TABLE turn_journal_fixture_voyages (id TEXT PRIMARY KEY, port TEXT); INSERT INTO turn_journal_fixture_voyages VALUES ('one','Ithaca')");
  expect(moveJournalTables(db), "JOURNAL_MOVE_REPORTS_TABLES").toBe(1);
  db.close();
  db = createUiDb(f.path);
  try {
    expect(journalTables(db, "main")).toEqual([]);
    expect(db.query("SELECT port FROM journal.turn_journal_fixture_voyages").all()).toEqual([{ port: "Ithaca" }]);
    expect(existsSync(`${f.path}.journal.db`)).toBe(true);
  } finally { f.close(db); }
});

test("a steering change whose governance event did not commit gets it back once, from the journal row", () => {
  const f = fixture("replay");
  const db = createUiDb(f.path), ledger = createJournalAccounting(db, f.path);
  try {
    db.query("INSERT INTO sessions (id,title,created_at,last_active_at) VALUES ('ithaca','Homeward',1,1)").run();
    ledger.write(() => {
      db.query("INSERT INTO turn_journal_turns (turn_id,session_id,actor,model,profile,started_at,ended_at,state) VALUES ('voyage','ithaca','interactive','odysseus-model','governed',1,9,'complete')").run();
      db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json,class,actor,overlaps,taint_source_event_id) VALUES ('voyage',3,'notes/steering.md','brain',?,?,'steering','agent','[\"athena\"]',NULL)")
        .run(JSON.stringify({ kind: "file", hash: "b".repeat(64), bytes: 4 }), JSON.stringify({ kind: "file", hash: "c".repeat(64), bytes: 5 }));
      db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json,class,actor,overlaps) VALUES ('voyage',4,'notes/content.md','brain',NULL,NULL,'content','agent','[]')").run();
    });
    expect(replaySteeringEvents(db), "JOURNAL_STEERING_EVENT_REPLAYED").toBe(1);
    expect(replaySteeringEvents(db), "JOURNAL_STEERING_REPLAY_IDEMPOTENT").toBe(0);
    const events = db.query("SELECT session_id, turn_id, actor, model, profile, at, dedupe_key, payload FROM governance_events WHERE kind='steering_change'").all() as Record<string, unknown>[];
    expect(events.map(event => ({ ...event, payload: JSON.parse(event.payload as string) as unknown }) as Record<string, unknown>)).toEqual([{ session_id: "ithaca", turn_id: "voyage", actor: "interactive", model: "odysseus-model", profile: "governed", at: 9, dedupe_key: "voyage:3",
      payload: { path: "notes/steering.md", sequence: 3, beforeHash: "b".repeat(64), afterHash: "c".repeat(64), taintSourceEventId: null, overlappingTurnIds: ["athena"] } }]);
  } finally { f.close(db); }
});

test("journal commits run at synchronous=FULL on the journal file, whatever the connection was set to", () => {
  const f = fixture("full");
  const db = createUiDb(f.path), ledger = createJournalAccounting(db, f.path);
  try {
    db.exec("PRAGMA journal.synchronous = NORMAL");
    let during = -1;
    ledger.write(() => { during = (db.query("PRAGMA journal.synchronous").get() as { synchronous: number }).synchronous; });
    expect(during, "JOURNAL_COMMIT_FULL_ON_JOURNAL_FILE").toBe(2);
    expect(db.query("PRAGMA journal.synchronous").get(), "JOURNAL_LEVEL_RESTORED").toEqual({ synchronous: 1 });
  } finally { f.close(db); }
});

test("a ledger on a connection that never ran createUiDb attaches the journal file itself", () => {
  const f = fixture("bare");
  createUiDb(f.path).close();
  // A write worker opens its own connection to the UI database file.
  const bare = new Database(f.path);
  try {
    bare.exec("PRAGMA journal_mode = WAL");
    const ledger = createJournalAccounting(bare, f.path);
    ledger.write(() => {
      bare.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state) VALUES ('athena','interactive','governed',0,'active')").run();
      bare.query("INSERT INTO turn_journal_claude_memory VALUES ('athena','memory/counsel.md','/claude','1','2','counsel.md',NULL,NULL,'saved')").run();
    });
    expect(bare.query("SELECT turn_id FROM journal.turn_journal_turns").all(), "JOURNAL_LEDGER_ATTACHES_ITS_FILE").toEqual([{ turn_id: "athena" }]);
    ledger.write(() => bare.query("DELETE FROM turn_journal_turns WHERE turn_id='athena'").run());
    expect(bare.query("SELECT count(*) AS n FROM turn_journal_claude_memory").get(), "JOURNAL_LEDGER_ENFORCES_REFERENCES").toEqual({ n: 0 });
  } finally { f.close(bare); }
});

test("the turn journal replays a missing steering event when it starts", async () => {
  const f = fixture("startup");
  const brain = join(f.root, "brain"); mkdirSync(brain);
  const db = createUiDb(f.path), ledger = createJournalAccounting(db, f.path);
  ledger.write(() => {
    db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,ended_at,state) VALUES ('voyage','interactive','governed',1,2,'complete')").run();
    db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json,class,actor,overlaps) VALUES ('voyage',1,'notes/steering.md','brain',NULL,NULL,'steering','agent','[]')").run();
  });
  const native = createNativeJournalFixture(brain, f.root);
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: f.path, objectsRoot: join(f.root, "objects") });
  try {
    expect(db.query("SELECT dedupe_key FROM governance_events WHERE kind='steering_change'").all(), "JOURNAL_STARTUP_REPLAYS_STEERING").toEqual([{ dedupe_key: "voyage:1" }]);
  } finally { await journal.close(); await native.close(); f.close(db); }
});

test("the operational backup carries the journal file, from the app or the recovery command, and a restore moves it back", async () => {
  const f = fixture("backup");
  const source = join(f.root, "source"), target = join(f.root, "target"); mkdirSync(source); mkdirSync(target);
  const path = join(source, "ui.sqlite"), db = createUiDb(path), ledger = createJournalAccounting(db, path);
  ledger.write(() => db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state,summary) VALUES ('voyage','interactive','governed',1,'complete','Ithaca')").run());
  const at = Date.now();
  const snapshot = await exportInboxSnapshot(db, source, at);
  // The recovery command opens the UI file directly and read-only.
  const command = new Database(path, { readonly: true });
  try {
    expect(await exportInboxSnapshot(command, source, at), "JOURNAL_BACKUP_SAME_FROM_RECOVERY_COMMAND").toEqual(snapshot);
    const image = Database.deserialize(Buffer.from(snapshot.database.data, "base64"));
    try { expect(image.query("SELECT turn_id, summary FROM turn_journal_turns").all(), "JOURNAL_BACKUP_CARRIES_JOURNAL").toEqual([{ turn_id: "voyage", summary: "Ithaca" }]); }
    finally { image.close(); }
    expect(await restoreInboxSnapshot(snapshot, join(target, "ui.sqlite"), target, at + 1)).toMatchObject({ resumed: false });
    const restored = createUiDb(join(target, "ui.sqlite"));
    try {
      expect(journalTables(restored, "main")).toEqual([]);
      expect(restored.query("SELECT turn_id, summary FROM journal.turn_journal_turns").all(), "JOURNAL_RESTORE_MOVES_JOURNAL_BACK").toEqual([{ turn_id: "voyage", summary: "Ithaca" }]);
    } finally { restored.close(); }
  } finally { command.close(); f.close(db); }
});

test("migrations after the split keep the journal file and the UI database apart", () => {
  const migrations = join(import.meta.dir, "../migrations");
  for (const file of readdirSync(migrations).filter(name => name.endsWith(".sql") && name.slice(0, 3) > JOURNAL_SPLIT_MIGRATION)) {
    const sql = readFileSync(join(migrations, file), "utf8");
    const named = [...sql.matchAll(/\b(?:TABLE|INTO|UPDATE|FROM|ON|INDEX|TRIGGER|REFERENCES)\s+(?:IF (?:NOT )?EXISTS\s+)?(?:\w+\.)?"?(\w+)"?/gi)].map(match => match[1]!);
    // A journal migration commits with its receipt only if it touches the journal file alone:
    // journal names only, and every object it creates created as journal.<name>.
    if (file.endsWith(".journal.sql")) {
      expect(named.filter(name => !name.startsWith("turn_journal_")), `JOURNAL_MIGRATION_TOUCHES_ONLY_JOURNAL_${file}`).toEqual([]);
      expect([...sql.matchAll(/\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF NOT EXISTS\s+)?(?!journal\.)("?\w+"?)/gi)].map(match => match[1]), `JOURNAL_MIGRATION_CREATES_IN_JOURNAL_FILE_${file}`).toEqual([]);
    } else expect(named.filter(name => name.startsWith("turn_journal_")), `UI_MIGRATION_TOUCHES_NO_JOURNAL_${file}`).toEqual([]);
  }
});

test("every alias of DB_PATH names the one journal file beside the physical database", () => {
  const f = fixture("alias");
  const state = join(f.root, "state"), link = join(f.root, "linked.db"); mkdirSync(state);
  const physical = join(state, "ui.db");
  createUiDb(physical).close();
  symlinkSync(physical, link);
  const db = createUiDb(link);
  try {
    expect(journalDatabasePath(link), "JOURNAL_ALIAS_SAME_FILE").toBe(journalDatabasePath(physical));
    expect(db.query("SELECT file FROM pragma_database_list WHERE name = 'journal'").get(), "JOURNAL_BESIDE_PHYSICAL_DATABASE").toEqual({ file: `${realpathSync(physical)}.journal.db` });
    expect(existsSync(`${link}.journal.db`)).toBe(false);
  } finally { f.close(db); }
});

test("an export never overwrites the journal file, even through a link to it", async () => {
  const f = fixture("destination");
  const state = join(f.root, "state"), history = join(f.root, "history"); mkdirSync(state); mkdirSync(history);
  const path = join(state, "ui.sqlite"), physical = join(history, "live.db");
  const first = createUiDb(path);
  first.query("PRAGMA wal_checkpoint(TRUNCATE)").get(); first.close();
  // The journal file is a link into another directory.
  for (const suffix of ["-wal", "-shm"]) rmSync(journalDatabasePath(path) + suffix, { force: true });
  renameSync(journalDatabasePath(path), physical); symlinkSync(physical, journalDatabasePath(path));
  const db = createUiDb(path);
  try {
    for (const target of [journalDatabasePath(path), physical, `${physical}-wal`])
      await expect(writeInboxSnapshot(db, state, target), `JOURNAL_EXPORT_REFUSES_${target === physical ? "PHYSICAL" : target.endsWith("-wal") ? "PHYSICAL_WAL" : "LINK"}`).rejects.toThrow("inbox_snapshot_destination");
  } finally { f.close(db); }
});

test("a ledger refuses to start inside a transaction, where it could not enforce references", () => {
  const f = fixture("transaction");
  const db = createUiDb(f.path);
  try {
    expect(() => db.transaction(() => createJournalAccounting(db, f.path))(), "JOURNAL_LEDGER_REFUSES_INSIDE_TRANSACTION").toThrow("cannot start inside another transaction");
  } finally { f.close(db); }
});

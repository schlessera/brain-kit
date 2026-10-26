/**
 * The one-time purge of index-family bytes retained before #2873 (#2903): at
 * journal open, every recorded index-family version becomes the metadata-only
 * entry history already presented, the objects only those versions held are
 * removed and their bytes leave the journal's accounting. An object any other
 * path records, a pin of a turn still recording and every authoritative
 * version are left alone. Each step is one commit, so a crash at any point
 * resumes at the next open, and a second open changes nothing.
 */
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import * as journalStore from "../src/brain/journal-store.js";
import { SELF } from "../src/brain/writer-gate.js";

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const COPY = ".brain-index/.maintenance-41b2dd7f-9913-4151-b5bf-53aad064cd96";
/** Content an earlier release retained for an index-family path, keyed by the note it is first written to. */
const LEGACY = {
  "notes/stage-db.md": [".brain-index/brain.db", "index pages after the Cyclops refresh"],
  "notes/stage-wal.md": [".brain-index/brain.db-wal", "index wal frames from Aeolus"],
  "notes/stage-lock.md": [".brain-index/brain.db.embedding-lock.db", "embedding lock held by Circe"],
  "notes/stage-copy.md": [COPY, "a staged index copy for Scylla"],
} as const;
/** An index version whose bytes another path also records: the object is authoritative content too. */
const SHARED = "the same bytes Penelope wove";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "journal-purge-odysseus-")), brain = join(root, "brain"), path = join(root, "ui.db"), objects = join(root, "objects");
  for (const directory of ["notes", ".brain-index"]) mkdirSync(join(brain, directory), { recursive: true });
  writeFileSync(join(brain, "notes/odysseus.md"), "# Ithaca\n");
  const native = createNativeJournalFixture(brain, root);
  let open: { db: Database; journal: ReturnType<typeof createTurnJournal> } | undefined;
  const f = {
    root, brain, path, objects,
    get db() { return open!.db; },
    get journal() { return open!.journal; },
    /** A journal opening this database, as a server start does; its open runs the purge. */
    async open() {
      const db = createUiDb(path);
      open = { db, journal: createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: objects }) };
      await open.journal.ready;
      return open;
    },
    async shut() { if (!open) return; await open.journal.close(); open.db.close(); open = undefined; },
    /** A plain connection with no journal ledger on it, standing in for an earlier release's rows. */
    raw<T>(operation: (db: Database) => T): T { const db = createUiDb(path); try { return operation(db); } finally { db.close(); } },
    write: (file: string, bytes: string) => writeFileSync(join(brain, file), bytes),
    begin: (id: string) => open!.journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; }),
    files: () => existsSync(objects) ? new Set(readdirSync(objects)) : new Set<string>(),
    async close() { await f.shut(); await native.close(); rmSync(root, { recursive: true, force: true }); },
  };
  return f;
}
type Fixture = ReturnType<typeof fixture>;

/** Everything the purge could touch, as stored. */
function dump(db: Database) {
  return {
    changes: db.query("SELECT turn_id,sequence,path,before_json,after_json FROM turn_journal_changes ORDER BY turn_id,sequence,path").all(),
    revertPaths: db.query("SELECT operation_id,path,before_json,after_json FROM turn_journal_revert_paths ORDER BY operation_id,path").all(),
    pins: db.query("SELECT turn_id,hash FROM turn_journal_object_refs ORDER BY turn_id,hash").all(),
    objects: db.query("SELECT hash,bytes,state FROM turn_journal_objects ORDER BY hash").all(),
    state: (db.query("SELECT index_purge FROM turn_journal_allocation WHERE id=1").get() as { index_purge: number }).index_purge,
  };
}
const objectBytes = (db: Database) => (db.query("SELECT coalesce(sum(bytes),0) AS bytes FROM turn_journal_objects WHERE state='present'").get() as { bytes: number }).bytes;

/**
 * History as an earlier release left it: real turns retained every version
 * through the journal's own object store, and their index-family changes are
 * then recorded under the index paths with hash, as before #2873. A symlink
 * in the family keeps its target, and a revert record names a retained index
 * version. The purge has not run yet.
 */
async function seedLegacyHistory(f: Fixture) {
  await f.open();
  await f.begin("voyage");
  for (const [note, [, bytes]] of Object.entries(LEGACY)) f.write(note, bytes);
  f.write("notes/stage-shm.md", SHARED);
  f.write(".brain-index/brain.db.bak", "a backup Athena keeps beside the index");
  f.write("notes/odysseus.md", "# Ithaca\nHome at last.\n");
  await f.journal.finish("voyage");
  await f.begin("return");
  f.write("notes/loom.md", SHARED);
  await f.journal.finish("return");
  await f.shut();
  f.raw(db => {
    for (const [note, [path]] of Object.entries(LEGACY)) db.query("UPDATE turn_journal_changes SET path=? WHERE path=?").run(path, note);
    db.query("UPDATE turn_journal_changes SET path='.brain-index/brain.db-shm' WHERE path='notes/stage-shm.md'").run();
    // A rollback journal replaced by a symlink: its earlier file version was retained too.
    db.query(`INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json) VALUES ('voyage',100,'.brain-index/brain.db-journal','',?,?)`)
      .run(JSON.stringify({ kind: "file", mode: 0o644, bytes: LEGACY["notes/stage-copy.md"][1].length, hash: sha(LEGACY["notes/stage-copy.md"][1]), ignored: false }),
        JSON.stringify({ kind: "symlink", mode: 0o777, bytes: 20, ignored: false, target: "../notes/odysseus.md" }));
    db.query("INSERT INTO turn_journal_revert_operations (id,principal_id,session_id,source_turn_id,journal_turn_id,fingerprint,action,state,pid,pid_start,requested_at) VALUES ('ithaca_revert','odysseus','ithaca','voyage','voyage','f','revert','complete',1,'',1)").run();
    db.query("INSERT INTO turn_journal_revert_paths (operation_id,path,before_json,after_json,state) VALUES ('ithaca_revert','.brain-index/brain.db',?,NULL,'excluded')")
      .run(JSON.stringify({ kind: "file", mode: 0o644, bytes: LEGACY["notes/stage-db.md"][1].length, hash: sha(LEGACY["notes/stage-db.md"][1]), ignored: false }));
    db.query("UPDATE turn_journal_allocation SET index_purge=0 WHERE id=1").run();
  });
}

const INDEX_HASHES = Object.values(LEGACY).map(([, bytes]) => sha(bytes));
const INDEX_BYTES = Object.values(LEGACY).reduce((sum, [, bytes]) => sum + bytes.length, 0);
const indexPaths = new Set([...Object.values(LEGACY).map(([path]) => path), ".brain-index/brain.db-shm", ".brain-index/brain.db-journal"]);

test("journal open purges the index bytes earlier releases retained, keeping their history as metadata-only (#2903)", async () => {
  const f = fixture();
  try {
    await seedLegacyHistory(f);
    const before = f.raw(dump);
    expect(INDEX_HASHES.every(hash => f.files().has(hash)), "LEGACY_INDEX_OBJECTS_RETAINED_BEFORE_PURGE").toBe(true);
    const accountedBefore = f.raw(objectBytes);
    await f.open();
    const presented = f.journal.details("ithaca", "voyage")!;

    const after = dump(f.db);
    expect(f.files().has(sha(SHARED)), "SHARED_OBJECT_KEPT").toBe(true);
    for (const hash of INDEX_HASHES) {
      expect(f.files().has(hash), `PURGE_REMOVES_INDEX_OBJECT_FILE ${hash}`).toBe(false);
      expect(after.objects.some(row => (row as { hash: string }).hash === hash), `PURGE_REMOVES_INDEX_OBJECT_ROW ${hash}`).toBe(false);
      expect(after.pins.some(row => (row as { hash: string }).hash === hash), `PURGE_DROPS_INDEX_PIN ${hash}`).toBe(false);
    }
    expect(accountedBefore - objectBytes(f.db), "PURGE_RECLAIMS_ACCOUNTED_BYTES").toBe(INDEX_BYTES);
    expect(after.state, "PURGE_COMPLETE").toBe(2);

    // Every index row stays, with its size evidence, as the metadata-only entry history already showed.
    const index = after.changes.filter(row => indexPaths.has((row as { path: string }).path)) as { path: string; sequence: number; before_json: string | null; after_json: string }[];
    expect(index.map(row => row.path).sort(), "PURGE_KEEPS_INDEX_HISTORY_ROWS").toEqual([...indexPaths].sort());
    expect(index.filter(row => row.before_json).map(row => row.path), "PURGE_SEES_A_RETAINED_BEFORE_VERSION").toEqual([".brain-index/brain.db-journal"]);
    for (const row of index) for (const side of ["before", "after"] as const) {
      const stored = row[`${side}_json`];
      if (!stored) continue;
      const version = JSON.parse(stored);
      expect(version, `PURGE_VERSION_METADATA_ONLY ${row.path} ${side}`).toMatchObject({ ignored: false, metadataOnly: true });
      expect(version.hash, `PURGE_VERSION_HAS_NO_HASH ${row.path} ${side}`).toBeUndefined();
      expect(version.target, `PURGE_VERSION_HAS_NO_TARGET ${row.path} ${side}`).toBeUndefined();
      expect(presented.changes.find(change => change.sequence === row.sequence)![side], `PURGE_PRESENTS_STORED_ROW ${row.path} ${side}`).toEqual(version);
    }
    expect(index.find(row => row.path === ".brain-index/brain.db")!.after_json, "PURGE_KEEPS_SIZE_EVIDENCE")
      .toBe(JSON.stringify({ kind: "file", mode: 0o644, bytes: LEGACY["notes/stage-db.md"][1].length, ignored: false, metadataOnly: true }));
    expect(JSON.parse((after.revertPaths[0] as { before_json: string }).before_json), "PURGE_REWRITES_REVERT_RECORD").toEqual(
      { kind: "file", mode: 0o644, bytes: LEGACY["notes/stage-db.md"][1].length, ignored: false, metadataOnly: true });

    // The shared object and every authoritative version keep their exact bytes.
    const loom = f.journal.details("ithaca", "return")!.changes.find(change => change.path === "notes/loom.md")!;
    expect(f.journal.version("ithaca", "return", loom.sequence, "after")!.bytes(1024).toString(), "SHARED_OBJECT_SERVED_FOR_ITS_OTHER_PATH").toBe(SHARED);
    for (const [path, bytes] of [["notes/odysseus.md", "# Ithaca\nHome at last.\n"], [".brain-index/brain.db.bak", "a backup Athena keeps beside the index"]]) {
      const change = presented.changes.find(item => item.path === path)!;
      expect(change.after, `CONTROL_KEEPS_HASH ${path}`).toMatchObject({ hash: sha(bytes!) });
      expect(f.journal.version("ithaca", "voyage", change.sequence, "after")!.bytes(1024).toString(), `CONTROL_SERVED ${path}`).toBe(bytes!);
    }
    const kept = (rows: unknown[]) => rows.filter(row => !indexPaths.has((row as { path: string }).path));
    expect(kept(after.changes), "PURGE_LEAVES_OTHER_ROWS_BYTE_IDENTICAL").toEqual(kept(before.changes));

    // A second open finds nothing left to do and changes nothing.
    await f.shut(); await f.open();
    expect(dump(f.db), "PURGE_IDEMPOTENT").toEqual(after);
  } finally { await f.close(); }
});

test("an object another record of the same turn names keeps its pin and bytes, whatever kind of record it is (#2903)", async () => {
  const f = fixture();
  try {
    await f.open(); await f.shut();
    mkdirSync(f.objects, { recursive: true, mode: 0o700 });
    // Each turn recorded an index version whose bytes it also holds for another reason.
    const bytes = { loom: "a shroud woven by day", memory: "Argos remembers", removal: "a portrait of Penelope", index: "only the index had these" };
    const version = (text: string) => ({ kind: "file", mode: 0o644, bytes: text.length, hash: sha(text), ignored: false });
    // A revert's own journal turn: its records name one hash for the index and another path, and one only for the index.
    const reverted = { shared: "the bow only Odysseus strings", index: "an index the suitors refreshed" };
    for (const text of [...Object.values(bytes), ...Object.values(reverted)]) writeFileSync(join(f.objects, sha(text)), text, { mode: 0o600 });
    f.raw(db => {
      for (const text of [...Object.values(bytes), ...Object.values(reverted)]) db.query("INSERT INTO turn_journal_objects VALUES (?,?,'present')").run(sha(text), text.length);
      db.query("INSERT INTO turn_journal_turns (turn_id,session_id,actor,profile,started_at,ended_at,state,kind,source_turn_id) VALUES ('revert_bow','ithaca','user','governed',3,4,'complete','revert','index')").run();
      db.query("INSERT INTO turn_journal_revert_operations (id,principal_id,session_id,source_turn_id,journal_turn_id,fingerprint,action,state,pid,pid_start,requested_at) VALUES ('bow','odysseus','ithaca','index','revert_bow','f','revert','complete',1,'',3)").run();
      const revertPath = db.query("INSERT INTO turn_journal_revert_paths (operation_id,path,before_json,after_json,state) VALUES ('bow',?,?,?,'restored')");
      revertPath.run(".brain-index/brain.db", JSON.stringify(version(reverted.shared)), JSON.stringify(version(reverted.index)));
      revertPath.run("notes/bow.md", JSON.stringify(version(reverted.shared)), null);
      for (const text of Object.values(reverted)) db.query("INSERT INTO turn_journal_object_refs VALUES ('revert_bow',?)").run(sha(text));
      for (const [turn, text] of Object.entries(bytes)) {
        db.query("INSERT INTO turn_journal_turns (turn_id,session_id,actor,profile,started_at,ended_at,state) VALUES (?,'ithaca','interactive','governed',1,2,'complete')").run(turn);
        db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json) VALUES (?,1,'.brain-index/brain.db','',NULL,?)").run(turn, JSON.stringify(version(text)));
        db.query("INSERT INTO turn_journal_object_refs VALUES (?,?)").run(turn, sha(text));
      }
      db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json) VALUES ('loom',2,'notes/shroud.md','',NULL,?)").run(JSON.stringify(version(bytes.loom)));
      db.query("INSERT INTO turn_journal_claude_memory VALUES ('memory','claude-memory://argos.md','/memory','1','2','argos.md',NULL,?,'saved')").run(JSON.stringify(version(bytes.memory)));
      // An attachment removal whose turn ended before observing it: only its receipt and pin hold the original.
      db.query(`INSERT INTO turn_journal_storage_operations (id,brain,principal_id,action,source_id,selection,fingerprint,journal_turn_id,state,pid,pid_start,requested_at,receipt,private_versions)
        VALUES ('removal_op','brain','odysseus','remove',NULL,'[]','f','removal','unknown',1,'',1,'{}',?)`)
        .run(JSON.stringify([{ path: "attachments/penelope.png", version: null, consequences: "", retained: version(bytes.removal) }]));
      // Legacy shapes without a hash become metadata-only as they are.
      db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json) VALUES ('index',2,'.brain-index/brain.db-wal','',?,?)")
        .run(JSON.stringify({ kind: "other", mode: 0, bytes: 0, ignored: false }), JSON.stringify({ kind: "file", mode: 0o644, bytes: 9, ignored: true }));
      db.query("UPDATE turn_journal_allocation SET index_purge=0 WHERE id=1").run();
    });
    await f.open();
    for (const turn of ["loom", "memory", "removal"] as const) {
      expect(f.files().has(sha(bytes[turn])), `SAME_TURN_SHARED_OBJECT_KEPT ${turn}`).toBe(true);
      expect(f.db.query("SELECT 1 AS pinned FROM turn_journal_object_refs WHERE turn_id=? AND hash=?").get(turn, sha(bytes[turn])), `SAME_TURN_SHARED_PIN_KEPT ${turn}`).toEqual({ pinned: 1 });
    }
    expect(f.journal.hasRetainedVersion("removal", version(bytes.removal) as never), "REMOVAL_ORIGINAL_STILL_RESTORABLE").toBe(true);
    expect(f.files().has(sha(reverted.shared)) && !!f.db.query("SELECT 1 FROM turn_journal_object_refs WHERE turn_id='revert_bow' AND hash=?").get(sha(reverted.shared)), "REVERT_RECORD_SHARED_OBJECT_KEPT").toBe(true);
    expect(f.files().has(sha(reverted.index)) || !!f.db.query("SELECT 1 FROM turn_journal_object_refs WHERE hash=?").get(sha(reverted.index)), "REVERT_ONLY_INDEX_OBJECT_PURGED").toBe(false);
    expect(f.db.query("SELECT before_json,after_json FROM turn_journal_revert_paths WHERE operation_id='bow' AND path='.brain-index/brain.db'").get(), "REVERT_RECORD_BOTH_SIDES_REWRITTEN").toEqual({
      before_json: JSON.stringify({ kind: "file", mode: 0o644, bytes: reverted.shared.length, ignored: false, metadataOnly: true }),
      after_json: JSON.stringify({ kind: "file", mode: 0o644, bytes: reverted.index.length, ignored: false, metadataOnly: true }) });
    expect(f.files().has(sha(bytes.index)), "UNSHARED_INDEX_OBJECT_PURGED").toBe(false);
    expect((f.db.query("SELECT count(*) AS n FROM turn_journal_changes WHERE path='.brain-index/brain.db' AND json_extract(after_json,'$.hash') IS NULL AND json_extract(after_json,'$.metadataOnly')=1").get() as { n: number }).n,
      "SHARED_INDEX_VERSIONS_STILL_METADATA_ONLY").toBe(4);
    expect(f.db.query("SELECT before_json,after_json FROM turn_journal_changes WHERE turn_id='index' AND sequence=2").get(), "UNHASHED_LEGACY_SHAPES_MARKED_AS_THEY_ARE").toEqual({
      before_json: JSON.stringify({ kind: "other", mode: 0, bytes: 0, ignored: false, metadataOnly: true }),
      after_json: JSON.stringify({ kind: "file", mode: 0o644, bytes: 9, ignored: true, metadataOnly: true }) });
  } finally { await f.close(); }
});

test("a journal with no earlier index versions is left unchanged by the purge (#2903)", async () => {
  const f = fixture();
  try {
    await f.open();
    await f.begin("plain"); f.write("notes/odysseus.md", "# Ithaca\nThe olive bed.\n"); await f.journal.finish("plain");
    await f.shut();
    f.raw(db => db.query("UPDATE turn_journal_allocation SET index_purge=0 WHERE id=1").run());
    const before = f.raw(dump), files = f.files();
    await f.open();
    expect(dump(f.db), "NO_LEGACY_HISTORY_UNCHANGED").toEqual({ ...before, state: 2 });
    expect(f.files(), "NO_LEGACY_OBJECTS_UNCHANGED").toEqual(files);
  } finally { await f.close(); }
});

test("a turn still recording, or another turn holding the object for a reason no row shows, keeps its pin (#2903)", async () => {
  const f = fixture();
  try {
    await seedLegacyHistory(f);
    const held = sha(LEGACY["notes/stage-wal.md"][1]), drifting = sha(LEGACY["notes/stage-lock.md"][1]);
    f.raw(db => {
      // A live process's open turn: interrupted-turn recovery leaves it recording.
      db.query("INSERT INTO turn_journal_turns (turn_id,session_id,actor,profile,pid,pid_start,started_at,state) VALUES ('sailing','ithaca','interactive','governed',?,?,1,'recording')").run(SELF.pid, SELF.start);
      db.query("INSERT INTO turn_journal_object_refs VALUES ('sailing',?)").run(held);
      // It recorded that index version itself, as an earlier release still running would.
      db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json) VALUES ('sailing',1,'.brain-index/brain.db-wal','',NULL,?)")
        .run(JSON.stringify({ kind: "file", mode: 0o644, bytes: LEGACY["notes/stage-wal.md"][1].length, hash: held, ignored: false }));
      // An ended turn pinned the same bytes without recording them, as a shared observation does before its rows.
      db.query("INSERT INTO turn_journal_turns (turn_id,session_id,actor,profile,started_at,ended_at,state) VALUES ('drifting','ithaca','interactive','governed',1,2,'partial')").run();
      db.query("INSERT INTO turn_journal_object_refs VALUES ('drifting',?)").run(drifting);
    });
    await f.open();
    expect(f.db.query("SELECT turn_id FROM turn_journal_object_refs WHERE hash=?").all(held), "RECORDING_TURN_PIN_KEPT").toEqual([{ turn_id: "sailing" }]);
    expect(f.files().has(held), "RECORDING_TURN_OBJECT_KEPT").toBe(true);
    expect(f.db.query("SELECT turn_id FROM turn_journal_object_refs WHERE hash=?").all(drifting), "OTHER_TURN_PIN_KEPT").toEqual([{ turn_id: "drifting" }]);
    expect(f.files().has(drifting), "OTHER_TURN_OBJECT_KEPT").toBe(true);
    expect(INDEX_HASHES.filter(hash => ![held, drifting].includes(hash) && f.files().has(hash)), "OTHER_INDEX_OBJECTS_PURGED").toEqual([]);
    expect(dump(f.db).state, "PURGE_COMPLETE_WITH_RECORDING_TURN").toBe(2);
  } finally { await f.close(); }
});

test("a crash inside the purge's first commit changes nothing, and the next open completes it (#2903)", async () => {
  const f = fixture();
  try {
    await seedLegacyHistory(f);
    const before = f.raw(dump), files = f.files();
    f.raw(db => {
      const ledger = journalStore.setup(db, { dbPath: f.path, objectsRoot: f.objects });
      try {
        // The first step's last write fails after its rows were rewritten: the commit rolls back whole.
        db.exec("CREATE TEMP TRIGGER crash_purge BEFORE DELETE ON journal.turn_journal_object_refs BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");
        expect(() => (ledger as unknown as { purgeIndexVersions(): unknown }).purgeIndexVersions(), "CRASH_SIMULATED").toThrow("simulated crash");
      } finally { (ledger as unknown as { close(): void }).close(); }
    });
    expect(f.raw(dump), "CRASHED_FIRST_STEP_LEAVES_NO_TRACE").toEqual(before);
    expect(f.files(), "CRASHED_FIRST_STEP_KEEPS_OBJECTS").toEqual(files);
    await f.open();
    expect(INDEX_HASHES.filter(hash => f.files().has(hash)), "RESUMED_PURGE_REMOVES_INDEX_OBJECTS").toEqual([]);
    expect(dump(f.db).state, "RESUMED_PURGE_COMPLETE").toBe(2);
  } finally { await f.close(); }
});

test("a crash between the purge's commits, or while collecting, resumes at the next open with no dangling reference (#2903)", async () => {
  for (const unlinked of [false, true]) {
    const f = fixture();
    try {
      await seedLegacyHistory(f);
      const first = f.raw(db => {
        const ledger = journalStore.setup(db, { dbPath: f.path, objectsRoot: f.objects }) as unknown as { purgeIndexVersions(): journalStore.IndexPurgeResult | null; close(): void };
        try { return ledger.purgeIndexVersions(); } finally { ledger.close(); }
      });
      expect(first, `FIRST_STEP_COMMITTED ${unlinked}`).toMatchObject({ step: "versions", versions: 7, pins: 4 });
      const between = f.raw(dump);
      expect(between.state, `CRASH_BETWEEN_STEPS_STATE ${unlinked}`).toBe(1);
      // No row names an index object any more, so none dangles while its file still exists.
      const named = JSON.stringify([...between.changes, ...between.revertPaths, ...between.pins]);
      expect(INDEX_HASHES.filter(hash => named.includes(hash)), `NO_REFERENCE_SURVIVES_FIRST_STEP ${unlinked}`).toEqual([]);
      expect(INDEX_HASHES.every(hash => f.files().has(hash)), `OBJECTS_AWAIT_COLLECTION ${unlinked}`).toBe(true);
      // A collection that removed one file before its commit was lost leaves only that object's row.
      if (unlinked) unlinkSync(join(f.objects, INDEX_HASHES[0]!));
      await f.open();
      const after = dump(f.db);
      expect(after.state, `RESUMED_COLLECTION_COMPLETE ${unlinked}`).toBe(2);
      expect(INDEX_HASHES.filter(hash => f.files().has(hash) || after.objects.some(row => (row as { hash: string }).hash === hash)), `RESUMED_COLLECTION_REMOVES_INDEX_OBJECTS ${unlinked}`).toEqual([]);
      expect(f.files().has(sha(SHARED)), `RESUMED_COLLECTION_KEEPS_SHARED_OBJECT ${unlinked}`).toBe(true);
    } finally { await f.close(); }
  }
});

test("the purge of a large journal stays bounded at open (#2903)", async () => {
  const f = fixture();
  const TURNS = 2_000, ORDINARY = 50, INDEX = 10, OBJECTS = 2_000;
  try {
    await f.open(); await f.shut();
    mkdirSync(f.objects, { recursive: true, mode: 0o700 });
    // 100,000 ordinary and 20,000 index-family versions over 2,000 ended turns,
    // with 2,000 index objects only index versions name and 2,000 ordinary ones.
    const index = Array.from({ length: OBJECTS }, (_, i) => `index refresh ${i} of Ithaca`), ordinary = Array.from({ length: OBJECTS }, (_, i) => `note ${i} of the Odyssey`);
    for (const bytes of [...index, ...ordinary]) writeFileSync(join(f.objects, sha(bytes)), bytes, { mode: 0o600 });
    const version = (bytes: string) => JSON.stringify({ kind: "file", mode: 0o644, bytes: bytes.length, hash: sha(bytes), ignored: false });
    f.raw(db => db.transaction(() => {
      const object = db.query("INSERT INTO turn_journal_objects VALUES (?,?,'present')");
      for (const bytes of [...index, ...ordinary]) object.run(sha(bytes), bytes.length);
      const turn = db.query("INSERT INTO turn_journal_turns (turn_id,session_id,actor,profile,started_at,ended_at,state) VALUES (?,'ithaca','interactive','governed',?,?,'complete')");
      const change = db.query("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json) VALUES (?,?,?,'',NULL,?)");
      const pin = db.query("INSERT OR IGNORE INTO turn_journal_object_refs VALUES (?,?)");
      const family = [".brain-index/brain.db", ".brain-index/brain.db-wal", ".brain-index/brain.db-shm", ".brain-index/brain.db.embedding-lock.db"];
      for (let t = 0; t < TURNS; t++) {
        const id = `turn-${t}`; turn.run(id, t, t + 1);
        for (let s = 0; s < ORDINARY; s++) { const bytes = ordinary[(t * ORDINARY + s) % OBJECTS]!; change.run(id, s, `notes/voyage-${s}.md`, version(bytes)); pin.run(id, sha(bytes)); }
        for (let s = 0; s < INDEX; s++) { const bytes = index[(t * INDEX + s) % OBJECTS]!; change.run(id, ORDINARY + s, family[s % family.length]!, version(bytes)); pin.run(id, sha(bytes)); }
      }
      db.query("UPDATE turn_journal_allocation SET index_purge=0 WHERE id=1").run();
    })());
    const started = performance.now();
    await f.open();
    const elapsed = performance.now() - started;
    await f.shut();
    const reopened = performance.now();
    await f.open();
    const baseline = performance.now() - reopened;
    console.log(`journal open with purge of ${TURNS * INDEX} index versions over ${TURNS * (ORDINARY + INDEX)} changes: ${elapsed.toFixed(0)} ms (open without purge: ${baseline.toFixed(0)} ms)`);
    expect(index.filter(bytes => f.files().has(sha(bytes))), "LARGE_PURGE_REMOVES_INDEX_OBJECTS").toEqual([]);
    expect(ordinary.filter(bytes => !f.files().has(sha(bytes))), "LARGE_PURGE_KEEPS_ORDINARY_OBJECTS").toEqual([]);
    expect((f.db.query("SELECT count(*) AS n FROM turn_journal_changes WHERE json_extract(after_json,'$.metadataOnly')=1").get() as { n: number }).n, "LARGE_PURGE_REWRITES_EVERY_INDEX_VERSION").toBe(TURNS * INDEX);
    // Generous for a shared host (measured under a second; the time is printed
    // above). Searching every pin per object made this open take ~27 s.
    expect(elapsed, "LARGE_PURGE_BOUNDED_AT_OPEN").toBeLessThan(5_000);
  } finally { await f.close(); }
}, 120_000);

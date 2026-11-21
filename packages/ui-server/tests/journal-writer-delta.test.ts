import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { setup, journalStatement, type ObservationRecord } from "../src/brain/journal-store.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
const recordObservation = (store: ReturnType<typeof setup>, record: ObservationRecord) => (store.recordObservation as (entry: ObservationRecord) => number)(record);

test("one changed shared path uses point peer lookups on the actual writer after ten thousand unrelated rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-writer-delta-")), brain = join(root, "brain"); mkdirSync(join(brain, "notes"), { recursive: true });
  const db = createUiDb(":memory:"), native = createNativeJournalFixture(brain, root);
  // An in-memory writer runs the same real store procedures on this connection.
  const journal = createTurnJournal(db, { brainPath: brain, dbPath: ":memory:", objectsRoot: join(root, "objects"), nativeManager: native.manager });
  const metadata = { sessionId: "ithaca", actor: "interactive", profile: "governed", model: null, policyHash: null } as const;
  try {
    await journal.begin("voyage", metadata, () => {});
    await journal.writeOperation(Array.from({ length: 10000 }, (_, i) => journalStatement("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,after_json) VALUES ('voyage',?,?,'',?)", i + 1, `notes/older-${i}.md`, '{"kind":"file","mode":420,"bytes":1,"ignored":true}')));
    await journal.begin("peer", metadata, () => {});
    writeFileSync(join(brain, "notes/new.md"), "Ithaca");
    const { spyOn } = await import("bun:test"), query = db.query.bind(db), peerLookups: string[] = [];
    const observed = spyOn(db, "query").mockImplementation(((sql: string, ...args: unknown[]) => {
      if (/SELECT.*FROM turn_journal_path_peers/i.test(sql)) peerLookups.push(sql);
      return Reflect.apply(query, db, [sql, ...args]);
    }) as typeof db.query);
    const start = performance.now(); try { await journal.observe(); } finally { observed.mockRestore(); }
    const elapsedMs = performance.now() - start;
    expect(journal.details("ithaca", "voyage")!.changes.at(-1)?.path, "REAL_ONE_PATH_DELTA_RECORDED").toBe("notes/new.md");
    expect(journal.summary("voyage").changedFiles).toBe(10001);
    expect(peerLookups.length, "REAL_WRITER_USES_POINT_PEER_RELATION").toBeGreaterThan(0);
    const plan = db.query(`EXPLAIN QUERY PLAN ${peerLookups[0]}`).all("voyage", "notes/new.md", "peer") as { detail: string }[];
    expect(plan.map(row => row.detail).join("\n"), "WRITER_ONE_PATH_LOOKUP_USES_PEER_PRIMARY_KEY").toContain("(turn_id=? AND path=? AND peer_id=?)");
    console.log("JOURNAL_WRITER_10000_ROW_ONE_PATH", JSON.stringify({ elapsedMs, plan }));
  } finally { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a solo rewrite never traverses its ten thousand previous versions", async () => {
  const { spyOn } = await import("bun:test"), { createJournalAccounting } = await import("../src/brain/journal-accounting.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-solo-history-")), db = createUiDb(":memory:"), objectsRoot = join(root, "objects");
  const store = setup(db, { dbPath: ":memory:", objectsRoot }), ledger = createJournalAccounting(db, ":memory:");
  ledger.write(() => {
    db.query("INSERT INTO turn_journal_turns(turn_id,actor,profile,started_at,state) VALUES ('voyage','interactive','governed',0,'recording')").run();
    const insert = db.query("INSERT INTO turn_journal_changes(turn_id,sequence,path,scope,after_json) VALUES ('voyage',?,'notes/ithaca.md','',?)");
    for (let n = 1; n <= 10000; n++) insert.run(n, JSON.stringify({ kind: "file", bytes: n, mode: 420, ignored: true }));
  });
  const query = db.query.bind(db), history: string[] = [];
  const observed = spyOn(db, "query").mockImplementation(((sql: string, ...args: unknown[]) => { if (/SELECT.*FROM turn_journal_changes/i.test(sql)) history.push(sql); return Reflect.apply(query, db, [sql, ...args]); }) as typeof db.query);
  try {
    recordObservation(store, { turnId: "voyage", sequence: 10000, at: 1, userPolicy: false, changed: [{ path: "notes/ithaca.md", scope: "", before: null, after: { kind: "file", bytes: 10001, mode: 420, ignored: true } }], overlaps: ["voyage"], steeringPaths: [], worktree: [], steeringUnavailable: [], unreadable: [] });
    expect(history, "SOLO_REWRITE_DOES_NOT_SCAN_VERSION_HISTORY").toEqual([]);
  } finally { observed.mockRestore(); await store.close?.(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a conflicted path stores one relation as a thousand solo versions follow", async () => {
  const { createJournalAccounting } = await import("../src/brain/journal-accounting.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-conflict-growth-")), db = createUiDb(":memory:"), store = setup(db, { dbPath: ":memory:", objectsRoot: join(root, "objects") }), ledger = createJournalAccounting(db, ":memory:");
  ledger.write(() => db.query("INSERT INTO turn_journal_turns(turn_id,actor,profile,started_at,state) VALUES ('voyage','interactive','governed',0,'recording')").run());
  try {
    for (let n = 1; n <= 1002; n++) { recordObservation(store, { turnId: "voyage", sequence: n - 1, at: n, userPolicy: false, changed: [{ path: "notes/ithaca.md", scope: "", before: null, after: { kind: "file", bytes: n, mode: 420, ignored: true } }], overlaps: n <= 2 ? ["voyage", "peer"] : ["voyage"], steeringPaths: [], worktree: [], steeringUnavailable: [], unreadable: [] });
      if (n === 20) expect(db.query("SELECT sum(length(conflict_observations)) AS bytes FROM turn_journal_changes").get(), "SOLO_SUCCESSORS_DO_NOT_COPY_CONFLICT_LISTS").toEqual({ bytes: 2 * n });
    }
    expect(db.query("SELECT count(*) AS n FROM turn_journal_path_conflicts").get(), "CONFLICT_RELATION_STORED_ONCE").toEqual({ n: 1 });
    expect(db.query("SELECT count(*) AS n FROM turn_journal_path_peers").get()).toEqual({ n: 1 });
    expect(db.query("SELECT sum(length(conflict_observations)) AS bytes FROM turn_journal_changes").get(), "SOLO_SUCCESSORS_DO_NOT_COPY_CONFLICT_LISTS").toEqual({ bytes: 2 * 1002 });
  } finally { await store.close?.(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("new conflict metadata cannot bypass physical journal admission on a full existing journal", async () => {
  const { createJournalAccounting } = await import("../src/brain/journal-accounting.js"), { JournalCapacityError } = await import("../src/brain/journal-objects.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-conflict-admission-")), path = join(root, "ui.db"), db = createUiDb(path), ledger = createJournalAccounting(db, path);
  ledger.write(() => db.query("INSERT INTO turn_journal_turns(turn_id,session_id,actor,profile,started_at,ended_at,state) VALUES ('voyage','ithaca','interactive','governed',0,1,'complete')").run());
  const store = setup(db, { dbPath: path, objectsRoot: join(root, "objects"), capBytes: 0 });
  let journal: ReturnType<typeof createTurnJournal> | undefined; const brain = join(root, "brain"); mkdirSync(brain); const native = createNativeJournalFixture(brain, root);
  try {
    expect(db.query("SELECT count(*) AS n FROM journal.sqlite_schema WHERE name IN ('turn_journal_path_peers','turn_journal_path_conflicts')").get(), "CONFLICT_SCHEMA_NEVER_ESCAPES_CAPACITY_ADMISSION").toEqual({ n: 0 });
    expect(db.query("SELECT state FROM turn_journal_turns WHERE turn_id='voyage'").get()).toEqual({ state: "complete" });
    expect(() => recordObservation(store, { turnId: "voyage", sequence: 0, at: 1, userPolicy: false, changed: [], overlaps: ["voyage"], steeringPaths: [], worktree: [], steeringUnavailable: [], unreadable: [] }), "FULL_JOURNAL_REFUSES_ONLY_NEW_OBSERVATION").toThrow(JournalCapacityError);
    journal = createTurnJournal(db, { brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"), capBytes: 0, nativeManager: native.manager }); await journal.ready;
    expect(journal.details("ithaca", "voyage")?.summary.state, "FULL_JOURNAL_STILL_BOOTS_TO_SERVE_HISTORICAL_RECORDS").toBe("complete");
  } finally { await journal?.close(); await store.close?.(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

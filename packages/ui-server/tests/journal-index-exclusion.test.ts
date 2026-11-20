import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

const copy = ".brain-index/.maintenance-41b2dd7f-9913-4151-b5bf-53aad064cd96";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
test("new index refreshes contribute no journal rows or byte scope while notes retain both versions", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-index-excluded-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, ".brain-index"), { recursive: true }); mkdirSync(join(brain, "notes"));
  writeFileSync(join(brain, "notes/ithaca.md"), "before");
  const native = createNativeJournalFixture(brain, root), db = createUiDb(path);
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects") });
  let facts = { changedPaths: -1, observedBytes: -1 };
  const off = journal.onObservation((_id, observed) => { facts = observed; });
  try {
    await journal.begin("voyage", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, () => {});
    for (const name of [".brain-index/brain.db", ".brain-index/brain.db-wal", ".brain-index/brain.db.embedding-lock.db", copy]) writeFileSync(join(brain, name), "generated index");
    await journal.observe();
    expect(journal.details("ithaca", "voyage")!.changes, "INDEX_REFRESH_HAS_NO_CHANGE_ROW").toEqual([]);
    expect(facts, "INDEX_REFRESH_HAS_ZERO_SCOPE").toMatchObject({ changedPaths: 0, observedBytes: 0 });
    writeFileSync(join(brain, "notes/ithaca.md"), "after");
    writeFileSync(join(brain, ".brain-index/brain.db"), "refreshed");
    writeFileSync(join(brain, ".brain-index/brain.db.bak"), "control");
    await journal.observe();
    const changes = journal.details("ithaca", "voyage")!.changes;
    expect(changes.map(change => change.path).sort(), "ONLY_NOTE_AND_SIMILAR_NAME_RETAINED").toEqual([".brain-index/brain.db.bak", "notes/ithaca.md"]);
    const note = changes.find(change => change.path === "notes/ithaca.md")!;
    expect(note.before?.hash, "NOTE_BEFORE_RETAINED").toBe(sha("before")); expect(note.after?.hash, "NOTE_AFTER_RETAINED").toBe(sha("after"));
    expect(readFileSync(join(root, "objects", sha("before")), "utf8")).toBe("before");
    expect(readFileSync(join(root, "objects", sha("after")), "utf8")).toBe("after");
    expect(facts, "INDEX_NOT_CHARGED_BESIDE_CONTENT").toMatchObject({ changedPaths: 2, observedBytes: 12 });
    await journal.finish("voyage");
  } finally { off(); await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an active observation scans only its delta after ten thousand committed change rows", async () => {
  const { spyOn } = await import("bun:test");
  const { journalStatement } = await import("../src/brain/journal-store.js");
  const root = mkdtempSync(join(tmpdir(), "odysseus-journal-delta-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, "notes"), { recursive: true });
  const native = createNativeJournalFixture(brain, root), db = createUiDb(path);
  const journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects") });
  const statements: string[] = [], query = db.query.bind(db);
  const inspected = spyOn(db, "query").mockImplementation(((sql: string) => { statements.push(sql); return query(sql); }) as typeof db.query);
  const facts: { changedPaths: number; observedBytes: number }[] = [];
  const off = journal.onObservation((_id, value) => facts.push(value));
  try {
    await journal.begin("voyage", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, () => {});
    await journal.writeOperation(Array.from({ length: 10000 }, (_, i) => journalStatement("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,after_json,class,actor,overlaps) VALUES ('voyage',?,?, '',?,'content','agent','[]')", i + 1, `notes/voyage-${i}.md`, '{"kind":"file","mode":420,"bytes":4,"ignored":true}')));
    journal.summary("voyage"); // Rebuild once after an external journal write.
    statements.length = 0;
    // Continue the host's sequence after the deliberately seeded history.
    // recordClaudeMemory is separate, so use a fresh admission sharing the
    // observation window rather than synthesizing worker state.
    const started = performance.now();
    await journal.observe();
    const elapsedMs = performance.now() - started;
    expect(journal.summary("voyage").changedFiles).toBe(10000);
    expect(facts.at(-1)).toMatchObject({ changedPaths: 10000, observedBytes: 40000 });
    expect(statements.filter(sql => /count\(DISTINCT|sum\(hashedBytes/i.test(sql)), "ACTIVE_OBSERVATION_NEVER_RESCANS_HISTORY").toEqual([]);
    console.log("JOURNAL_10000_ROW_OBSERVATION", JSON.stringify({ elapsedMs, historyRows: 10000, deltaRows: 0 }));
  } finally { off(); inspected.mockRestore(); await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

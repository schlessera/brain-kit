import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { observationCursor, observationSample } from "./observation-sample.js";

test("periodic, partial and repeated writes are bucketed by their recorded physical window", () => {
 const db = new Database(":memory:");
 db.exec("CREATE TABLE turn_journal_changes(turn_id TEXT,sequence INTEGER,path TEXT,PRIMARY KEY(turn_id,sequence))");
 const row = db.query("INSERT INTO turn_journal_changes VALUES ('voyage',?,?)");
 try {
  row.run(1, "notes/earlier.md"); const before = observationCursor(db, "voyage");
  const sample = () => observationSample(db, "voyage", before, 20, 0, "Bash", { frozenMs: 42, sharedHold: false });
  expect(sample().changedPaths, "PERIODIC_CAPTURE_BEFORE_TOOL_CANNOT_BECOME_TWENTY_PATH_SAMPLE").toBe(0);
  row.run(2, "notes/one.md"); row.run(3, "notes/one.md");
  expect(sample().changedPaths, "PARTIAL_WINDOW_IS_NOT_REQUESTED_BUCKET").toBe(1);
  for (let i = 0; i < 19; i++) row.run(i + 4, `notes/additional-${i}.md`);
  expect(sample()).toMatchObject({ changedPaths: 20, requestedPaths: 20, frozenMs: 42 });
 } finally { db.close(); }
});

test("a physical hold longer than a periodic interval remains measurable with its overlap labelled", async () => {
  const { observationHold } = await import("./observation-hold.js"), { observationSampleAccepted } = await import("./observation-sample.js");
  const db = new Database(":memory:"); db.exec("CREATE TABLE turn_journal_changes(turn_id TEXT,sequence INTEGER,path TEXT,PRIMARY KEY(turn_id,sequence))");
  let now = 0, frozen = false; const holds = observationHold({ freeze() { frozen = true; }, resume() { frozen = false; }, kill() {} }, () => now);
  try {
    const before = observationCursor(db, "voyage"); holds.before(); now = 15000; holds.before();
    db.query("INSERT INTO turn_journal_changes VALUES ('voyage',1,'notes/ithaca.md')").run(); now = 21000; holds.after(true);
    expect(frozen).toBe(true); now = 22000; holds.after(true); await holds.idle();
    const result = observationSample(db, "voyage", before, 1, 0, "Bash", holds.sample());
    expect(result).toMatchObject({ frozenMs: 22000, sharedHold: true, changedPaths: 1 });
    expect(observationSampleAccepted(result), "SLOW_PERIODIC_OVERLAP_IS_A_VALID_MEASURED_WINDOW").toBe(true);
    expect(frozen).toBe(false);
  } finally { db.close(); }
});

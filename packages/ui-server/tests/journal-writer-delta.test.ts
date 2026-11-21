import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { journalStatement } from "../src/brain/journal-store.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

test("one changed shared path uses a path index on the actual writer after ten thousand unrelated rows", async () => {
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
    const start = performance.now(); await journal.observe();
    const elapsedMs = performance.now() - start;
    expect(journal.details("ithaca", "voyage")!.changes.at(-1)?.path, "REAL_ONE_PATH_DELTA_RECORDED").toBe("notes/new.md");
    expect(journal.summary("voyage").changedFiles).toBe(10001);
    const plan = db.query("EXPLAIN QUERY PLAN SELECT sequence,after_json,overlaps FROM turn_journal_changes WHERE turn_id=? AND path=? ORDER BY sequence").all("voyage", "notes/new.md") as { detail: string }[];
    expect(plan.map(row => row.detail).join("\n"), "WRITER_ONE_PATH_LOOKUP_USES_PATH_INDEX").toContain("turn_journal_changes_path_sequence (turn_id=? AND path=?)");
    console.log("JOURNAL_WRITER_10000_ROW_ONE_PATH", JSON.stringify({ elapsedMs, plan }));
  } finally { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { expectRejection } from "./helpers/expect-rejection.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { createUiDb } from "../src/db/client.js";
import { JournalCapacityError } from "../src/brain/journal-objects.js";
import { journalStatement, JournalStatementRefused } from "../src/brain/journal-store.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";

function fixture(capBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), "journal-worker-odysseus-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, "notes"), { recursive: true });
  writeFileSync(join(brain, "notes", "odysseus.md"), "# Ithaca\n");
  const native = createNativeJournalFixture(brain, root), db = createUiDb(path);
  const open = () => createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"), capBytes });
  const turn = (id: string) => db.query("SELECT state,missing,session_id FROM turn_journal_turns WHERE turn_id=?").get(id) as { state: string; missing: string; session_id: string | null } | null;
  return { root, db, native, open, turn, async close() { await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("the app connection refuses journal rows while the worker connection commits them", async () => {
  const f = fixture(), journal = f.open();
  try {
    await journal.ready;
    expect(() => f.db.query("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state) VALUES ('suitor','interactive','strict',1,'recording')").run(),
      "JOURNAL_APP_CONNECTION_REFUSES_JOURNAL_WRITES").toThrow("outside capacity accounting");
    await journal.writeOperation([journalStatement("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state) VALUES ('odysseus','interactive','strict',1,'recording')")]);
    expect(f.turn("odysseus")?.state, "JOURNAL_WORKER_COMMITS_ACCOUNTED_WRITE").toBe("recording");
  } finally { await journal.close(); await f.close(); }
});

test("startup recovery commits before a write submitted during construction, and writes keep their order", async () => {
  const f = fixture();
  const first = f.open(); await first.ready;
  // A turn whose owner died, as a restart finds it.
  await first.writeOperation([journalStatement("INSERT INTO turn_journal_turns (turn_id,actor,profile,pid,pid_start,started_at,state) VALUES ('interrupted','interactive','strict',2147483647,'',1,'recording')")]);
  await first.close();
  const journal = f.open();
  try {
    // Submitted before `ready` settles; recovery must still land first.
    const writes = [
      journal.writeOperation([journalStatement("UPDATE turn_journal_turns SET missing=? WHERE turn_id='interrupted'", JSON.stringify([{ path: ".", reason: "after recovery" }]))]),
      journal.writeOperation([journalStatement("UPDATE turn_journal_turns SET session_id='penelope' WHERE turn_id='interrupted'")]),
      journal.writeOperation([journalStatement("UPDATE turn_journal_turns SET session_id='ithaca' WHERE turn_id='interrupted'")]),
    ];
    await Promise.all(writes);
    expect(f.turn("interrupted"), "JOURNAL_STARTUP_RECOVERY_PRECEDES_LATER_WRITES").toEqual({ state: "partial", missing: JSON.stringify([{ path: ".", reason: "after recovery" }]), session_id: "ithaca" });
  } finally { await journal.close(); await f.close(); }
});

test("journal refusals keep their class across the worker and roll the whole write back", async () => {
  const f = fixture(256 * 1024), journal = f.open();
  try {
    await journal.ready;
    const insert = journalStatement("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state) VALUES ('telemachus','interactive','strict',1,'recording')");
    const refused = await expectRejection(journal.writeOperation([insert, { check: "SELECT 1 WHERE 0", refusal: "Penelope refuses" }]), JournalStatementRefused, "JOURNAL_CHECK_REFUSAL_CLASS");
    expect((refused as Error).message).toBe("Penelope refuses");
    expect(f.turn("telemachus"), "JOURNAL_REFUSED_WRITE_ROLLED_BACK").toBeNull();
    const capacity = await expectRejection(journal.writeOperation([journalStatement("INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state,summary) VALUES ('suitors','interactive','strict',1,'recording',?)", "Odysseus ".repeat(64 * 1024))]),
      JournalCapacityError, "JOURNAL_CAPACITY_CLASS_CROSSES_WORKER") as JournalCapacityError;
    expect(capacity.reason).toBe("journal_capacity");
    expect(f.turn("suitors")).toBeNull();
  } finally { await journal.close(); await f.close(); }
});

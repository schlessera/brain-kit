/**
 * `TurnJournalSummary.keptFiles` (#3255) counts the distinct paths whose
 * change the journal retained for review: content, steering, policy and
 * workspace changes. Metadata-only index entries, ignored paths and `other`
 * entries are excluded, exactly as the client groups the presented details.
 * `changedFiles` keeps counting every distinct observed path.
 */
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnJournalChange, TurnJournalDetails } from "@schlessera/brain-ui-sdk/protocol";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { journalStatement } from "../src/brain/journal-store.js";

function fixture(capBytes?: number) {
  const root = mkdtempSync(join(tmpdir(), "journal-kept-odysseus-")), brain = join(root, "brain"), path = join(root, "ui.db");
  for (const directory of ["notes", ".brain-index", "context/policies", "workspaces/raft"]) mkdirSync(join(brain, directory), { recursive: true });
  writeFileSync(join(brain, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(brain, "notes/odysseus.md"), "# Ithaca\n");
  writeFileSync(join(brain, "AGENTS.md"), "Athena's instructions\n");
  writeFileSync(join(brain, "context/policies/governance.md"), "Original policy\n");
  for (const name of ["brain.db", "brain.db-wal", "brain.db-shm"]) writeFileSync(join(brain, ".brain-index", name), "initial index");
  const native = createNativeJournalFixture(brain, root);
  const db = createUiDb(path), journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"), capBytes });
  const begin = (id: string) => journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
  return { brain, db, journal, begin, write: (path: string, bytes: string | Buffer) => writeFileSync(join(brain, path), bytes),
    async close() { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** The client's grouping rule for presented details (`const kept`, `packages/ui-react/src/components/chat/turn-journal.tsx:68`). */
const kept = (change: TurnJournalChange) => !change.before?.metadataOnly && !change.after?.metadataOnly && !change.before?.ignored && !change.after?.ignored && (change.before?.kind ?? change.after?.kind) !== "other";
const keptPaths = (details: TurnJournalDetails) => new Set(details.changes.filter(kept).map(change => change.path)).size;

test("a turn that changed only an index sidecar keeps no files but still records the entry", async () => {
  const f = fixture();
  try {
    await f.begin("index-only");
    f.write(".brain-index/brain.db-shm", "index refreshed");
    await f.journal.finish("index-only");
    const details = f.journal.details("ithaca", "index-only")!;
    expect(details.changes.map(change => change.path), "INDEX_SIDECAR_IS_RECORDED").toEqual([".brain-index/brain.db-shm"]);
    expect(details.summary, "INDEX_ONLY_TURN_KEEPS_NO_FILES").toMatchObject({ state: "complete", changedFiles: 1, keptFiles: 0 });
    expect(details.summary.keptFiles, "SUMMARY_DETAILS_PARITY").toBe(keptPaths(details));
  } finally { await f.close(); }
});

test("kept files count content, steering, policy and workspace paths once and exclude index, ignored and other entries", async () => {
  const f = fixture();
  try {
    await f.begin("voyage");
    f.write("notes/odysseus.md", "# Ithaca\nThe raft is built.\n");
    await f.journal.observe();
    f.write("notes/odysseus.md", "# Ithaca\nThe raft sets sail.\n");
    f.write("AGENTS.md", "Athena's revised instructions\n");
    f.write("workspaces/raft/plan.md", "Lash the logs.\n");
    f.write("ignored.txt", "Calypso's loom\n");
    f.write(".brain-index/brain.db-wal", "index refreshed");
    await f.journal.observeUserPolicy("voyage", () => f.write("context/policies/governance.md", "Approved policy\n"));
    await f.journal.finish("voyage");
    // A FIFO observed by a native snapshot. The copying test checkpoint cannot
    // copy one, so its observation is recorded in the stored form directly.
    await f.journal.writeOperation([journalStatement("INSERT INTO turn_journal_changes (turn_id,sequence,path,scope,before_json,after_json) VALUES ('voyage',99,'notes/siren-song','',NULL,?)",
      JSON.stringify({ kind: "other", mode: 0o644, bytes: 0, ignored: false }))]);
    const details = f.journal.details("ithaca", "voyage")!;
    const byPath = (path: string) => details.changes.filter(change => change.path === path);
    expect(byPath("notes/odysseus.md").length, "CONTENT_PATH_CHANGED_REPEATEDLY").toBeGreaterThan(1);
    expect(byPath("notes/odysseus.md")[0], "CONTENT_IS_KEPT").toMatchObject({ class: "content", scope: "" });
    expect(byPath("AGENTS.md")[0], "STEERING_IS_KEPT").toMatchObject({ class: "steering" });
    expect(byPath("context/policies/governance.md")[0], "POLICY_IS_KEPT").toMatchObject({ class: "policy", actor: "user" });
    expect(byPath("workspaces/raft/plan.md")[0], "WORKSPACE_IS_KEPT").toMatchObject({ class: "content", scope: "workspaces/raft" });
    expect(byPath("ignored.txt")[0]?.after, "IGNORED_ENTRY_RECORDED").toMatchObject({ ignored: true });
    expect(byPath(".brain-index/brain.db-wal")[0]?.after, "INDEX_ENTRY_RECORDED").toMatchObject({ metadataOnly: true });
    expect(byPath("notes/siren-song")[0]?.after, "OTHER_ENTRY_RECORDED").toMatchObject({ kind: "other" });
    expect(details.summary, "KEPT_EXCLUDES_INDEX_IGNORED_AND_OTHER").toMatchObject({ changedFiles: 7, keptFiles: 4 });
    expect(details.summary.keptFiles, "SUMMARY_DETAILS_PARITY").toBe(keptPaths(details));
    expect(details.summary.changedFiles, "CHANGED_FILES_KEEPS_ITS_MEANING").toBe(new Set(details.changes.map(change => change.path)).size);

    // History recorded before #2873 stored index versions without the
    // metadata-only flag; history presents them as metadata only, and so does the count.
    await f.journal.writeOperation([journalStatement("UPDATE turn_journal_changes SET before_json=json_remove(before_json,'$.metadataOnly','$.stamp'),after_json=json_remove(after_json,'$.metadataOnly','$.stamp') WHERE turn_id='voyage' AND path='.brain-index/brain.db-wal'")]);
    const legacy = f.journal.details("ithaca", "voyage")!;
    expect(legacy.summary.keptFiles, "UNFLAGGED_INDEX_HISTORY_STAYS_EXCLUDED").toBe(4);
    expect(legacy.summary.keptFiles, "LEGACY_SUMMARY_DETAILS_PARITY").toBe(keptPaths(legacy));
  } finally { await f.close(); }
});

test("a partial journal reports kept files observed so far; an empty partial or absent turn is unknown", async () => {
  const f = fixture();
  try {
    expect(f.journal.summary("absent"), "ABSENT_TURN_IS_UNKNOWN").toMatchObject({ state: "unknown", changedFiles: null, keptFiles: null });
    await f.begin("partial");
    f.write("notes/odysseus.md", "# Ithaca\nHalfway home.\n");
    f.write(".brain-index/brain.db", "index refreshed");
    await f.journal.finish("partial");
    await f.journal.writeOperation([journalStatement("UPDATE turn_journal_turns SET state='partial' WHERE turn_id='partial'")]);
    expect(f.journal.summary("partial"), "PARTIAL_REPORTS_OBSERVED_SO_FAR").toMatchObject({ state: "partial", changedFiles: 2, keptFiles: 1 });
    await f.begin("empty-partial");
    await f.journal.finish("empty-partial");
    await f.journal.writeOperation([journalStatement("UPDATE turn_journal_turns SET state='partial' WHERE turn_id='empty-partial'")]);
    expect(f.journal.summary("empty-partial"), "EMPTY_PARTIAL_IS_UNKNOWN").toMatchObject({ state: "partial", changedFiles: null, keptFiles: null });
  } finally { await f.close(); }
});

test("expiry keeps a known kept count, and a summary retained before the field stays unknown", async () => {
  const f = fixture(1024 * 1024);
  try {
    await f.begin("first");
    f.write("notes/odysseus.md", `# Ithaca\n${"Athena guides the raft. ".repeat(20_000)}\n`);
    f.write(".brain-index/brain.db-shm", "index refreshed");
    await f.journal.finish("first");
    expect(f.journal.summary("first"), "BEFORE_EXPIRY").toMatchObject({ state: "complete", changedFiles: 2, keptFiles: 1 });
    // A later turn's retained bytes exceed the cap, so the host collects the oldest ended turn.
    await f.begin("second");
    f.write("notes/athena.md", `# Athena\n${"Penelope weaves the shroud. ".repeat(20_000)}\n`);
    await f.journal.finish("second");
    expect(f.journal.summary("first"), "EXPIRY_KEEPS_KNOWN_KEPT_COUNT").toMatchObject({ state: "expired", changedFiles: 2, keptFiles: 1 });
    expect(f.journal.details("ithaca", "first")!.changes, "EXPIRED_DETAILS_ARE_GONE").toEqual([]);

    await f.journal.writeOperation([journalStatement("UPDATE turn_journal_turns SET summary=? WHERE turn_id='first'", JSON.stringify({ changedFiles: 2, steeringFiles: 0, sharedAttribution: false }))]);
    expect(f.journal.summary("first"), "LEGACY_RETAINED_SUMMARY_KEPT_IS_UNKNOWN").toMatchObject({ state: "expired", changedFiles: 2, keptFiles: null });
  } finally { await f.close(); }
});

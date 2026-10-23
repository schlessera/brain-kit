import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { referenceWorktreeJournalPath, REFERENCE_WORKTREE_JOURNAL_SCOPE } from "../src/brain/reference-worktree-journal.js";
import { reversibleJournalPath } from "../src/brain/revert-files.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { referencePoolDouble } from "./helpers/reference-pool-double.js";

type Facts = { changedPaths: number; observedBytes: number; partial: boolean };

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "worktree-journal-odysseus-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, "workspaces", "argo"), { recursive: true });
  writeFileSync(join(brain, "workspaces", "argo", "log.md"), "Day one.\n");
  const native = createNativeJournalFixture(brain, root);
  const pool = referencePoolDouble(join(root, "pool"));
  const unsupported = async () => { throw Error("The pool double has no fixed worker-UID reader."); };
  const db = createUiDb(path);
  const ledger = new Set<string>();
  const journal = createTurnJournal(db, { referenceCheckpoints: { record: id => ledger.add(id), forget: id => ledger.delete(id) }, nativeManager: native.manager, brainPath: brain, dbPath: path, objectsRoot: join(root, "objects"),
    referencePool: { poolCheckpoint: (...args) => pool.poolCheckpoint(...args), poolDelta: (...args) => pool.poolDelta(...args), poolRelease: (...args) => pool.poolRelease(...args),
      poolReadCheckpoint: unsupported, poolStatCheckpoint: unsupported, poolListCheckpoint: unsupported } });
  const stopped = new Map<string, Error>(), facts = new Map<string, Facts>();
  journal.onObservation((turnId, value) => facts.set(turnId, value));
  const begin = (id: string) => journal.begin(id, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { stopped.set(id, error); });
  // Sealed shared source and one worktree snapshotted from it.
  const source = await pool.poolCreate(crypto.randomUUID(), "source", null, 4096);
  mkdirSync(join(source.path!, "odyssey"));
  writeFileSync(join(source.path!, "odyssey", "book-1.md"), "Sing, Muse.\n");
  writeFileSync(join(source.path!, ".gitignore"), "build/\n");
  await pool.poolSeal(source.id);
  const worktree = async () => (await pool.poolCreate(crypto.randomUUID(), "worktree", source.id, 4096));
  const rows = (turnId: string) => db.query("SELECT path,scope,class,actor,after_json FROM turn_journal_changes WHERE turn_id=? ORDER BY sequence").all(turnId) as
    { path: string; scope: string; class: string; actor: string; after_json: string | null }[];
  return { root, brain, db, journal, native, pool, begin, stopped, facts, worktree, rows, ledger,
    async close() { await journal.close(); await native.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("intentional worktree edits are journaled as workspace content of the holding turn and counted by scope", async () => {
  const f = await fixture();
  try {
    const tree = await f.worktree();
    await f.begin("turn-ithaca"); await f.begin("turn-other");
    await f.journal.attachWorktree("turn-ithaca", tree.id);
    writeFileSync(join(tree.path!, "odyssey", "book-1.md"), "Sing, Muse, of the man of many ways.\n");
    writeFileSync(join(tree.path!, "odyssey", "book-2.md"), "Telemachus sets sail.\n");
    mkdirSync(join(tree.path!, "build")); writeFileSync(join(tree.path!, "build", "out.txt"), "generated\n");
    // Ordinary workspace journaling is unchanged in the same window.
    writeFileSync(join(f.brain, "workspaces", "argo", "log.md"), "Day two.\n");
    await f.journal.observe();
    const rows = f.rows("turn-ithaca");
    const worktreeRows = rows.filter(row => row.scope === REFERENCE_WORKTREE_JOURNAL_SCOPE);
    expect(worktreeRows.map(row => row.path).sort(), "REFERENCE_WORKTREE_EDITS_JOURNALED").toEqual([
      referenceWorktreeJournalPath(tree.id, "build/out.txt"), referenceWorktreeJournalPath(tree.id, "odyssey/book-1.md"), referenceWorktreeJournalPath(tree.id, "odyssey/book-2.md")]);
    expect(worktreeRows.every(row => row.class === "content" && row.actor === "agent"), "REFERENCE_WORKTREE_EDITS_ARE_CONTENT").toBe(true);
    const book = worktreeRows.find(row => row.path.endsWith("book-1.md"))!;
    expect(JSON.parse(book.after_json!), "REFERENCE_WORKTREE_VERSION_RETAINED").toMatchObject({ kind: "file", ignored: false, hash: expect.any(String) });
    expect(JSON.parse(worktreeRows.find(row => row.path.endsWith("out.txt"))!.after_json!), "REFERENCE_WORKTREE_GITIGNORE_RESPECTED").toMatchObject({ ignored: true });
    expect(rows.find(row => row.path === "workspaces/argo/log.md"), "REFERENCE_WORKTREE_WORKSPACE_JOURNALING_UNCHANGED").toMatchObject({ scope: "workspaces/argo", class: "content" });
    expect(f.facts.get("turn-ithaca")?.changedPaths, "REFERENCE_WORKTREE_SCOPE_COUNTS_EDITS").toBe(4);
    expect(f.rows("turn-other").filter(row => row.scope === REFERENCE_WORKTREE_JOURNAL_SCOPE), "REFERENCE_WORKTREE_ONLY_ITS_HOLDING_TURN").toEqual([]);
    expect(f.journal.summary("turn-ithaca").state).toBe("recording");
    expect(reversibleJournalPath(referenceWorktreeJournalPath(tree.id, "odyssey/book-1.md")), "REFERENCE_WORKTREE_NEVER_REVERTED_INTO_THE_BRAIN").toBe(false);
  } finally { await f.close(); }
});

test("each worktree has one observing turn, and finishing it releases the worktree's checkpoints", async () => {
  const f = await fixture();
  try {
    const tree = await f.worktree();
    await expect(f.journal.attachWorktree("turn-absent", tree.id), "REFERENCE_WORKTREE_COVERAGE_NEEDS_ACTIVE_TURN").rejects.toThrow("active complete observation window");
    await f.begin("turn-ithaca"); await f.begin("turn-other");
    await f.journal.attachWorktree("turn-ithaca", tree.id);
    expect(f.ledger.size, "REFERENCE_WORKTREE_JOURNAL_CHECKPOINT_RECORDED").toBe(1);
    await f.journal.attachWorktree("turn-ithaca", tree.id);
    await expect(f.journal.attachWorktree("turn-other", tree.id), "REFERENCE_WORKTREE_ONE_OBSERVER").rejects.toThrow("already observes");
    expect(f.journal.worktrees("turn-ithaca")).toEqual([tree.id]);
    writeFileSync(join(tree.path!, "odyssey", "book-3.md"), "The suitors feast.\n");
    await f.journal.finish("turn-ithaca");
    expect(f.rows("turn-ithaca").map(row => row.path), "REFERENCE_WORKTREE_FINAL_OBSERVATION").toContain(referenceWorktreeJournalPath(tree.id, "odyssey/book-3.md"));
    const live = [...f.pool.records.values()].filter(record => record.purpose === "checkpoint" && record.state === "sealed");
    expect(live, "REFERENCE_WORKTREE_CHECKPOINTS_RELEASED_AT_FINISH").toEqual([]);
    expect([...f.ledger], "REFERENCE_WORKTREE_JOURNAL_CHECKPOINTS_LEDGERED").toEqual([]);
    expect(f.journal.worktrees("turn-ithaca")).toEqual([]);
  } finally { await f.close(); }
});

test("a worktree capture that fails leaves its holding turn partial and stopped, and nobody else", async () => {
  const f = await fixture();
  try {
    const tree = await f.worktree();
    await f.begin("turn-ithaca"); await f.begin("turn-other");
    await f.journal.attachWorktree("turn-ithaca", tree.id);
    const delta = f.pool.poolDelta;
    f.pool.poolDelta = async () => { throw Error("worktree checkpoint is unreadable"); };
    writeFileSync(join(tree.path!, "odyssey", "book-1.md"), "Unobserved.\n");
    await f.journal.observe();
    f.pool.poolDelta = delta;
    expect(f.journal.summary("turn-ithaca").state, "REFERENCE_WORKTREE_FAILED_CAPTURE_PARTIAL").toBe("partial");
    expect(f.stopped.get("turn-ithaca")?.message, "REFERENCE_WORKTREE_FAILED_CAPTURE_STOPS_HOLDER").toMatch(/unreadable/);
    expect(f.stopped.has("turn-other"), "REFERENCE_WORKTREE_FAILURE_CONFINED").toBe(false);
    expect(f.journal.summary("turn-other").state).toBe("recording");
    expect(f.journal.worktrees("turn-ithaca"), "REFERENCE_WORKTREE_FAILED_ROOT_DROPPED").toEqual([]);
    expect(f.facts.get("turn-ithaca"), "REFERENCE_WORKTREE_PARTIAL_FACTS_NOT_HEADROOM").toMatchObject({ partial: true });
  } finally { await f.close(); }
});

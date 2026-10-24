import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKeyedLock, type BrainApplicationInput, type BrainApplicationResult } from "@schlessera/brain-ui-sdk/server";
import { createBrainApplication, inProcessPlanner, type ApplicationPlanner, type BrainApplicationIndexOutcome } from "../src/brain/application.js";
import { createIndexBatch, IndexFlushError, readsIndex } from "../src/brain/index-batch.js";

// #2835: an application returns once its Markdown commits. Its index update
// waits, batched over exact paths, for the next index-dependent read or the
// end of the turn; a failed update is reported, never silently dropped.
let root: string;
let receipts: BrainApplicationResult[];
let outcomes: BrainApplicationIndexOutcome[];
let calls: { op: "index" | "plan"; paths?: readonly string[] }[];
let indexFailure: string | undefined;
const request = (input: BrainApplicationInput) => ({ principalId: "odysseus", turnId: "turn-scheria", input });
const write = (path: string, content: string) => ({ operation: "write" as const, path, content, expectedBaseHash: null });
const note = (title: string, body: string) => `---\ntitle: ${title}\ntype: note\n---\n${body}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "application-index-batch-"));
  cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
  const config = join(root, "brain.config.ts");
  writeFileSync(config, readFileSync(config, "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
  receipts = []; outcomes = []; calls = []; indexFailure = undefined;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The real in-process planner, observed: each index run can be failed. */
const planner: ApplicationPlanner = {
  async planAdd(...args) { calls.push({ op: "plan" }); return inProcessPlanner.planAdd(...args); },
  async index(target, signal, paths) {
    calls.push({ op: "index", ...(paths ? { paths } : {}) });
    if (indexFailure) throw new Error(indexFailure);
    return inProcessPlanner.index(target, signal, paths);
  },
};
function application() {
  return createBrainApplication({ root, planner, principalId: "odysseus", turnId: "turn-scheria", signal: new AbortController().signal,
    isAuthorized: () => true, policy: { autoAllowed: ["write", "edit", "add"], available: ["write", "edit", "add"], lock: createKeyedLock() },
    approve: async () => true, record: result => { receipts.push(result); return `record-${receipts.length}`; },
    recordIndex: outcome => outcomes.push(outcome) });
}
async function searchIndex(query: string) {
  const core = await import("@schlessera/brain/internal");
  const context = await core.initContext({ root });
  const db = core.openDatabase(context.dbPath);
  try {
    return (db.query("SELECT d.path FROM documents_fts f JOIN documents d ON d.id = f.rowid WHERE documents_fts MATCH ? ORDER BY d.path").all(query) as { path: string }[]).map(row => row.path);
  } finally { db.close(); }
}

describe("deferred application indexing (#2835)", () => {
  test("a failed update is reported to every waiter and the Activity record, then retried, never dropped", async () => {
    await inProcessPlanner.index(root, undefined);
    const apply = application();
    const path = "notes/phaeacian-ship.md";
    expect((await apply(request(write(path, note("Phaeacian ship", "Alcinous lends a ship."))))).ok).toBe(true);
    indexFailure = "maintenance worker ran out of space";
    const failed = await apply.indexBatch.barrier().then(() => undefined, (error: unknown) => error);
    expect(failed).toBeInstanceOf(IndexFlushError);
    expect((failed as IndexFlushError).message).toContain(path);
    expect((failed as IndexFlushError).message).toContain("maintenance worker ran out of space");
    expect(outcomes).toEqual([{ applicationId: "record-1", changes: receipts[0]!.changes, indexed: false, indexError: "maintenance worker ran out of space" }]);
    // The Markdown stays committed; the index still lacks it, and stays queued.
    expect(readFileSync(join(root, path), "utf8")).toContain("Alcinous lends a ship.");
    expect(await searchIndex("Alcinous")).toEqual([]);
    expect(apply.indexBatch.pending()).toBe(true);
    // A failed update cannot pass the next barrier either; it is tried again.
    await expect(apply.indexBatch.barrier()).rejects.toBeInstanceOf(IndexFlushError);
    expect(calls.filter(call => call.op === "index")).toHaveLength(2);
    expect(outcomes).toHaveLength(1);
    indexFailure = undefined;
    await apply.indexBatch.barrier();
    expect(await searchIndex("Alcinous")).toEqual([path]);
    expect(outcomes.at(-1)).toEqual({ applicationId: "record-1", changes: receipts[0]!.changes, indexed: true });
    expect(apply.indexBatch.pending()).toBe(false);
  });

  test("capture planning waits for earlier writes, and refuses when their update failed", async () => {
    await inProcessPlanner.index(root, undefined);
    const apply = application();
    // A title-matched project capture appends: planning finds the match in the index.
    expect((await apply(request(write("projects/active/ithaca-harbor.md", "---\ntitle: Ithaca harbor\ntype: project\nstatus: active\n---\nPhorcys bay.\n")))).ok).toBe(true);
    const appended = await apply(request({ operation: "add", content: "Ithaca harbor\n\nAthena hides the gifts." }));
    expect(appended.ok, appended.message).toBe(true);
    expect(calls.map(call => call.op)).toEqual(["index", "plan"]);
    expect(appended.outcome).toMatchObject({ action: "appended", path: "projects/active/ithaca-harbor.md", indexed: false, indexStatus: "pending" });
    indexFailure = "index locked";
    const refused = await apply(request({ operation: "add", content: "Eumaeus keeps the swine.", type: "note", title: "Swineherd" }));
    expect(refused).toMatchObject({ ok: false, code: "index_stale", changes: [] });
    expect(refused.message).toContain("index locked");
    expect(calls.at(-1)!.op).toBe("index");
  });

  test("an index-dependent reader waits; a barrier with nothing queued runs no update", async () => {
    const batch = createIndexBatch({ index: async paths => { calls.push({ op: "index", paths }); } });
    await batch.barrier();
    expect(calls).toEqual([]);
    batch.queue(["notes/b.md", "notes/a.md"]);
    batch.queue(["notes/a.md"]);
    await batch.barrier();
    expect(calls).toEqual([{ op: "index", paths: ["notes/a.md", "notes/b.md"] }]);
    for (const name of ["mcp__brain__brain_search", "mcp__brain__brain_graph", "mcp__brain__module_tool", "brain_search", "brain_context", "brain_list", "brain_graph", "brain_read", "bash", "Bash"])
      expect(readsIndex(name), name).toBe(true);
    for (const name of ["Read", "Grep", "Glob", "read_file", "write_file", "mcp__brain-ui__write_file", "mcp__brain-ui__brain_read_base", "brain_read_base"])
      expect(readsIndex(name), name).toBe(false);
  });

  test("a waiter that stops waiting does not cancel the update it joined", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const batch = createIndexBatch({ index: async paths => { calls.push({ op: "index", paths }); await gate; } });
    batch.queue(["notes/raft.md"]);
    const waiter = new AbortController();
    const stopped = batch.barrier(waiter.signal);
    waiter.abort(new Error("turn cancelled"));
    await expect(stopped).rejects.toThrow("turn cancelled");
    expect(batch.pending()).toBe(true);
    release();
    await batch.idle();
    expect(batch.pending()).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

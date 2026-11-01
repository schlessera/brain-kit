import { afterEach, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../packages/ui-server/src/db/client";
import { createPrincipal } from "../packages/ui-server/src/db/principals";
import { NativeBrainManagerError } from "../packages/ui-sdk/src/server/native-brain-manager-protocol";
import { createReferenceTools } from "../packages/ui-server/src/brain/reference-tools";
import { createReferenceSources } from "../packages/ui-server/src/brain/reference-source";
import { referencePoolDouble } from "../packages/ui-server/tests/helpers/reference-pool-double";
import { createFixtureWorktrees, ALLOCATION_ATTEMPTS } from "../scripts/native-proof/reference-worktree-allocation";
import { CHANGING_POOL } from "../scripts/native-proof/reference-worktree-release";

const repository = "https://github.com/odysseus/ithaca";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "s7-allocation-")), db = createUiDb(":memory:");
  const pool = referencePoolDouble(join(root, "pool"));
  const sources = createReferenceSources({ db, pool, brain: "ithaca", credentials: {}, transport: {
    async resolve() { return { ok: true, commit: "1".repeat(40), ref: "refs/heads/main" }; },
    async fetch({ root }) { writeFileSync(join(root, "odyssey.md"), "Argos waits.\n"); return { commit: "1".repeat(40) }; },
    async checkout() {},
  } });
  const principalId = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 86_400 }).id;
  const input = { principalId, repository, revision: "main" };
  (await sources.request(input)).release();
  const notes: { kind: string; facts: Record<string, unknown> }[] = [];
  // A forwarding client lets faults change beneath the actual production allocator.
  const client = { ...pool,
    poolCreate: (...args: Parameters<typeof pool.poolCreate>) => pool.poolCreate(...args),
    poolCheckpoint: (...args: Parameters<typeof pool.poolCheckpoint>) => pool.poolCheckpoint(...args),
    poolRelease: (...args: Parameters<typeof pool.poolRelease>) => pool.poolRelease(...args),
  };
  const covered: string[] = [];
  const worktrees = createFixtureWorktrees({ db, pool: client, sources, coverage: async input => { covered.push(input.worktreeId); } }, (kind, facts) => notes.push({ kind, facts: structuredClone(facts) }));
  cleanups.push(async () => { await worktrees.close(); await sources.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { pool, db, worktrees, input, notes, covered, sources };
}
function fault(message = CHANGING_POOL, code: ConstructorParameters<typeof NativeBrainManagerError>[0] = "unavailable") { return new NativeBrainManagerError(code, message); }

for (const phase of ["create", "checkpoint"] as const) {
  test(`S7 once-changing ${phase} cleans and fences before a fresh successful allocation`, async () => {
    const f = await fixture();
    let calls = 0;
    if (phase === "create") {
      const original = f.pool.poolCreate;
      f.pool.poolCreate = async (...args) => { if (args[1] === "worktree" && ++calls === 1) throw fault(); return original(...args); };
    } else {
      const original = f.pool.poolCheckpoint;
      f.pool.poolCheckpoint = async (...args) => { if (++calls === 1) throw fault(); return original(...args); };
    }
    const tree = await f.worktrees.allocate(f.input);
    expect(calls, "S7_ONCE_CHANGING_SUCCESS").toBe(2);
    expect(tree.state).toBe("active");
    const deferred = f.notes.filter(note => note.kind === "worktree-allocation-deferred");
    expect(deferred.length, "S7_ONE_TRUTHFUL_DEFERRAL").toBe(1);
    const identities = deferred[0]!.facts.identities as { id: string; released: { state: string } }[];
    expect(identities.length, "S7_CREATE_AND_BASELINE_IDENTITIES").toBe(phase === "create" ? 1 : 2);
    for (const identity of identities) {
      expect(identity.id).not.toBe(tree.id);
      expect(["deleted", "reclaimed"]).toContain(identity.released.state);
      await expect(f.pool.poolCreate(identity.id, "worktree", null, 4096), "S7_RELEASED_IDENTITY_CANNOT_RECREATE").rejects.toMatchObject({ code: "released" });
    }
    expect(f.db.query("SELECT id, state FROM reference_worktrees").all(), "S7_ONLY_SUCCESSFUL_WORKTREE_RETAINED").toEqual([{ id: tree.id, state: "active" }]);
  });
}

test("S7 repeated changing stops at the fixed allocation bound after cleanup", async () => {
  const f = await fixture(); let calls = 0;
  f.pool.poolCreate = async () => { calls++; if (calls > ALLOCATION_ATTEMPTS) throw Error("S7_BOUND_OVERRUN"); throw fault(); };
  await expect(f.worktrees.allocate(f.input), "S7_EXHAUSTION_FAILS").rejects.toThrow("REFERENCE_WORKTREE_ALLOCATION_ATTEMPT_BOUND");
  expect(calls, "S7_FIXED_BOUND").toBe(3);
  expect(f.notes.filter(note => note.kind === "worktree-allocation-deferred").length).toBe(2);
  expect(f.notes.filter(note => note.kind === "worktree-allocation-cleanup-proven").length).toBe(3);
  expect(f.db.query("SELECT * FROM reference_worktrees").all()).toEqual([]);
});

for (const [code, message] of [["capacity", CHANGING_POOL], ["unknown", CHANGING_POOL], ["unavailable", "another refusal"], ["unavailable", `${CHANGING_POOL} extra`]] as const) {
  test(`S7 other refusal fails immediately: ${code} ${message}`, async () => {
    const f = await fixture(); let calls = 0;
    f.pool.poolCreate = async () => { calls++; if (calls > 1) throw Error("S7_OTHER_ERROR_RETRIED"); throw fault(message, code); };
    await expect(f.worktrees.allocate(f.input), "S7_OTHER_ERROR_PRESERVED").rejects.toThrow(`The worktree could not be created: ${message}`);
    expect(calls, "S7_OTHER_ERROR_IMMEDIATE").toBe(1);
    expect(f.notes).toEqual([]);
  });
}

test("S7 failed discard cannot defer even when production preserves the changing refusal", async () => {
  const f = await fixture(); let calls = 0;
  const original = f.pool.poolCreate;
  f.pool.poolCreate = async (...args) => { calls++; if (calls === 1) throw fault(); return original(...args); };
  f.pool.poolRelease = async () => { throw Error("fixture cleanup failed"); };
  await expect(f.worktrees.allocate(f.input)).rejects.toThrow("REFERENCE_WORKTREE_ALLOCATION_CLEANUP_RECEIPT");
  expect(calls, "S7_UNFINISHED_DISCARD_NO_RETRY").toBe(1);
});

test("S7 a lying release receipt cannot hide a live pool root", async () => {
  const f = await fixture(); let calls = 0;
  const original = f.pool.poolCheckpoint;
  f.pool.poolCheckpoint = async (...args) => { if (++calls === 1) throw fault(); return original(...args); };
  const release = f.pool.poolRelease;
  f.pool.poolRelease = async id => {
    const record = f.pool.records.get(id);
    if (record?.purpose === "worktree") return { ...record, state: "deleted", path: null, access: null };
    return release(id);
  };
  await expect(f.worktrees.allocate(f.input)).rejects.toThrow("REFERENCE_WORKTREE_ALLOCATION_FENCED");
  expect(calls).toBe(1);
});

test("S7 reused allocation identity fails before a second pool create", async () => {
  const f = await fixture(); let calls = 0;
  const id = crypto.randomUUID(), original = f.pool.poolCreate;
  f.pool.poolCreate = async (...args) => { if (++calls === 1) throw fault(); return original(...args); };
  const uuid = spyOn(crypto, "randomUUID").mockReturnValue(id);
  try { await expect(f.worktrees.allocate(f.input)).rejects.toThrow("REFERENCE_WORKTREE_ALLOCATION_FRESH_IDENTITY"); }
  finally { uuid.mockRestore(); }
  expect(calls, "S7_REUSED_IDENTITY_NEVER_FORWARDED").toBe(1);
});

for (const defect of ["path", "grant", "row"] as const) {
  test(`S7 incomplete cleanup refuses deferral: ${defect}`, async () => {
    const f = await fixture(); let calls = 0;
    const create = f.pool.poolCreate, release = f.pool.poolRelease;
    let worktreeId = "", path = "";
    f.pool.poolCreate = async (...args) => {
      const result = await create(...args); worktreeId = result.id; path = result.path!; return result;
    };
    const checkpoint = f.pool.poolCheckpoint;
    f.pool.poolCheckpoint = async (...args) => { if (++calls === 1) throw fault(); return checkpoint(...args); };
    f.pool.poolRelease = async id => {
      if (id !== worktreeId) return release(id);
      if (defect === "path") {
        // Preserve the real directory while falsely claiming deletion in both receipt and census.
        const record = f.pool.records.get(id)!;
        record.state = "deleted"; record.path = null;
        return record;
      }
      const result = await release(id);
      if (defect === "grant") result.access = "stale-generation";
      if (defect === "row") {
        // Production discard must not be assumed successful when its write fails.
        f.db.run("CREATE TRIGGER retain_s7 BEFORE DELETE ON reference_worktrees BEGIN SELECT RAISE(FAIL, 'retain fixture row'); END");
      }
      return result;
    };
    const label = { path: "PATH_REMOVED", grant: "NO_LIVE_GRANT", row: "DISCARDED" }[defect];
    await expect(f.worktrees.allocate(f.input)).rejects.toThrow(`REFERENCE_WORKTREE_ALLOCATION_${label}`);
    expect(calls, "S7_CLEANUP_DEFECT_NO_RETRY").toBe(1);
    expect(path.length).toBeGreaterThan(0);
  });
}

test("S7 a baseline cannot reuse its worktree identity", async () => {
  const f = await fixture();
  const id = crypto.randomUUID(), uuid = spyOn(crypto, "randomUUID").mockReturnValue(id);
  try { await expect(f.worktrees.allocate(f.input)).rejects.toThrow("REFERENCE_WORKTREE_ALLOCATION_FRESH_IDENTITY"); }
  finally { uuid.mockRestore(); }
});

test("S7 tools request defers only allocation and grants the fresh result once", async () => {
  const f = await fixture(), tools = createReferenceTools({ sources: f.sources, worktrees: f.worktrees });
  const generation = await f.worktrees.openGeneration({ principalId: f.input.principalId, turnId: "turn-s7-tools", profile: "governed" });
  await tools.begin("turn-s7-tools", { principalId: f.input.principalId, posture: "interactive", generation });
  const create = f.pool.poolCreate; let calls = 0;
  f.pool.poolCreate = async (...args) => { if (++calls === 1) throw fault(); return create(...args); };
  try {
    const result = await tools.call("turn-s7-tools", f.input.principalId,
      { tool: "reference_worktree", input: { action: "request", repository, revision: "main" } });
    expect(result, "S7_TOOL_REQUEST_SUCCEEDS").toMatchObject({ ok: true, action: "request" });
    if (!result.ok || !("worktree" in result)) throw Error("S7_TOOL_RESULT_MISSING");
    expect(calls).toBe(2);
    expect(f.covered, "S7_TOOL_GRANTS_ONLY_FRESH_WORKTREE").toEqual([result.worktree.id]);
    expect(f.pool.events.filter(event => event.operation === "access").map(event => event.id)).toEqual([result.worktree.id]);
    expect(f.notes.filter(note => note.kind === "worktree-allocation-deferred").length).toBe(1);
  } finally { tools.end("turn-s7-tools"); await f.worktrees.closeGeneration(generation.id); }
});

test("S7 only a reclaimed checkpoint can be absent from recovery census", async () => {
  const f = await fixture(); let calls = 0;
  const create = f.pool.poolCreate, release = f.pool.poolRelease;
  f.pool.poolCreate = async (...args) => { if (++calls === 1) throw fault(); return create(...args); };
  f.pool.poolRelease = async id => { const result = await release(id); f.pool.records.delete(id); return result; };
  await expect(f.worktrees.allocate(f.input)).rejects.toThrow("REFERENCE_WORKTREE_ALLOCATION_FORGOTTEN_CHECKPOINT");
  expect(calls).toBe(1);
});

test("S7 a reclaimed baseline may be forgotten while its receipt remains fenced", async () => {
  const f = await fixture(); let calls = 0;
  const checkpoint = f.pool.poolCheckpoint, release = f.pool.poolRelease;
  f.pool.poolCheckpoint = async (...args) => {
    const result = await checkpoint(...args);
    if (++calls === 1) throw fault();
    return result;
  };
  f.pool.poolRelease = async id => {
    const result = await release(id);
    if (result.purpose === "checkpoint") f.pool.records.delete(id);
    return result;
  };
  expect((await f.worktrees.allocate(f.input)).state).toBe("active");
  expect(calls).toBe(2);
  expect(f.notes.filter(note => note.kind === "worktree-allocation-deferred").length).toBe(1);
});

test("S7 a plain-object changing error cannot defer allocation", async () => {
  const f = await fixture(); let calls = 0;
  const create = f.pool.poolCreate;
  // Production stringifies non-Errors. Preserve the exact wrapped message so
  // only the native error class distinguishes this plain object from a refusal.
  const error = { code: "unavailable", message: CHANGING_POOL, toString() { return this.message; } };
  f.pool.poolCreate = async (...args) => { if (++calls === 1) throw error; return create(...args); };
  await expect(f.worktrees.allocate(f.input), "S7_PLAIN_OBJECT_NOT_DEFERRED").rejects.toMatchObject({
    code: "unavailable", message: `The worktree could not be created: ${CHANGING_POOL}`,
  });
  expect(calls, "S7_PLAIN_OBJECT_FAILS_IMMEDIATELY").toBe(1);
  expect(f.notes, "S7_PLAIN_OBJECT_HAS_NO_DEFERRAL_RECEIPTS").toEqual([]);
});

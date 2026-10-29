import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { createReferenceGrant, revokeReferenceGrant } from "../src/db/reference-grants";
import { createReferenceSources } from "../src/brain/reference-source";
import type { ReferenceTransport } from "../src/brain/reference-transport";
import { createReferenceWorktrees, recordReferenceWorktreeCheckpoint, referenceWorktreeDependents, referenceWorktreeOwner, REFERENCE_WORKTREE_INACTIVITY_MS } from "../src/brain/reference-worktrees";
import { referencePoolDouble } from "./helpers/reference-pool-double";

import { NativeBrainManagerError } from "@schlessera/brain-ui-sdk/internal";
import { CHANGING_POOL, settledWorktreeRelease } from "../../../scripts/native-proof/reference-worktree-release";

const BRAIN = "ithaca-brain", DAY = 86_400, TOKEN = "fixture-reference-token";
const PUBLIC = "https://github.com/odysseus/ithaca", PRIVATE = "https://github.com/odysseus/penelope-loom";
let root: string, db: Database, clock: number;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "reference-worktrees-")); db = createUiDb(":memory:"); clock = Date.now(); });
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

const owner = (label = "Penelope") => createPrincipal(db, { authMethod: "password", label, ttlSeconds: 30 * DAY });
const grant = (principalId: string) => createReferenceGrant(db, { brain: BRAIN, principalId, repositoryPrefix: "https://github.com/odysseus",
  credential: "BRAIN_UI_SYNC_GITHUB_TOKEN", createdBy: principalId, now: Date.now() });

function service(options: { coverage?: false } = {}) {
  const tips = new Map([[PUBLIC, "1".repeat(40)], [PRIVATE, "2".repeat(40)]]);
  const state = { unavailable: false, privateIsPublic: false, covered: [] as { turnId: string; worktreeId: string }[] };
  const transport: ReferenceTransport = {
    async resolve({ repository, token }) {
      if (state.unavailable) return { ok: false, reason: "unavailable", detail: "fixture network unavailable" };
      const tip = tips.get(repository.canonical);
      if (!tip || (repository.canonical === PRIVATE && token !== TOKEN && !state.privateIsPublic)) return { ok: false, reason: "denied", detail: "fatal: repository not found" };
      return { ok: true, commit: tip, ref: "refs/heads/main" };
    },
    async fetch({ repository, root: target }) {
      writeFileSync(join(target, "README.md"), `${repository.canonical}\n`);
      writeFileSync(join(target, "odyssey.md"), "Sing, Muse, of the man of many ways.\n");
      return { commit: tips.get(repository.canonical)! };
    },
    async checkout() {},
  };
  const pool = referencePoolDouble(join(root, "pool"));
  const sources = createReferenceSources({ db, pool, transport, brain: BRAIN, credentials: { BRAIN_UI_SYNC_GITHUB_TOKEN: TOKEN }, now: () => clock,
    dependents: rootId => referenceWorktreeDependents(db, rootId) });
  const order: string[] = [];
  const access = pool.poolAccess;
  pool.poolAccess = async (id, generation, signal) => { order.push(`access:${id}`); return access(id, generation, signal); };
  const worktrees = createReferenceWorktrees({ db, pool, sources, now: () => clock,
    ...(options.coverage === false ? {} : { coverage: async (input: { turnId: string; worktreeId: string }) => { order.push(`cover:${input.worktreeId}`); state.covered.push(input); } }) });
  const path = (id: string) => pool.records.get(id)!.path!;
  return { pool, sources, worktrees, state, order, path, transport };
}
const days = (count: number) => { clock += count * DAY * 1000; };

/** A generation row owned by someone else, to exercise liveness evidence. */
function foreignGeneration(principalId: string, change: Partial<{ owner_pid: number; owner_start: string; owner_boot: string; owner_pid_namespace: string }>) {
  const self = referenceWorktreeOwner(), id = crypto.randomUUID();
  db.query(`INSERT INTO reference_worktree_generations (id, principal_id, turn_id, profile, path, owner_pid, owner_start, owner_boot, owner_pid_namespace, opened_at)
    VALUES (?, ?, 'turn-elsewhere', 'governed', '/nonexistent', ?, ?, ?, ?, ?)`)
    .run(id, principalId, change.owner_pid ?? self.pid, change.owner_start ?? self.start, change.owner_boot ?? self.boot, change.owner_pid_namespace ?? self.pidNamespace, clock);
  return id;
}

describe("allocation", () => {
  test("a worktree starts at the authorized source commit, with writable files isolated from the shared source", async () => {
    const { worktrees, pool, path } = service();
    const penelope = owner();
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    expect(tree, "REFERENCE_WORKTREE_ALLOCATED_FROM_AUTHORIZED_COMMIT").toMatchObject({ domain: "public", repository: PUBLIC, revision: "main", commit: "1".repeat(40),
      state: "active", generation: null, cleanup: null, expiresAt: tree.accessedAt + REFERENCE_WORKTREE_INACTIVITY_MS });
    const record = pool.records.get(tree.id)!;
    expect(record, "REFERENCE_WORKTREE_IS_A_SNAPSHOT_OF_SOURCE").toMatchObject({ purpose: "worktree", state: "writable" });
    expect(pool.records.get(record.from!)?.purpose).toBe("source");
    expect(readFileSync(join(path(tree.id), "odyssey.md"), "utf8")).toBe("Sing, Muse, of the man of many ways.\n");
    const baseline = [...pool.records.values()].find(item => item.purpose === "checkpoint" && item.from === tree.id);
    expect(baseline?.state, "REFERENCE_WORKTREE_BASELINE_CHECKPOINT").toBe("sealed");
    expect(referenceWorktreeDependents(db, record.from!), "REFERENCE_WORKTREE_PROTECTS_ITS_SOURCE_ROOT").toBe(true);
  });

  test("private source needs a live grant, and its worktree stays private to its principal", async () => {
    const { worktrees } = service();
    const penelope = owner(), telemachus = owner("Telemachus");
    await expect(worktrees.allocate({ principalId: penelope.id, repository: PRIVATE, revision: "main" }), "REFERENCE_WORKTREE_PRIVATE_NEEDS_GRANT")
      .rejects.toMatchObject({ code: "unauthorized" });
    grant(penelope.id);
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PRIVATE, revision: "main" });
    expect(tree.domain).toBe("private");
    expect(() => worktrees.get({ worktreeId: tree.id, principalId: telemachus.id }), "REFERENCE_WORKTREE_INVISIBLE_TO_OTHER_PRINCIPALS").toThrow("No managed worktree");
    expect(worktrees.list(telemachus.id)).toEqual([]);
  });
});

describe("access", () => {
  test("only an open generation of the owning principal receives a grant, after journal coverage", async () => {
    const { worktrees, order, pool } = service();
    const penelope = owner(), telemachus = owner("Telemachus");
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const mine = await worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    const theirs = await worktrees.openGeneration({ principalId: telemachus.id, turnId: "turn-2", profile: "governed" });
    await expect(worktrees.access({ worktreeId: tree.id, principalId: telemachus.id, generation: theirs.id }), "REFERENCE_WORKTREE_OTHER_PRINCIPAL_CANNOT_ACCESS")
      .rejects.toMatchObject({ code: "missing" });
    await expect(worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: theirs.id }), "REFERENCE_WORKTREE_WRONG_PRINCIPAL_GENERATION")
      .rejects.toMatchObject({ code: "unauthorized" });
    const granted = await worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: mine.id });
    expect(granted.generation).toBe(mine.id);
    expect(order, "REFERENCE_WORKTREE_COVERAGE_BEFORE_ACCESS").toEqual([`cover:${tree.id}`, `access:${tree.id}`]);
    expect(pool.records.get(tree.id)?.access).toBe(mine.id);
    expect(existsSync(join(mine.path, tree.id, "odyssey.md")), "REFERENCE_WORKTREE_IN_ITS_GENERATION").toBe(true);
  });

  test("a stale or reused generation cannot take or keep a grant", async () => {
    const { worktrees } = service();
    const penelope = owner();
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const first = await worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    const second = await worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-2", profile: "strict" });
    await worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: first.id });
    await expect(worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: second.id }), "REFERENCE_WORKTREE_NO_CROSS_GENERATION")
      .rejects.toMatchObject({ code: "busy" });
    await worktrees.closeGeneration(first.id);
    await expect(worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: first.id }), "REFERENCE_WORKTREE_STALE_GENERATION_REFUSED")
      .rejects.toMatchObject({ code: "unavailable" });
    const resumed = await worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: second.id });
    expect(resumed.generation, "REFERENCE_WORKTREE_RESUMED_BY_THE_NEXT_GENERATION").toBe(second.id);
    await expect(worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-3", profile: "restricted" as never }), "REFERENCE_WORKTREE_NOT_FOR_RESTRICTED")
      .rejects.toMatchObject({ code: "invalid" });
  });

  test("without journal coverage no worker can reach a worktree", async () => {
    const { worktrees, pool } = service({ coverage: false });
    const penelope = owner();
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const generation = await worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    await expect(worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: generation.id }), "REFERENCE_WORKTREE_NO_ACCESS_WITHOUT_JOURNAL")
      .rejects.toMatchObject({ code: "unavailable" });
    expect(pool.records.get(tree.id)?.access).toBeNull();
  });

  test("revoked or unverifiable authority refuses new access; a cached identity grants nothing", async () => {
    const { worktrees, state } = service();
    const penelope = owner(), issued = grant(penelope.id);
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PRIVATE, revision: "main" });
    const generation = await worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    expect(revokeReferenceGrant(db, { brain: BRAIN, id: issued.id, principalId: penelope.id, now: Date.now() })).not.toBeNull();
    await expect(worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: generation.id }), "REFERENCE_WORKTREE_REVOCATION_BLOCKS_ACCESS")
      .rejects.toMatchObject({ code: "unauthorized" });
    const publicTree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    clock += 10 * 60_000; state.unavailable = true;
    await expect(worktrees.access({ worktreeId: publicTree.id, principalId: penelope.id, generation: generation.id }), "REFERENCE_WORKTREE_EXPIRED_AUTHORITY_REFUSES")
      .rejects.toMatchObject({ code: "unavailable" });
    expect(state.covered, "REFERENCE_WORKTREE_REFUSED_ACCESS_NEVER_COVERED").toEqual([]);
  });
});

describe("activity, expiry and cleanup facts", () => {
  test("only explicit access, resumption or renewal moves the inactivity clock", async () => {
    const { worktrees, path } = service();
    const penelope = owner();
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const generation = await worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    days(1);
    const accessed = await worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: generation.id });
    expect(accessed.accessedAt, "REFERENCE_WORKTREE_ACCESS_RENEWS").toBe(clock);
    days(1);
    // Reads, writes, listings and background reconciliation are not activity.
    writeFileSync(join(path(tree.id), "odyssey.md"), "The suitors feast.\n");
    readFileSync(join(path(tree.id), "README.md"));
    worktrees.list(penelope.id); worktrees.get({ worktreeId: tree.id, principalId: penelope.id });
    await worktrees.reconcile();
    expect(worktrees.get({ worktreeId: tree.id, principalId: penelope.id }).accessedAt, "REFERENCE_WORKTREE_IMPLICIT_ACTIVITY_DOES_NOT_RENEW").toBe(accessed.accessedAt);
    days(1);
    const renewed = await worktrees.renew({ worktreeId: tree.id, principalId: penelope.id });
    expect(renewed.accessedAt, "REFERENCE_WORKTREE_RENEWAL_RENEWS").toBe(clock);
  });

  test("an expired worktree held by a running worker stays protected", async () => {
    const { worktrees, pool } = service();
    const penelope = owner();
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const generation = await worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    await worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: generation.id });
    days(4);
    const result = await worktrees.reconcile();
    expect(worktrees.get({ worktreeId: tree.id, principalId: penelope.id }), "REFERENCE_WORKTREE_ACTIVE_HOLDER_PROTECTED_PAST_EXPIRY")
      .toMatchObject({ state: "active", generation: generation.id, cleanup: null });
    expect(result.retained).toContain(tree.id);
    expect(pool.records.get(tree.id)?.access).toBe(generation.id);
  });

  test("a holder proven gone is recovered; unknown liveness keeps ownership and its charge", async () => {
    const { worktrees, pool } = service();
    const penelope = owner();
    const gone = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const unknown = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const dead = foreignGeneration(penelope.id, { owner_pid: 4_194_000, owner_start: "0" });
    const elsewhere = foreignGeneration(penelope.id, { owner_pid_namespace: "1" });
    for (const [tree, holder] of [[gone, dead], [unknown, elsewhere]] as const) {
      db.query("UPDATE reference_worktrees SET holder = ? WHERE id = ?").run(holder, tree.id);
      pool.records.get(tree.id)!.access = holder; // As if that generation had been granted it.
    }
    pool.poolPark = async id => { const record = pool.records.get(id)!; record.access = null; return record; };
    days(4);
    const result = await worktrees.reconcile();
    expect(worktrees.get({ worktreeId: unknown.id, principalId: penelope.id }), "REFERENCE_WORKTREE_UNKNOWN_LIVENESS_RETAINED")
      .toMatchObject({ state: "expired", generation: elsewhere, cleanup: { owner: "unknown", eligible: false } });
    expect(pool.records.get(unknown.id), "REFERENCE_WORKTREE_UNKNOWN_LIVENESS_STAYS_CHARGED").toMatchObject({ state: "writable", access: elsewhere });
    expect(result.recovered, "REFERENCE_WORKTREE_DEAD_HOLDER_RECOVERED").toEqual([gone.id]);
    expect(worktrees.get({ worktreeId: gone.id, principalId: penelope.id })).toMatchObject({ state: "expired", generation: null, cleanup: { owner: "none", reason: "expired" } });
  });

  test("release and expiry retain unpreserved work and remove only a positively clean worktree", async () => {
    const { worktrees, pool, path } = service();
    const penelope = owner();
    const clean = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const edited = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const added = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const idle = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    writeFileSync(join(path(edited.id), "odyssey.md"), "Penelope unweaves the shroud.\n");
    writeFileSync(join(path(added.id), "telemachus.md"), "A new voyage.\n");
    const released = await worktrees.release({ worktreeId: edited.id, principalId: penelope.id });
    expect(released.cleanup, "REFERENCE_WORKTREE_UNPRESERVED_RETAINED").toMatchObject({ reason: "released", owner: "none", work: "unpreserved", changedPaths: 1,
      sample: ["odyssey.md"], eligible: false });
    // An expired worktree resumed before its reconciliation is not removed.
    const generation = await worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    days(4);
    await worktrees.access({ worktreeId: idle.id, principalId: penelope.id, generation: generation.id });
    await worktrees.reconcile();
    expect(worktrees.get({ worktreeId: clean.id, principalId: penelope.id }).cleanup, "REFERENCE_WORKTREE_CLEAN_ELIGIBLE")
      .toMatchObject({ reason: "expired", owner: "none", work: "none", changedPaths: 0, eligible: true });
    expect(pool.records.get(clean.id)?.state, "REFERENCE_WORKTREE_CLEAN_REMOVED").toBe("reclaimed");
    expect(db.query("SELECT state, trigger FROM reference_worktree_cleanups WHERE worktree_id = ?").get(clean.id), "REFERENCE_WORKTREE_REMOVAL_RECEIPT")
      .toEqual({ state: "reclaimed", trigger: "automatic" });
    expect(worktrees.get({ worktreeId: added.id, principalId: penelope.id }).cleanup, "REFERENCE_WORKTREE_NEW_FILE_IS_WORK")
      .toMatchObject({ work: "unpreserved", sample: ["telemachus.md"], eligible: false });
    for (const tree of [edited, added, idle]) expect(pool.records.get(tree.id)?.state, "REFERENCE_WORKTREE_WORK_NEVER_DELETED").toBe("writable");
    expect([...pool.records.values()].filter(record => record.purpose === "checkpoint" && record.state === "sealed").map(record => record.from).sort(),
      "REFERENCE_WORKTREE_ONLY_BASELINES_REMAIN").toEqual([edited.id, added.id, idle.id].sort());
    await expect(worktrees.access({ worktreeId: edited.id, principalId: penelope.id, generation: generation.id }), "REFERENCE_WORKTREE_RELEASE_IS_FINAL")
      .rejects.toMatchObject({ code: "released" });
    await expect(worktrees.access({ worktreeId: clean.id, principalId: penelope.id, generation: generation.id }), "REFERENCE_WORKTREE_REMOVED_NEVER_RESUMED")
      .rejects.toMatchObject({ code: "released" });
    expect(referenceWorktreeDependents(db, pool.records.get(clean.id)!.from!), "REFERENCE_WORKTREE_SOURCE_STILL_SHARED_BY_OTHERS").toBe(true);
  });

  test("a release while a worker holds the worktree is assessed when its generation closes", async () => {
    const { worktrees, pool } = service();
    const penelope = owner();
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const generation = await worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    await worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: generation.id });
    const released = await worktrees.release({ worktreeId: tree.id, principalId: penelope.id });
    expect(released, "REFERENCE_WORKTREE_RELEASE_WAITS_FOR_ITS_WORKER").toMatchObject({ state: "released", generation: generation.id, cleanup: null });
    expect(pool.records.get(tree.id)?.access).toBe(generation.id);
    await worktrees.closeGeneration(generation.id);
    expect(worktrees.get({ worktreeId: tree.id, principalId: penelope.id }), "REFERENCE_WORKTREE_ASSESSED_AFTER_CLOSE")
      .toMatchObject({ generation: null, cleanup: { reason: "released", owner: "none", work: "none", eligible: true } });
    expect(pool.records.get(tree.id)?.access).toBeNull();
  });
});

describe("recovery", () => {
  test("restart discards unfinished allocations and closes generations whose owner is gone", async () => {
    const first = service();
    const penelope = owner();
    const tree = await first.worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    db.query(`INSERT INTO reference_worktrees (id, principal_id, domain, repository, revision, base_commit, source_root, baseline, allowance, state, created_at, accessed_at)
      VALUES ('11111111-1111-4111-8111-111111112430', ?, 'public', ?, 'main', NULL, ?, NULL, 4096, 'creating', ?, ?)`).run(penelope.id, PUBLIC, first.pool.records.get(tree.id)!.from, clock, clock);
    // A generation of an owner that is gone still holds the worktree.
    const dead = foreignGeneration(penelope.id, { owner_pid: 4_194_001, owner_start: "0" });
    await first.pool.poolAccessOpen(dead);
    await first.pool.poolAccess(tree.id, dead);
    db.query("UPDATE reference_worktrees SET holder = ? WHERE id = ?").run(dead, tree.id);
    const live = await first.worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-running", profile: "governed" });
    const next = createReferenceWorktrees({ db, pool: first.pool, sources: first.sources, now: () => clock, coverage: async () => {} });
    const recovered = await next.recover();
    expect(recovered, "REFERENCE_WORKTREE_RECOVERY").toMatchObject({ discarded: ["11111111-1111-4111-8111-111111112430"], closed: [dead] });
    expect(recovered.retained, "REFERENCE_WORKTREE_LIVENESS_PROCESS_WIDE").toContain(live.id);
    expect(first.pool.records.get(tree.id)?.access, "REFERENCE_WORKTREE_ABANDONED_GENERATION_PARKED").toBeNull();
    expect(next.get({ worktreeId: tree.id, principalId: penelope.id })).toMatchObject({ state: "active", generation: null });
  });

  test("source recovery and eviction keep a root that worktrees depend on", async () => {
    const { worktrees, sources, pool } = service();
    const penelope = owner();
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const source = pool.records.get(tree.id)!.from!;
    db.query("DELETE FROM reference_sources").run();
    const recovered = await sources.recover();
    expect(recovered.retained, "REFERENCE_WORKTREE_SOURCE_KEPT_BY_RECOVERY").toContain(source);
    expect(pool.records.get(source)?.state).toBe("sealed");
  });
});

describe("review hardening", () => {
  test("a private worktree needs a live grant at every access, even when its branch became public", async () => {
    const { worktrees, state } = service();
    const penelope = owner(), issued = grant(penelope.id);
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PRIVATE, revision: "main" });
    const generation = await worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    expect(revokeReferenceGrant(db, { brain: BRAIN, id: issued.id, principalId: penelope.id, now: Date.now() })).not.toBeNull();
    state.privateIsPublic = true; clock += 10 * 60_000;
    await expect(worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: generation.id }), "REFERENCE_WORKTREE_PRIVATE_ACCESS_NEEDS_LIVE_GRANT")
      .rejects.toMatchObject({ code: "unauthorized" });
    expect(state.covered).toEqual([]);
  });

  test("retiring a generation drains a grant in flight and refuses new ones", async () => {
    const { worktrees, pool } = service();
    const penelope = owner();
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const other = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const generation = await worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const access = pool.poolAccess;
    pool.poolAccess = async (...args) => { await gate; return access(...args); };
    const granting = worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: generation.id });
    const closing = worktrees.closeGeneration(generation.id);
    await expect(worktrees.access({ worktreeId: other.id, principalId: penelope.id, generation: generation.id }), "REFERENCE_WORKTREE_RETIRED_REFUSES")
      .rejects.toMatchObject({ code: "unavailable" });
    release();
    const [granted, ended] = await Promise.allSettled([granting, closing]);
    // The grant completes before the close, which then parks it: never a holder naming a closed generation.
    expect({ granted: granted.status, ended: ended.status, holder: worktrees.get({ worktreeId: tree.id, principalId: penelope.id }).generation,
      pool: pool.records.get(tree.id)?.access }, "REFERENCE_WORKTREE_CLOSE_DRAINS_ACCESS").toEqual({ granted: "fulfilled", ended: "fulfilled", holder: null, pool: null });
  });

  test("another service instance in this process sees this process's running generations as live", async () => {
    const first = service();
    const penelope = owner();
    const tree = await first.worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const generation = await first.worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    await first.worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: generation.id });
    const second = createReferenceWorktrees({ db, pool: first.pool, sources: first.sources, now: () => clock, coverage: async () => {} });
    days(4);
    await second.reconcile();
    expect(second.get({ worktreeId: tree.id, principalId: penelope.id }), "REFERENCE_WORKTREE_SECOND_INSTANCE_KEEPS_LIVE_HOLDER").toMatchObject({ state: "active", generation: generation.id });
  });

  test("assessment checkpoints are owned while they exist and forgotten once released", async () => {
    const { worktrees, path } = service();
    const penelope = owner();
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    writeFileSync(join(path(tree.id), "odyssey.md"), "Changed.\n");
    await worktrees.release({ worktreeId: tree.id, principalId: penelope.id });
    expect(db.query("SELECT count(*) AS n FROM reference_worktree_checkpoints").get(), "REFERENCE_WORKTREE_ASSESSMENT_CHECKPOINT_UNRECORDED").toEqual({ n: 0 });
  });
});

describe("re-review hardening", () => {
  test("a grant revoked while revalidation awaits refuses the access", async () => {
    const base = service();
    const penelope = owner(), issued = grant(penelope.id);
    const tree = await base.worktrees.allocate({ principalId: penelope.id, repository: PRIVATE, revision: "main" });
    base.state.privateIsPublic = true; clock += 10 * 60_000;
    // The revision now resolves publicly; the grant is revoked while that check is in flight.
    const racing = { covers: base.sources.covers, request: async (input: Parameters<typeof base.sources.request>[0]) => {
      revokeReferenceGrant(db, { brain: BRAIN, id: issued.id, principalId: penelope.id, now: Date.now() });
      return base.sources.request(input);
    } };
    const worktrees = createReferenceWorktrees({ db, pool: base.pool, sources: racing, now: () => clock, coverage: async () => {} });
    const generation = await worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    await expect(worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: generation.id }), "REFERENCE_WORKTREE_REVOCATION_DURING_REVALIDATION")
      .rejects.toMatchObject({ code: "unauthorized" });
    expect(base.pool.records.get(tree.id)?.access).toBeNull();
  });

  test("an assessment checkpoint whose creation reply was lost is still released", async () => {
    const { worktrees, pool, path } = service();
    const penelope = owner();
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    writeFileSync(join(path(tree.id), "odyssey.md"), "Changed.\n");
    const checkpoint = pool.poolCheckpoint;
    let lost: string | undefined;
    pool.poolCheckpoint = async (id, from, signal) => {
      const record = await checkpoint(id, from, signal);
      if (!lost && pool.records.get(id) && db.query("SELECT 1 FROM reference_worktree_checkpoints WHERE id = ?").get(id)) { lost = id; throw Error("reply lost"); }
      return record;
    };
    const released = await worktrees.release({ worktreeId: tree.id, principalId: penelope.id });
    expect(released.cleanup?.work).toBe("unknown");
    expect({ ledger: db.query("SELECT count(*) AS n FROM reference_worktree_checkpoints").get(), state: pool.records.get(lost!)?.state },
      "REFERENCE_WORKTREE_LOST_ASSESSMENT_REPLY_RELEASED").toEqual({ ledger: { n: 0 }, state: "reclaimed" });
  });

  test("a closed service's generations are over for the next instance", async () => {
    const first = service();
    const penelope = owner();
    const tree = await first.worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const generation = await first.worktrees.openGeneration({ principalId: penelope.id, turnId: "turn-1", profile: "governed" });
    await first.worktrees.access({ worktreeId: tree.id, principalId: penelope.id, generation: generation.id });
    await first.worktrees.close();
    const next = createReferenceWorktrees({ db, pool: first.pool, sources: first.sources, now: () => clock, coverage: async () => {} });
    const recovered = await next.recover();
    expect(recovered.closed, "REFERENCE_WORKTREE_CLOSED_SERVICE_GENERATIONS_ENDED").toContain(generation.id);
    expect(first.pool.records.get(tree.id)?.access).toBeNull();
  });
});

test("recovery releases only checkpoints whose owning process provably ended", async () => {
  const { worktrees, pool } = service();
  const penelope = owner();
  const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
  const self = referenceWorktreeOwner();
  const take = async (change: Partial<typeof self>) => {
    const id = crypto.randomUUID();
    recordReferenceWorktreeCheckpoint(db, { ...self, ...change }, id, tree.id);
    await pool.poolCheckpoint(id, tree.id);
    return id;
  };
  const ended = await take({ pid: 4_194_002, start: "0" }), otherBoot = await take({ boot: "00000000-0000-4000-8000-000000000000" });
  const unknown = await take({ pidNamespace: "1" }), mine = await take({});
  const recovered = await worktrees.recover();
  const sealed = (id: string) => pool.records.get(id)?.state === "sealed";
  expect({ ended: sealed(ended), otherBoot: sealed(otherBoot), unknown: sealed(unknown), mine: sealed(mine) }, "REFERENCE_WORKTREE_RECOVERY_RELEASES_ONLY_ENDED_OWNERS")
    .toEqual({ ended: false, otherBoot: false, unknown: true, mine: true });
  expect(recovered.retained).toEqual(expect.arrayContaining([unknown, mine]));
  expect((db.query("SELECT id FROM reference_worktree_checkpoints ORDER BY id").all() as { id: string }[]).map(row => row.id).sort()).toEqual([unknown, mine].sort());
});


describe("changing pool release assessment", () => {
  for (const edited of [true, false]) test(`${edited ? "edited" : "clean"} release keeps unknown work until explicit same-ID reassessment`, async () => {
    const { worktrees, pool, path, transport } = service(), penelope = owner();
    const fetch = transport.fetch;
    transport.fetch = async input => {
      const result = await fetch(input);
      mkdirSync(join(input.root, "odyssey/book-0"), { recursive: true });
      writeFileSync(join(input.root, "odyssey/book-0/line-0.md"), "Ithaca chart.\n");
      return result;
    };
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    if (edited) {
      writeFileSync(join(path(tree.id), "odyssey/book-0/line-0.md"), "Ithaca chart, corrected.\n");
      writeFileSync(join(path(tree.id), "odyssey/argos.md"), "Argos waits.\n");
    }
    const before = { record: structuredClone(pool.records.get(tree.id)!), row: worktrees.inventory().find(entry => entry.row.id === tree.id)!.row };
    const checkpoint = pool.poolCheckpoint;
    let fault: string | null = null;
    pool.poolCheckpoint = async (id, from, signal) => {
      // The assessment ledger distinguishes a fresh observation from replaying its baseline.
      if (!fault && from === tree.id && db.query("SELECT 1 FROM reference_worktree_checkpoints WHERE id = ?").get(id)) {
        fault = id; throw new NativeBrainManagerError("unavailable", CHANGING_POOL);
      }
      return checkpoint(id, from, signal);
    };
    const released = await worktrees.release({ worktreeId: tree.id, principalId: penelope.id });
    expect(fault, "REFERENCE_WORKTREE_CHANGING_POOL_FAULT_HIT").not.toBeNull();
    expect(released.cleanup, "REFERENCE_WORKTREE_CHANGING_POOL_DEFERS").toMatchObject({ reason: "released", owner: "none", work: "unknown",
      changedPaths: null, unverifiedPaths: null, sample: [], digest: null, eligible: false, error: CHANGING_POOL });
    await worktrees.reconcile();
    expect({ record: pool.records.get(tree.id), receipt: worktrees.inventory().find(entry => entry.row.id === tree.id)?.cleanup,
      ledger: db.query("SELECT count(*) AS n FROM reference_worktree_checkpoints").get(), fault: pool.records.get(fault!)?.state,
      sourceHeld: referenceWorktreeDependents(db, before.row.source_root) }, "REFERENCE_WORKTREE_CHANGING_POOL_RETAINED")
      .toEqual({ record: before.record, receipt: null, ledger: { n: 0 }, fault: "deleted", sourceHeld: true });
    const notes: { kind: string; facts: Record<string, unknown> }[] = [];
    const settled = await settledWorktreeRelease({ db, worktrees, records: async () => [...pool.records.values()],
      note: (kind, facts) => { notes.push({ kind, facts }); } }, before, released.cleanup, "REFERENCE_WORKTREE_CHANGING_POOL");
    expect(settled, "REFERENCE_WORKTREE_CHANGING_POOL_REASSESSED").toMatchObject(edited
      ? { owner: "none", work: "unpreserved", changedPaths: 3, unverifiedPaths: 0, sample: ["odyssey", "odyssey/argos.md", "odyssey/book-0/line-0.md"], eligible: false, error: null }
      : { owner: "none", work: "none", changedPaths: 0, unverifiedPaths: 0, sample: [], eligible: true, error: null });
    expect(pool.records.get(tree.id), "REFERENCE_WORKTREE_CHANGING_POOL_PREVIEW_DOES_NOT_REMOVE").toEqual(before.record);
    expect(worktrees.inventory().find(entry => entry.row.id === tree.id)?.cleanup).toBeNull();
    expect(notes.map(note => note.kind), "REFERENCE_WORKTREE_CHANGING_POOL_RECEIPTS").toEqual(["worktree-release-assessed", "worktree-release-deferred", "worktree-release-reassessed"]);
    await worktrees.reconcile();
    expect(pool.records.get(tree.id)?.state, "REFERENCE_WORKTREE_CHANGING_POOL_ORIGINAL_CLEANUP").toBe(edited ? "writable" : "reclaimed");
  });

  for (const changing of [false, true]) test(`${changing ? "persistent changing" : "other refusal"} fails and retains the worktree`, async () => {
    const { worktrees, pool } = service(), penelope = owner();
    const tree = await worktrees.allocate({ principalId: penelope.id, repository: PUBLIC, revision: "main" });
    const before = { record: structuredClone(pool.records.get(tree.id)!), row: worktrees.inventory().find(entry => entry.row.id === tree.id)!.row };
    const checkpoint = pool.poolCheckpoint;
    let attempts = 0;
    pool.poolCheckpoint = async (id, from, signal) => {
      if (from === tree.id && db.query("SELECT 1 FROM reference_worktree_checkpoints WHERE id = ?").get(id)) {
        attempts++; throw new NativeBrainManagerError("unavailable", changing ? CHANGING_POOL : "The pool is unavailable for another reason.");
      }
      return checkpoint(id, from, signal);
    };
    const released = await worktrees.release({ worktreeId: tree.id, principalId: penelope.id });
    const notes: string[] = [];
    await expect(settledWorktreeRelease({ db, worktrees, records: async () => [...pool.records.values()], note: kind => { notes.push(kind); } },
      before, released.cleanup, "REFERENCE_WORKTREE_CHANGING_POOL_NEGATIVE"), "REFERENCE_WORKTREE_CHANGING_POOL_NEGATIVE_FAILS")
      .rejects.toThrow(changing ? "REFERENCE_WORKTREE_CHANGING_POOL_NEGATIVE_REASSESS_BOUND" : "REFERENCE_WORKTREE_CHANGING_POOL_NEGATIVE_DEFERRED_TRUTHFULLY");
    expect(attempts, "REFERENCE_WORKTREE_CHANGING_POOL_BOUNDED_OPERATIONS").toBe(changing ? 4 : 1);
    expect(notes.filter(kind => kind === "worktree-release-deferred").length, "REFERENCE_WORKTREE_CHANGING_POOL_EVERY_DEFERRAL_RECEIPTED").toBe(attempts);
    expect(pool.records.get(tree.id), "REFERENCE_WORKTREE_CHANGING_POOL_NEGATIVE_RETAINED").toEqual(before.record);
    expect(worktrees.inventory().find(entry => entry.row.id === tree.id)?.cleanup).toBeNull();
    expect(db.query("SELECT count(*) AS n FROM reference_worktree_checkpoints").get()).toEqual({ n: 0 });
  });
});

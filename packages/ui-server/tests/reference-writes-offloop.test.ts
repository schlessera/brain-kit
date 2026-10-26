import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { JOURNAL_SCHEMA, journalDatabasePath } from "../src/db/journal-database.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { registerReferenceWrites } from "../src/brain/reference-writes.js";
import { createReferenceSources } from "../src/brain/reference-source.js";
import { createReferenceTools } from "../src/brain/reference-tools.js";
import type { ReferenceTransport } from "../src/brain/reference-transport.js";
import { createReferenceWorktrees, forgetReferenceWorktreeCheckpoint, recordReferenceWorktreeCheckpoint,
  referenceWorktreeDependents, referenceWorktreeOwner } from "../src/brain/reference-worktrees.js";
import { referenceWorktreeJournalManager } from "../src/brain/reference-worktree-journal.js";
import { createReferenceWorktreeHygiene } from "../src/brain/reference-worktree-hygiene.js";
import { referencePoolDouble } from "./helpers/reference-pool-double.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { createReferenceGrant } from "../src/db/reference-grants.js";
import { watchWriteSites } from "./helpers/write-sites.js";
import * as probe from "./fixtures/write-worker-probe.js";

const AT = Date.parse("2026-07-12T12:00:00Z");
const REPOSITORY = "https://github.com/odysseus/ithaca", PRINCIPAL = "penelope";
const TABLES = ["reference_views", "reference_sources", "reference_roots", "reference_worktrees",
  "reference_worktree_checkpoints", "reference_worktree_generations", "reference_worktree_cleanups", "reference_worktree_findings"];

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "reference-writes-odysseus-"));
  const path = join(root, "ui.db"), db = createUiDb(path);
  db.query("INSERT INTO principals (id, kind, auth_method, label, created_at, expires_at) VALUES (?, 'owner', 'password', 'Penelope', ?, ?)")
    .run(PRINCIPAL, AT, AT + 86_400_000);
  createReferenceGrant(db, { brain: "ithaca-brain", principalId: PRINCIPAL, repositoryPrefix: "https://github.com/odysseus",
    credential: "BRAIN_UI_SYNC_GITHUB_TOKEN", createdBy: PRINCIPAL, now: AT });
  const writer = openSqliteWriter(db, { attach: [{ schema: JOURNAL_SCHEMA, path: journalDatabasePath(path) }] });
  registerReferenceWrites(db, writer);
  const sites = await watchWriteSites(db, writer, TABLES);
  const held = writer.channel(probe, { table: "odysseus_log" }); await held.ready;
  let clock = AT;
  const state = { tip: "1".repeat(40), unavailable: false, private: false };
  const transport: ReferenceTransport = {
    async resolve({ token }) { return state.private && !token ? { ok: false, reason: "denied", detail: "The loom is private" }
      : state.unavailable ? { ok: false, reason: "unavailable", detail: "Poseidon delays the voyage" }
      : { ok: true, commit: state.tip, ref: "refs/heads/main" }; },
    async fetch({ root }) { writeFileSync(join(root, "odyssey.md"), "Sing, Muse.\n"); return { commit: state.tip }; },
    async checkout() {},
  };
  const pool = referencePoolDouble(join(root, "pool"));
  const sources = createReferenceSources({ db, pool, transport, brain: "ithaca-brain", credentials: { BRAIN_UI_SYNC_GITHUB_TOKEN: "fixture-reference-token" }, now: () => clock,
    limits: { refreshMs: 60_000 },
    dependents: id => referenceWorktreeDependents(db, id) });
  const worktrees = createReferenceWorktrees({ db, pool, sources, now: () => clock, coverage: async () => {} });
  const tools = createReferenceTools({ sources, worktrees });
  const allocate = () => worktrees.allocate({ principalId: PRINCIPAL, repository: REPOSITORY, revision: "main" });
  const request = () => sources.request({ principalId: PRINCIPAL, repository: REPOSITORY, revision: "main" });
  const read = (id: string) => worktrees.get({ worktreeId: id, principalId: PRINCIPAL });
  const owner = referenceWorktreeOwner();
  const unsupported = async () => { throw Error("The pool double has no fixed worker-UID reader."); };
  const manager = (id: string) => referenceWorktreeJournalManager({ ...pool,
    poolReadCheckpoint: unsupported, poolStatCheckpoint: unsupported, poolListCheckpoint: unsupported }, id, {
    record: (checkpoint, worktree) => recordReferenceWorktreeCheckpoint(db, owner, checkpoint, worktree, clock),
    forget: checkpoint => forgetReferenceWorktreeCheckpoint(db, checkpoint),
  });
  return { root, db, writer, sites, held, state, pool, sources, worktrees, tools, allocate, request, read, manager,
    advance(ms = 1000) { clock += ms; return clock; },
    async close() {
      tools.end("voyage");
      await worktrees.close(); await sources.close(); await writer.close();
      db.close(); rmSync(root, { recursive: true, force: true });
    } };
}

/** Observe an earlier held worker without occupying the app loop. */
async function pending<T>(work: Promise<T>, label: string) {
  let finished = false;
  void work.then(() => { finished = true; }, () => { finished = true; });
  await Bun.sleep(30);
  expect(finished, label).toBe(false);
}

/** Stop at the real operation's refusal, rather than time out waiting for an unreachable pool call. */
async function reached(condition: () => boolean, work: Promise<unknown>) {
  let finished = false, failure: unknown;
  void work.then(() => { finished = true; }, error => { finished = true; failure = error; });
  const deadline = performance.now() + 5000;
  while (!condition() && !finished && performance.now() < deadline) await Bun.sleep(1);
  if (failure) throw failure;
  expect(condition(), "REFERENCE_OPERATION_REACHED_POOL_BOUNDARY").toBe(true);
}

// This is the manager the journal's attachWorktree and scope observation call.
test("reference checkpoint observation and release await FULL worker commits without blocking the loop", async () => {
  const f = await fixture();
  try {
    const tree = await f.allocate(), manager = f.manager(tree.id);
    const checkpoint = crypto.randomUUID();
    const slow = f.held.call("slow", "Calypso holds the observation", 300);
    const observed = manager.checkpoint(checkpoint);
    await pending(observed, "REFERENCE_CHECKPOINT_LOOP_RUNS_WHILE_WORKER_HELD");
    expect(f.pool.records.has(checkpoint), "REFERENCE_CHECKPOINT_POOL_WAITS_FOR_LEDGER").toBe(false);
    expect(f.db.query("SELECT id FROM reference_worktree_checkpoints WHERE id = ?").get(checkpoint), "REFERENCE_CHECKPOINT_NOT_ON_APP_CONNECTION").toBeNull();
    await slow; await observed;
    expect(f.db.query("SELECT worktree_id FROM reference_worktree_checkpoints WHERE id = ?").get(checkpoint), "REFERENCE_CHECKPOINT_FULL_COMMIT_BEFORE_CREATION")
      .toEqual({ worktree_id: tree.id });
    const again = f.held.call("slow", "Calypso holds the release receipt", 300);
    const released = manager.release(checkpoint);
    await pending(released, "REFERENCE_CHECKPOINT_RELEASE_WAITS_FOR_FORGET_COMMIT");
    expect(f.pool.records.get(checkpoint)?.state).toBe("reclaimed");
    expect(f.db.query("SELECT id FROM reference_worktree_checkpoints WHERE id = ?").get(checkpoint)).not.toBeNull();
    await again; await released;
    expect(f.db.query("SELECT id FROM reference_worktree_checkpoints WHERE id = ?").get(checkpoint), "REFERENCE_CHECKPOINT_FORGOTTEN_BEFORE_RELEASE_RETURNS").toBeNull();
    expect((await f.sites.log()).filter(table => table === "reference_worktree_checkpoints"), "REFERENCE_CHECKPOINT_WRITES_ON_WORKER_AT_FULL")
      .toEqual(["reference_worktree_checkpoints", "reference_worktree_checkpoints"]);
  } finally { await f.close(); }
});

test("reference source requests, allocation, grants, renewal, release and generation boundaries commit on the worker at FULL", async () => {
  const f = await fixture();
  try {
    // Hold publication itself: request cannot answer with a merely staged source.
    const publish = f.pool.poolPublish;
    let publication: Promise<unknown> | undefined;
    f.pool.poolPublish = async (...args) => {
      const result = await publish(...args);
      publication = f.held.call("slow", "Calypso holds publication", 300);
      return result;
    };
    const requested = f.request();
    await reached(() => publication !== undefined, requested);
    await pending(requested, "REFERENCE_SOURCE_ANSWER_WAITS_FOR_PUBLICATION_COMMIT");
    expect(f.db.query("SELECT root_id FROM reference_sources").get()).toBeNull();
    const source = await requested;
    await publication; f.pool.poolPublish = publish;
    expect(f.db.query("SELECT root_id FROM reference_sources").get(), "REFERENCE_SOURCE_REQUEST_COMMITTED").toEqual({ root_id: source.rootId });
    source.release();
    // A cached lease still waits for its usage commit.
    f.advance();
    let slow = f.held.call("slow", "Calypso holds the source lease", 300);
    const leased = f.request();
    await pending(leased, "REFERENCE_SOURCE_LEASE_WAITS_FOR_USAGE_COMMIT");
    const lease = await leased; await slow; lease.release();
    expect(f.db.query("SELECT last_used_at FROM reference_sources").get()).toEqual({ last_used_at: AT + 1000 });

    slow = f.held.call("slow", "Calypso holds allocation", 300);
    const allocated = f.allocate();
    await pending(allocated, "REFERENCE_ALLOCATION_WAITS_FOR_COMMIT");
    const tree = await allocated; await slow;
    expect(f.read(tree.id).state, "REFERENCE_ALLOCATION_DURABLE").toBe("active");

    slow = f.held.call("slow", "Calypso holds generation open", 300);
    const opening = f.worktrees.openGeneration({ principalId: PRINCIPAL, turnId: "voyage", profile: "governed" });
    await pending(opening, "REFERENCE_GENERATION_NOT_BOUND_BEFORE_COMMIT");
    const generation = await opening; await slow;
    expect(f.db.query("SELECT closed_at FROM reference_worktree_generations WHERE id = ?").get(generation.id)).toEqual({ closed_at: null });
    await f.tools.begin("voyage", { principalId: PRINCIPAL, posture: "interactive", generation });
    // Hold the grant after the native move, before its durable holder record.
    const access = f.pool.poolAccess;
    let granting: Promise<unknown> | undefined;
    f.pool.poolAccess = async (...args) => { const result = await access(...args); granting = f.held.call("slow", "Calypso holds the grant", 300); return result; };
    const granted = f.tools.call("voyage", PRINCIPAL, { tool: "reference_worktree", input: { action: "access", worktreeId: tree.id } });
    await reached(() => granting !== undefined, granted);
    await pending(granted, "REFERENCE_TOOL_ANSWER_WAITS_FOR_GRANT_COMMIT");
    expect(f.read(tree.id).generation).toBeNull();
    expect(await granted, "REFERENCE_GRANT_ON_WORKER_AT_FULL").toMatchObject({ ok: true, action: "access", worktree: { id: tree.id } });
    await granting;
    expect(f.read(tree.id).generation).toBe(generation.id);

    const renewedAt = f.advance();
    slow = f.held.call("slow", "Calypso holds renewal", 300);
    const renewed = f.tools.call("voyage", PRINCIPAL, { tool: "reference_worktree", input: { action: "renew", worktreeId: tree.id } });
    await pending(renewed, "REFERENCE_TOOL_ANSWER_WAITS_FOR_RENEW_COMMIT");
    expect(f.read(tree.id).accessedAt).not.toBe(renewedAt);
    expect(await renewed, "REFERENCE_RENEW_ON_WORKER_AT_FULL").toMatchObject({ ok: true }); await slow;
    expect(f.read(tree.id).accessedAt).toBe(renewedAt);

    slow = f.held.call("slow", "Calypso holds release", 300);
    const released = f.worktrees.release({ worktreeId: tree.id, principalId: PRINCIPAL });
    await pending(released, "REFERENCE_RELEASE_EFFECTS_WAIT_FOR_COMMIT");
    expect(f.read(tree.id).state).toBe("active");
    expect((await released).state, "REFERENCE_RELEASE_ON_WORKER_AT_FULL").toBe("released"); await slow;
    // Keep work for hygiene so close tests no automatic deletion assumptions.
    writeFileSync(join(f.pool.records.get(tree.id)!.path!, "odyssey.md"), "Penelope unweaves the shroud.\n");
    slow = f.held.call("slow", "Calypso holds generation close", 300);
    const closing = f.worktrees.closeGeneration(generation.id);
    await pending(closing, "REFERENCE_GENERATION_CLOSE_WAITS_FOR_COMMIT");
    expect(f.read(tree.id).generation).toBe(generation.id);
    await closing; await slow;
    expect(f.read(tree.id), "REFERENCE_GENERATION_CLOSE_DURABLE").toMatchObject({ state: "released", generation: null });
    expect(f.db.query("SELECT closed_at FROM reference_worktree_generations WHERE id = ?").get(generation.id)).toEqual({ closed_at: renewedAt });
    expect(new Set(await f.sites.log()), "REFERENCE_LIFECYCLE_TABLES_ON_WORKER_AT_FULL").toEqual(new Set(TABLES.filter(table => !["reference_worktree_cleanups", "reference_worktree_findings"].includes(table))));
  } finally { await f.close(); }
});

test("an admitted renewal commits before the ended turn's release and generation close; a queued late renewal remains fenced", async () => {
  const f = await fixture();
  try {
    const tree = await f.allocate();
    const generation = await f.worktrees.openGeneration({ principalId: PRINCIPAL, turnId: "voyage", profile: "governed" });
    await f.worktrees.access({ worktreeId: tree.id, principalId: PRINCIPAL, generation: generation.id });
    writeFileSync(join(f.pool.records.get(tree.id)!.path!, "odyssey.md"), "Telemachus sets sail.\n");
    // Observe the actual callback from the tools' turn map, at the same serial location.
    let passed = false, checked!: () => void;
    const checkedLive = new Promise<void>(resolve => { checked = resolve; });
    const tools = createReferenceTools({ sources: f.sources, worktrees: { ...f.worktrees, renew(input) {
      return f.worktrees.renew({ ...input, live: () => { passed = input.live!(); checked(); return passed; } });
    } } });
    await tools.begin("voyage", { principalId: PRINCIPAL, posture: "interactive", generation });
    const renewedAt = f.advance();
    const slow = f.held.call("slow", "Calypso holds admitted renewal", 400);
    const renewal = tools.call("voyage", PRINCIPAL, { tool: "reference_worktree", input: { action: "renew", worktreeId: tree.id } });
    // A renewal that never consults its turn's lifetime fails here instead of hanging.
    let consulted = false;
    void checkedLive.then(() => { consulted = true; });
    await Promise.race([checkedLive, renewal, Bun.sleep(5000)]);
    expect(consulted, "REFERENCE_RENEW_CONSULTS_TURN_LIFETIME").toBe(true);
    expect(passed, "REFERENCE_RENEW_LIVE_PASSED_BEFORE_TURN_END").toBe(true);
    const late = tools.call("voyage", PRINCIPAL, { tool: "reference_worktree", input: { action: "renew", worktreeId: tree.id } });
    tools.end("voyage");
    const releasedAt = f.advance();
    const releasing = f.worktrees.release({ worktreeId: tree.id, principalId: PRINCIPAL });
    const closing = f.worktrees.closeGeneration(generation.id);
    await pending(releasing, "REFERENCE_END_RELEASE_QUEUED_BEHIND_ADMITTED_RENEWAL");
    expect(f.pool.events.some(event => event.operation === "access-close"), "REFERENCE_END_PARKING_QUEUED_BEHIND_ADMITTED_RENEWAL").toBe(false);
    expect(f.read(tree.id)).toMatchObject({ state: "active", accessedAt: AT, releasedAt: null, generation: generation.id });
    expect(await renewal, "REFERENCE_ADMITTED_RENEWAL_COMMITS").toMatchObject({ ok: true, worktree: { lastActivityAt: new Date(renewedAt).toISOString(), state: "active" } });
    expect(await late, "REFERENCE_TOOLS_ENDED_TURN_RENEW_FENCED").toMatchObject({ ok: false, code: "unavailable" });
    expect(await releasing, "REFERENCE_END_RELEASE_OBSERVES_PRIOR_RENEWAL").toMatchObject({ state: "released", accessedAt: renewedAt, releasedAt });
    await closing; await slow;
    expect(f.read(tree.id), "REFERENCE_RENEW_AND_END_EFFECTS_BOTH_RETAINED_IN_ORDER")
      .toMatchObject({ state: "released", accessedAt: renewedAt, releasedAt, generation: null });
  } finally { await f.close(); }
});

test("hygiene reconciliation, disposition and removal receipts commit on the reference worker", async () => {
  const f = await fixture();
  try {
    const tree = await f.allocate();
    writeFileSync(join(f.pool.records.get(tree.id)!.path!, "odyssey.md"), "Penelope keeps her work.\n");
    await f.worktrees.release({ worktreeId: tree.id, principalId: PRINCIPAL });
    const core = await import("@schlessera/brain/internal");
    const hygiene = createReferenceWorktreeHygiene({ db: f.db, worktrees: f.worktrees, core: async () => core, brainPath: f.root, now: () => AT });
    const [detected] = (await hygiene.reconcile()).values();
    expect(detected, "REFERENCE_HYGIENE_RECONCILE_ON_WORKER_AT_FULL").toBeDefined();
    const finding = detected!.finding;
    expect(await hygiene.run(["dismiss", "--expect-fingerprint", finding.fingerprint, "--", finding.id]), "REFERENCE_HYGIENE_DISPOSITION_ON_WORKER_AT_FULL")
      .toMatchObject({ status: "dismissed" });
    const outcome = await f.worktrees.remove(tree.id, { trigger: "review", premise: finding.fingerprint, expect: () => null });
    expect(outcome, "REFERENCE_REMOVAL_RECEIPT_ON_WORKER_AT_FULL").toEqual({ status: "reclaimed" });
    expect(await hygiene.run(["check", "--", finding.id]), "REFERENCE_HYGIENE_CHECK_ON_WORKER_AT_FULL").toMatchObject({ status: "not_detected" });
    expect(new Set(await f.sites.log()), "REFERENCE_ALL_TABLES_COMMIT_ON_WORKER_AT_FULL")
      .toEqual(new Set(TABLES.filter(table => table !== "reference_worktree_generations")));
    expect(f.db.query("SELECT state, resolved_by FROM reference_worktree_findings WHERE id = ?").get(finding.id)).toEqual({ state: "resolved", resolved_by: "check" });
  } finally { await f.close(); }
});

test("source refresh, failed-refresh bookkeeping, bind-time revalidation and superseded-root release use the worker", async () => {
  const f = await fixture();
  try {
    (await f.request()).release();
    const confirmedAt = f.advance(60_000);
    const confirmed = await f.request();
    expect(confirmed.validatedAt, "REFERENCE_SOURCE_SAME_COMMIT_VALIDATED_ON_WORKER").toBe(confirmedAt);
    confirmed.release();
    f.advance(60_000); f.state.unavailable = true;
    const stale = await f.request();
    expect(stale.stale, "REFERENCE_SOURCE_FAILED_REFRESH_COMMITTED_ON_WORKER").toBe(true);
    expect(f.db.query("SELECT last_error FROM reference_sources").get()).toEqual({ last_error: "Poseidon delays the voyage" });
    stale.release();
    f.state.unavailable = false;
    const validatedAt = f.advance(240_001);
    await f.sources.bindable(PRINCIPAL);
    expect(f.db.query("SELECT validated_at, last_error FROM reference_sources").get(), "REFERENCE_SOURCE_BIND_REVALIDATION_COMMITTED")
      .toEqual({ validated_at: validatedAt, last_error: null });
    f.advance(60_000); f.state.tip = "2".repeat(40);
    const replaced = await f.request();
    expect(replaced.commit, "REFERENCE_SOURCE_REFRESH_PUBLICATION_COMMITTED").toBe(f.state.tip);
    replaced.release();
    await f.writer.idle();
    expect(new Set(await f.sites.log()), "REFERENCE_SOURCE_CATALOG_WRITES_AT_FULL").toEqual(new Set(["reference_views", "reference_sources", "reference_roots"]));
  } finally { await f.close(); }
});

test("revocation sees a first private publication submitted before it and withdraws it after its commit", async () => {
  const f = await fixture();
  try {
    f.state.private = true;
    const publish = f.pool.poolPublish;
    let publication: Promise<unknown> | undefined;
    f.pool.poolPublish = async (...args) => {
      const result = await publish(...args);
      publication = f.held.call("slow", "Calypso holds private publication", 400);
      return result;
    };
    const requested = f.request().then(() => null, error => error as Error & { code: string });
    await reached(() => publication !== undefined, requested);
    await pending(requested, "REFERENCE_PRIVATE_PUBLICATION_STILL_PENDING");
    // Authority expires while its checked publication waits for the worker.
    f.advance(2 * 86_400_000);
    const revoking = f.sources.revoke({ grantIds: [], principalIds: [PRINCIPAL] });
    await pending(revoking, "REFERENCE_REVOCATION_WAITS_FOR_PENDING_PUBLICATION");
    expect((await requested)?.code, "REFERENCE_PRIVATE_REQUEST_REFUSES_ENDED_AUTHORITY").toBe("unauthorized");
    await revoking; await publication;
    expect(f.db.query("SELECT root_id FROM reference_sources WHERE root_id IS NOT NULL").all(), "REFERENCE_REVOCATION_WITHDRAWS_FIRST_PUBLICATION").toEqual([]);
    expect(f.db.query("SELECT id FROM reference_roots").all(), "REFERENCE_REVOKED_ROOT_RELEASE_COMMITTED").toEqual([]);
    expect(f.pool.events.some(event => event.operation === "unpublish"), "REFERENCE_REVOKED_SOURCE_UNPUBLISHED").toBe(true);
  } finally { await f.close(); }
});

test("the turn journal's attached worktree and scope observation ledger share the journal worker order", async () => {
  const f = await fixture();
  const brain = join(f.root, "brain");
  mkdirSync(join(brain, "workspaces", "argo"), { recursive: true });
  writeFileSync(join(brain, "workspaces", "argo", "log.md"), "Telemachus sets sail.\n");
  const native = createNativeJournalFixture(brain, join(f.root, "native"));
  const unsupported = async () => { throw Error("The pool double has no fixed worker-UID reader."); };
  const owner = referenceWorktreeOwner();
  const journal = createTurnJournal(f.db, { writer: f.writer, nativeManager: native.manager, brainPath: brain,
    dbPath: join(f.root, "ui.db"), objectsRoot: join(f.root, "objects"), now: () => AT,
    referencePool: { ...f.pool, poolReadCheckpoint: unsupported, poolStatCheckpoint: unsupported, poolListCheckpoint: unsupported },
    referenceCheckpoints: { record: (id, worktree) => recordReferenceWorktreeCheckpoint(f.db, owner, id, worktree, AT),
      forget: id => forgetReferenceWorktreeCheckpoint(f.db, id) } });
  try {
    await journal.ready;
    const tree = await f.allocate();
    await journal.begin("voyage", { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, () => {});
    await journal.attachWorktree("voyage", tree.id);
    const attached = (await f.sites.log()).filter(table => table === "reference_worktree_checkpoints").length;
    expect(attached, "REFERENCE_JOURNAL_ATTACH_CHECKPOINT_ON_WORKER_AT_FULL").toBeGreaterThan(0);
    const slow = f.held.call("slow", "Calypso holds scope observation", 300);
    // scopeTimer enters this same serialized observation path every 15 seconds.
    const observation = journal.observe();
    await pending(observation, "REFERENCE_JOURNAL_SCOPE_OBSERVATION_LEAVES_LOOP_RESPONSIVE");
    await observation; await slow;
    expect((await f.sites.log()).filter(table => table === "reference_worktree_checkpoints").length, "REFERENCE_JOURNAL_SCOPE_CHECKPOINT_ON_WORKER_AT_FULL")
      .toBeGreaterThan(attached);
    await journal.finish("voyage");
    expect(f.db.query("SELECT id FROM reference_worktree_checkpoints").all(), "REFERENCE_JOURNAL_FINISH_AWAITS_CHECKPOINT_RELEASES").toEqual([]);
  } finally { await journal.close(); await native.close(); await f.close(); }
});

test("failed allocation, expiry, reassessment and authorized removal retain their worker receipts", async () => {
  const f = await fixture();
  try {
    const checkpoint = f.pool.poolCheckpoint;
    f.pool.poolCheckpoint = async () => { throw Error("Scylla refuses the baseline"); };
    let failure: unknown;
    try { await f.allocate(); } catch (error) { failure = error; }
    expect(failure, "REFERENCE_FAILED_ALLOCATION_REFUSAL_KEPT").toMatchObject({ code: "unavailable" });
    expect(f.db.query("SELECT id FROM reference_worktrees WHERE state = 'creating'").all(), "REFERENCE_FAILED_ALLOCATION_DISCARD_COMMITS").toEqual([]);
    f.pool.poolCheckpoint = checkpoint;
    const tree = await f.allocate();
    writeFileSync(join(f.pool.records.get(tree.id)!.path!, "odyssey.md"), "Odysseus keeps the route.\n");
    f.advance(4 * 86_400_000);
    expect((await f.worktrees.reconcile()).expired, "REFERENCE_EXPIRY_ON_WORKER_AT_FULL").toContain(tree.id);
    expect(f.read(tree.id).state).toBe("expired");
    await f.worktrees.reassess(tree.id, { remove: false });
    const refused = await f.worktrees.remove(tree.id, { trigger: "review", premise: "Odysseus reviewed the route", expect: () => null,
      authorize() { throw Error("The review ended"); } });
    expect(refused, "REFERENCE_REMOVAL_AUTHORIZATION_STILL_FENCED").toEqual({ status: "refused", reason: "The review ended" });
    expect(f.db.query("SELECT worktree_id FROM reference_worktree_cleanups WHERE worktree_id = ?").get(tree.id)).toBeNull();
    let receipt: Promise<unknown> | undefined;
    const removing = f.worktrees.remove(tree.id, { trigger: "review", premise: "Odysseus reviewed the route", expect: () => null,
      authorize() { receipt = f.held.call("slow", "Calypso holds the authorized removal receipt", 300); } });
    await reached(() => receipt !== undefined, removing);
    await pending(removing, "REFERENCE_REMOVAL_WAITS_FOR_AUTHORIZED_RECEIPT");
    expect(f.pool.records.get(tree.id)?.state, "REFERENCE_REMOVAL_POOL_WAITS_FOR_RECEIPT").toBe("writable");
    expect(await removing, "REFERENCE_AUTHORIZED_REMOVAL_COMPLETES_ON_WORKER").toEqual({ status: "reclaimed" }); await receipt;
    expect(f.db.query("SELECT state FROM reference_worktree_cleanups WHERE worktree_id = ?").get(tree.id)).toEqual({ state: "reclaimed" });
    expect(f.db.query("SELECT baseline FROM reference_worktrees WHERE id = ?").get(tree.id), "REFERENCE_REMOVAL_FORGETS_BASELINE_AFTER_RELEASE").toEqual({ baseline: null });
  } finally { await f.close(); }
});

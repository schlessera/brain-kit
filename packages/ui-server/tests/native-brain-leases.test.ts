import { expect, test } from "bun:test";
import { expectRejection } from "./helpers/expect-rejection.js";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBrainLeaseManager } from "../src/brain/native-brain-leases.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { createNativeJournalObserver } from "../src/brain/native-journal-observer.js";
import { referenceWorktreeJournalManager, type ReferenceWorktreeCheckpointLedger } from "../src/brain/reference-worktree-journal.js";

const ID = "11111111-1111-4111-8111-111111111790", OTHER = "22222222-2222-4222-8222-222222221790";
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-leases-")), brain = join(root, "brain"), statePath = join(root, "native-leases.sqlite"); mkdirSync(brain);
  const native = createNativeJournalFixture(brain, root), ready = await native.client.ready();
  const options = { statePath, brainPath: brain, fsid: ready.fsid, brainUuid: ready.brainUuid };
  const owner = await createNativeBrainLeaseManager(native.client, options);
  const state = new Database(statePath);
  return { native, owner, options, state, root, async close() { await owner.close().catch(() => {}); state.close(); await native.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("native UUID ownership is durable before RPC and a second live generation cannot release its pins", async () => {
  const f = await fixture(), checkpoint = f.native.client.checkpoint;
  let beforeRpc: unknown;
  f.native.client.checkpoint = async (...args) => {
    beforeRpc = f.state.query("SELECT state FROM native_root_leases WHERE id=?").get(ID);
    return checkpoint(...args);
  };
  const second = await createNativeBrainLeaseManager(f.native.client, f.options);
  try {
    await f.owner.client.checkpoint(ID);
    expect(beforeRpc, "NATIVE_LEASE_DURABLE_BEFORE_CREATION_RPC").toEqual({ state: "creating" });
    await expectRejection(second.client.release(ID), "another live");
    await expectRejection(second.client.checkpoint(ID), "another live");
    expect(await second.recoverDeadOwners()).toMatchObject({ released: [], retainedLive: 1 });
    await second.close();
    expect(f.state.query("SELECT count(*) AS n FROM native_root_leases").get()).toEqual({ n: 1 });
    await f.owner.close();
    expect(f.state.query("SELECT count(*) AS n FROM native_root_leases").get()).toEqual({ n: 0 });
  } finally { await second.close().catch(() => {}); await f.close(); }
});

test("provably dead and reused PID owners recover same UUIDs while foreign PID views remain unverifiable", async () => {
  const f = await fixture();
  try {
    await f.owner.client.checkpoint(ID); await f.owner.client.checkpoint(OTHER);
    f.state.query("UPDATE native_root_leases SET owner_start=owner_start||'-reused' WHERE id=?").run(ID);
    f.state.query("UPDATE native_root_leases SET owner_pid_namespace='unverifiable-other-view' WHERE id=?").run(OTHER);
    const second = await createNativeBrainLeaseManager(f.native.client, f.options);
    try {
      expect(await second.recoverDeadOwners()).toMatchObject({ released: [ID], retainedUnverifiable: 1, unknown: [] });
      expect(f.state.query("SELECT id FROM native_root_leases").all()).toEqual([{ id: OTHER }]);
      f.state.query("UPDATE native_root_leases SET owner_pid=2147483647,owner_pid_namespace=(SELECT owner_pid_namespace FROM native_root_leases WHERE id=?) WHERE id=?").run(OTHER, OTHER);
      // A changed verified boot identity proves every previous owner has ended.
      f.state.query("UPDATE native_root_leases SET owner_boot='previous-boot' WHERE id=?").run(OTHER);
      expect(await second.recoverDeadOwners()).toMatchObject({ released: [OTHER], retainedLive: 0, retainedUnverifiable: 0 });
    } finally { await second.close(); }
  } finally { await f.close(); }
});

test("lost creation and deletion replies retain ownership; durable deleting can reconcile across live generations", async () => {
  const f = await fixture(), checkpoint = f.native.client.checkpoint, release = f.native.client.release;
  let loseCreate = true, loseDelete = true;
  f.native.client.checkpoint = async (...args) => { const value = await checkpoint(...args); if (loseCreate) { loseCreate = false; throw Error("Lost creation receipt"); } return value; };
  f.native.client.release = async (...args) => { const value = await release(...args); if (loseDelete) { loseDelete = false; throw Error("Lost deletion receipt"); } return value; };
  try {
    await expectRejection(f.owner.client.checkpoint(ID), "Lost creation receipt");
    expect(f.state.query("SELECT state FROM native_root_leases WHERE id=?").get(ID)).toEqual({ state: "creating" });
    const second = await createNativeBrainLeaseManager(f.native.client, f.options);
    try {
      expect(await second.recoverDeadOwners()).toMatchObject({ retainedLive: 1, released: [] });
      await expectRejection(f.owner.client.release(ID), "Lost deletion receipt");
      expect(f.state.query("SELECT state FROM native_root_leases WHERE id=?").get(ID)).toEqual({ state: "deleting" });
      expect(await second.recoverDeadOwners()).toMatchObject({ released: [ID], unknown: [] });
      expect(f.state.query("SELECT count(*) AS n FROM native_root_leases").get()).toEqual({ n: 0 });
    } finally { await second.close(); }
  } finally { await f.close(); }
});

test("lease state never opens the UI database and mismatched store identity cannot authorize recovery", async () => {
  const f = await fixture();
  try {
    expect(f.state.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: "native_lease_store" }, { name: "native_pool_leases" }, { name: "native_root_leases" }]);
    await expectRejection(createNativeBrainLeaseManager(f.native.client, { ...f.options, fsid: "another-store" }), "another managed brain");
    await expectRejection(f.owner.client.release(ID), "no recorded checkpoint lease");
  } finally { await f.close(); }
});

test("output stages record ownership before creation and close releases stages before their checkpoint", async () => {
  const f = await fixture(), releases: string[] = [];
  const release = f.native.client.release;
  f.native.client.release = async (...args) => { releases.push(`checkpoint:${args[0]}`); return release(...args); };
  f.native.client.releaseStage = async id => { releases.push(`stage:${id}`); return { id, state: "deleted" }; };
  f.native.client.prepareStage = async (id, checkpointId, allowanceBytes) => {
    expect(f.state.query("SELECT kind,state,stage_lower_id,stage_allowance FROM native_root_leases WHERE id=?").get(id), "NATIVE_STAGE_OWNER_DURABLE_BEFORE_RPC")
      .toEqual({ kind: "stage", state: "creating", stage_lower_id: checkpointId, stage_allowance: allowanceBytes });
    const checkpoint = await f.native.client.checkpoint(checkpointId);
    return { id, checkpointId, checkpointUuid: checkpoint.uuid, sourceUuid: checkpoint.sourceUuid, allowanceBytes,
      path: join(f.root, "test-stage"), namespacePid: process.pid, namespaceStart: "fixture", appUid: process.geteuid!(), appGid: process.getegid!(), rootDevice: "1", rootInode: "2" };
  };
  try {
    await expectRejection(f.owner.client.prepareStage(OTHER, ID, 4096), "retained sealed");
    await f.owner.client.checkpoint(ID); await f.owner.client.prepareStage(OTHER, ID, 4096);
    await expectRejection(f.owner.client.prepareStage(OTHER, ID, 8192), "another owner or deletion");
    await expectRejection(f.owner.client.release(OTHER), "no recorded checkpoint lease");
    await expectRejection(f.owner.client.release(ID), "stage still depends");
    expect(releases, "NATIVE_PENDING_STAGE_PINS_LOWER_CHECKPOINT").toEqual([]);
    await f.owner.close();
    expect(releases, "NATIVE_STAGE_CLOSE_RELEASES_LOWER_LAST").toEqual([`stage:${OTHER}`, `checkpoint:${ID}`]);
    expect(f.state.query("SELECT count(*) AS n FROM native_root_leases").get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});

test("checkpoint source changes refuse admission while retaining the same durable cleanup identity", async () => {
  const f = await fixture(), checkpoint = f.native.client.checkpoint;
  f.native.client.checkpoint = async (...args) => ({ ...await checkpoint(...args), sourceUuid: "22".repeat(16) });
  try {
    await expectRejection(f.owner.client.checkpoint(ID), "durable lease identity");
    expect(f.state.query("SELECT id,state FROM native_root_leases").all()).toEqual([{ id: ID, state: "creating" }]);
    await f.owner.client.release(ID);
    expect(f.state.query("SELECT count(*) AS n FROM native_root_leases").get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});


test("close drains cancelled pending creation before releasing its recorded UUID", async () => {
  const f = await fixture(), checkpoint = f.native.client.checkpoint, release = f.native.client.release;
  let finish!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const events: string[] = [], abort = new AbortController();
  f.native.client.checkpoint = async (id, signal) => {
    events.push("creating"); entered(); await gate;
    // The remote creation can succeed even when its acknowledgement is cancelled.
    await checkpoint(id); events.push("created"); signal?.throwIfAborted();
    return checkpoint(id);
  };
  f.native.client.release = async (id, signal) => { expect(signal, "NATIVE_CLOSE_RELEASE_IS_UNABORTED").toBeUndefined(); events.push("released"); return release(id); };
  try {
    const creating = f.owner.client.checkpoint(ID, abort.signal);
    const failed = creating.catch(error => error);
    await started; abort.abort(Error("Cancelled admission"));
    let settled = false;
    const closing = f.owner.close().then(() => { settled = true; });
    // A close that skipped the drain would already have committed its deletion intent.
    await f.owner.writer.idle();
    expect(settled, "NATIVE_CLOSE_WAITS_FOR_UNKNOWN_CREATION").toBe(false);
    expect(events, "NATIVE_CLOSE_DRAINS_CREATION_BEFORE_RELEASE").toEqual(["creating"]);
    expect(f.state.query("SELECT state FROM native_root_leases WHERE id=?").get(ID)).toEqual({ state: "creating" });
    finish();
    expect((await failed).message).toBe("Cancelled admission");
    await closing;
    expect(events, "NATIVE_LATE_CREATION_RELEASED_ONLY_AFTER_SETTLEMENT").toEqual(["creating", "created", "released"]);
    expect(f.state.query("SELECT count(*) AS n FROM native_root_leases").get()).toEqual({ n: 0 });
    await expectRejection(f.owner.client.checkpoint(OTHER), "closed");
  } finally { finish(); await f.close(); }
});

test("unknown stage creation pins its lower root until confirmed stage deletion is reconciled", async () => {
  const f = await fixture(), releases: string[] = [], release = f.native.client.release;
  let loseDelete = true;
  f.native.client.prepareStage = async () => { throw Error("Lost stage creation receipt"); };
  f.native.client.release = async (...args) => { releases.push(`checkpoint:${args[0]}`); return release(...args); };
  f.native.client.releaseStage = async id => { releases.push(`stage:${id}`); if (loseDelete) { loseDelete = false; throw Error("Lost stage deletion receipt"); } return { id, state: "deleted" }; };
  const second = await createNativeBrainLeaseManager(f.native.client, f.options);
  try {
    await f.owner.client.checkpoint(ID);
    await expectRejection(f.owner.client.prepareStage(OTHER, ID, 4096), "Lost stage creation receipt");
    expect(f.state.query("SELECT state FROM native_root_leases WHERE id=?").get(OTHER)).toEqual({ state: "creating" });
    expect(await second.recoverDeadOwners()).toMatchObject({ retainedLive: 2, released: [] });
    await expectRejection(f.owner.client.release(ID), "stage still depends");
    expect(releases, "NATIVE_UNKNOWN_STAGE_CREATION_PINS_LOWER").toEqual([]);
    await expectRejection(f.owner.client.releaseStage(OTHER), "Lost stage deletion receipt");
    expect(f.state.query("SELECT state FROM native_root_leases WHERE id=?").get(OTHER)).toEqual({ state: "deleting" });
    expect(await second.recoverDeadOwners()).toMatchObject({ released: [OTHER, ID], unknown: [] });
    expect(releases, "NATIVE_RECOVERY_DELETES_UNKNOWN_STAGE_BEFORE_LOWER").toEqual([`stage:${OTHER}`, `stage:${OTHER}`, `checkpoint:${ID}`]);
    expect(f.state.query("SELECT count(*) AS n FROM native_root_leases").get()).toEqual({ n: 0 });
  } finally { await second.close(); await f.close(); }
});

test("reference pool roots are durable app leases that dead-owner recovery and close never delete", async () => {
  const f = await fixture(), calls: string[] = [];
  const record = (id: string, purpose: "source" | "worktree" | "staging" | "checkpoint", from: string | null, allowanceBytes: number, state: string) =>
    ({ id, purpose, from, allowanceBytes, state, root: null, path: null, ownerBytes: null, reason: null }) as never;
  f.native.client.poolCreate = async (id, purpose, from, allowanceBytes) => {
    calls.push(`create:${id}`);
    expect((f.state.query("SELECT state FROM native_pool_leases WHERE id=?").get(id) as { state: string }).state, "REFERENCE_POOL_LEASE_DURABLE_BEFORE_RPC").toBe("creating");
    return record(id, purpose, from, allowanceBytes, "writable");
  };
  f.native.client.poolSeal = async id => { calls.push(`seal:${id}`); return record(id, "source", null, 4096, "sealed"); };
  f.native.client.poolRelease = async id => {
    calls.push(`release:${id}`);
    expect((f.state.query("SELECT state FROM native_pool_leases WHERE id=?").get(id) as { state: string }).state, "REFERENCE_POOL_RELEASE_INTENT_BEFORE_RPC").toBe("releasing");
    return record(id, "source", null, 4096, "reclaimed");
  };
  const second = await createNativeBrainLeaseManager(f.native.client, f.options);
  try {
    await f.owner.client.poolCreate(ID, "source", null, 4096);
    await expectRejection(f.owner.client.poolCreate(OTHER, "worktree", "33333333-3333-4333-8333-333333332428", 4096), "held source", "REFERENCE_POOL_SNAPSHOT_NEEDS_HELD_SOURCE");
    await expectRejection(f.owner.client.poolCreate(ID, "source", null, 8192), "another purpose", "REFERENCE_POOL_LEASE_IMMUTABLE");
    expect(await second.recoverDeadOwners(), "REFERENCE_POOL_NOT_AUTOMATICALLY_DELETED").toMatchObject({ released: [], retainedPool: 1 });
    await f.owner.close();
    expect(calls.filter(call => call.startsWith("release")), "REFERENCE_POOL_CLOSE_RETAINS_ROOTS").toEqual([]);
    // Pool ownership is app state, not one process generation: a later owner can seal and release it.
    await second.client.poolSeal(ID);
    await expectRejection(second.client.poolRelease(OTHER), "no recorded app lease", "REFERENCE_POOL_UNRECORDED_NOT_DELETED");
    expect((await second.client.poolRelease(ID)).state).toBe("reclaimed");
    expect(f.state.query("SELECT COUNT(*) AS count FROM native_pool_leases").get(), "REFERENCE_POOL_LEASE_REMOVED_AFTER_RECEIPT").toEqual({ count: 0 });
    expect(calls).toEqual([`create:${ID}`, `seal:${ID}`, `release:${ID}`]);
  } finally { await second.close(); await f.close(); }
});

test("worktree checkpoints, deltas, reads and access moves need this app's held pool leases", async () => {
  const f = await fixture(), calls: string[] = [];
  const SOURCE = "33333333-3333-4333-8333-333333332430", WORKTREE = "44444444-4444-4444-8444-444444442430", CHECKPOINT = "55555555-5555-4555-8555-555555552430";
  const ACCESS = "66666666-6666-4666-8666-666666662430";
  const record = (id: string, purpose: string, from: string | null, state: string, extra: object = {}) =>
    ({ id, purpose, from, allowanceBytes: 4096, state, root: null, path: null, ownerBytes: null, reason: null, view: null, access: null, ...extra }) as never;
  f.native.client.poolCreate = async (id, purpose, from) => { calls.push(`create:${id}`); return record(id, purpose, from, "writable"); };
  f.native.client.poolCheckpoint = async (id, from) => {
    calls.push(`checkpoint:${id}`);
    expect((f.state.query("SELECT purpose,from_id,state FROM native_pool_leases WHERE id=?").get(id)), "REFERENCE_CHECKPOINT_LEASE_DURABLE_BEFORE_RPC")
      .toEqual({ purpose: "checkpoint", from_id: from, state: "creating" });
    return record(id, "checkpoint", from, "sealed", { transaction: "12", readOnly: true });
  };
  f.native.client.poolDelta = async (from, to) => { calls.push(`delta:${from}:${to}`); return { stream: new ReadableStream(), completed: Promise.resolve({ exitCode: 0 as const, bytes: 0 }) }; };
  f.native.client.poolStatCheckpoint = async id => { calls.push(`stat:${id}`); return null; };
  f.native.client.poolAccess = async (id, access) => { calls.push(`access:${id}:${access}`); return record(id, "worktree", SOURCE, "writable", { access }); };
  f.native.client.poolPark = async id => { calls.push(`park:${id}`); return record(id, "worktree", SOURCE, "writable"); };
  try {
    await f.owner.client.poolCreate(SOURCE, "source", null, 4096);
    await expectRejection(f.owner.client.poolCheckpoint(CHECKPOINT, SOURCE), "held worktree", "REFERENCE_CHECKPOINT_ONLY_OF_A_HELD_WORKTREE");
    await expectRejection(f.owner.client.poolAccess(SOURCE, ACCESS), "held worktree", "REFERENCE_ACCESS_ONLY_FOR_A_WORKTREE");
    await f.owner.client.poolCreate(WORKTREE, "worktree", SOURCE, 4096);
    await expectRejection(f.owner.client.poolDelta(CHECKPOINT, CHECKPOINT), "held checkpoints", "REFERENCE_DELTA_NEEDS_HELD_CHECKPOINTS");
    await expectRejection(f.owner.client.poolStatCheckpoint(CHECKPOINT, "", 1000), "held checkpoint", "REFERENCE_CHECKPOINT_READ_NEEDS_HELD_LEASE");
    await f.owner.client.poolCheckpoint(CHECKPOINT, WORKTREE);
    await f.owner.client.poolDelta(CHECKPOINT, CHECKPOINT);
    await f.owner.client.poolStatCheckpoint(CHECKPOINT, "", 1000);
    await f.owner.client.poolAccess(WORKTREE, ACCESS);
    await f.owner.client.poolPark(WORKTREE);
    expect(calls).toEqual([`create:${SOURCE}`, `create:${WORKTREE}`, `checkpoint:${CHECKPOINT}`, `delta:${CHECKPOINT}:${CHECKPOINT}`, `stat:${CHECKPOINT}`, `access:${WORKTREE}:${ACCESS}`, `park:${WORKTREE}`]);
    expect(f.state.query("SELECT state FROM native_pool_leases WHERE id=?").get(CHECKPOINT)).toEqual({ state: "held" });
  } finally { await f.close(); }
});

test("a release the pool never committed holds its lease again (#2431)", async () => {
  const f = await fixture(), calls: string[] = [];
  const SOURCE = "33333333-3333-4333-8333-333333332431", WORKTREE = "44444444-4444-4444-8444-444444442431", CHECKPOINT = "55555555-5555-4555-8555-555555552431";
  const NEXT = "77777777-7777-4777-8777-777777772431";
  const records = new Map<string, Record<string, unknown>>();
  const record = (id: string, purpose: string, from: string | null, state: string, extra: object = {}) => {
    const value = { id, purpose, from, allowanceBytes: 4096, state, root: null, path: null, ownerBytes: null, reason: null, view: null, access: null, ...extra };
    records.set(id, value); return value as never;
  };
  const lease = (id: string) => f.state.query("SELECT state FROM native_pool_leases WHERE id=?").get(id);
  f.native.client.poolCreate = async (id, purpose, from) => { calls.push(`create:${id}`); return record(id, purpose, from, "writable"); };
  f.native.client.poolCheckpoint = async (id, from) => { calls.push(`checkpoint:${id}`); return record(id, "checkpoint", from, "sealed", { transaction: "12", readOnly: true }); };
  f.native.client.listPoolRecovery = async () => ({ records: [...records.values()] as never, next: null });
  let failRelease = true;
  f.native.client.poolRelease = async id => {
    calls.push(`release:${id}`);
    if (failRelease) throw new Error("the manager connection dropped");
    records.delete(id);
    return { id, purpose: "checkpoint", from: WORKTREE, allowanceBytes: 4096, state: "reclaimed", root: null, path: null, ownerBytes: 0, reason: null, view: null, access: null } as never;
  };
  try {
    await f.owner.client.poolCreate(SOURCE, "source", null, 4096);
    await f.owner.client.poolCreate(WORKTREE, "worktree", SOURCE, 4096);
    await f.owner.client.poolCheckpoint(CHECKPOINT, WORKTREE);
    // The worktree's release fails before the pool committed anything: it is held, and assessable, again.
    await expectRejection(f.owner.client.poolRelease(WORKTREE), "dropped");
    expect(lease(WORKTREE), "REFERENCE_POOL_UNCOMMITTED_RELEASE_HELD_AGAIN").toEqual({ state: "held" });
    // A release intent a restart left behind settles the same way at the next checkpoint.
    f.state.query("UPDATE native_pool_leases SET state='releasing' WHERE id=?").run(WORKTREE);
    expect(await f.owner.client.poolCheckpoint(NEXT, WORKTREE), "REFERENCE_POOL_INTERRUPTED_RELEASE_ASSESSABLE").toMatchObject({ id: NEXT });
    expect(lease(WORKTREE)).toEqual({ state: "held" });
  } finally { await f.close(); }
});

test("settling a failed release never overrides a newer release of the same identity (#2431)", async () => {
  const f = await fixture();
  const SOURCE = "33333333-3333-4333-8333-333333332432";
  const records = new Map<string, Record<string, unknown>>();
  f.native.client.poolCreate = async (id, purpose, from) => {
    const value = { id, purpose, from, allowanceBytes: 4096, state: "writable", root: null, path: null, ownerBytes: null, reason: null, view: null, access: null };
    records.set(id, value); return value as never;
  };
  f.native.client.listPoolRecovery = async () => ({ records: [...records.values()] as never, next: null });
  let attempts = 0, commit: () => void = () => {}, newer: () => void = () => {};
  const committed = new Promise<void>(resolve => { commit = resolve; });
  const newerStarted = new Promise<void>(resolve => { newer = resolve; });
  f.native.client.poolRelease = async id => {
    // The first reply is lost only once the newer release of the same identity has reached the pool.
    if (++attempts === 1) { await newerStarted; throw new Error("the first reply was lost"); }
    newer();
    await committed;
    records.delete(id);
    return { id, purpose: "source", from: null, allowanceBytes: 4096, state: "reclaimed", root: null, path: null, ownerBytes: 0, reason: null, view: null, access: null } as never;
  };
  try {
    await f.owner.client.poolCreate(SOURCE, "source", null, 4096);
    const first = f.owner.client.poolRelease(SOURCE).catch(error => error), second = f.owner.client.poolRelease(SOURCE);
    await first;
    commit();
    expect((await second).state).toBe("reclaimed");
    expect(f.state.query("SELECT state FROM native_pool_leases WHERE id=?").get(SOURCE), "REFERENCE_POOL_SETTLE_NEVER_OVERRIDES_A_NEWER_RELEASE").toBeNull();
  } finally { await f.close(); }
});

test("a failed release's settlement yields to a newer release that starts while the pool answers (#2431)", async () => {
  const f = await fixture();
  const SOURCE = "33333333-3333-4333-8333-333333332433";
  const records = new Map<string, Record<string, unknown>>();
  f.native.client.poolCreate = async (id, purpose, from) => {
    const value = { id, purpose, from, allowanceBytes: 4096, state: "writable", root: null, path: null, ownerBytes: null, reason: null, view: null, access: null };
    records.set(id, value); return value as never;
  };
  let listing: () => void = () => {}, newer: () => void = () => {}, commit: () => void = () => {};
  const listed = new Promise<void>(resolve => { listing = resolve; });
  const newerStarted = new Promise<void>(resolve => { newer = resolve; });
  const committed = new Promise<void>(resolve => { commit = resolve; });
  // The pool still reports the root writable, but only answers once the newer release has reached it.
  f.native.client.listPoolRecovery = async () => { listing(); await newerStarted; return { records: [...records.values()] as never, next: null }; };
  let attempts = 0;
  f.native.client.poolRelease = async id => {
    if (++attempts === 1) throw new Error("the first reply was lost");
    newer();
    await committed;
    records.delete(id);
    return { id, purpose: "source", from: null, allowanceBytes: 4096, state: "reclaimed", root: null, path: null, ownerBytes: 0, reason: null, view: null, access: null } as never;
  };
  try {
    await f.owner.client.poolCreate(SOURCE, "source", null, 4096);
    const first = f.owner.client.poolRelease(SOURCE).then(() => null, error => error);
    await listed;
    const second = f.owner.client.poolRelease(SOURCE);
    expect((await first)?.message).toBe("the first reply was lost");
    commit();
    expect((await second).state).toBe("reclaimed");
    expect(f.state.query("SELECT state FROM native_pool_leases WHERE id=?").get(SOURCE), "REFERENCE_POOL_SETTLE_RECHECKS_AFTER_THE_POOL_ANSWERS").toBeNull();
  } finally { commit(); newer(); await f.close(); }
});

test("pool leases recorded before checkpoints migrate without losing a row", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-lease-migrate-")), brain = join(root, "brain"), statePath = join(root, "native-leases.sqlite"); mkdirSync(brain);
  const native = createNativeJournalFixture(brain, root), ready = await native.client.ready();
  const old = new Database(statePath);
  old.exec(`CREATE TABLE native_pool_leases (id TEXT PRIMARY KEY,purpose TEXT NOT NULL CHECK(purpose IN ('source','worktree','staging')),from_id TEXT,allowance INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('creating','held','releasing')));
    INSERT INTO native_pool_leases VALUES ('${ID}','source',NULL,4096,'held');`);
  old.close(); chmodSync(statePath, 0o600);
  const owner = await createNativeBrainLeaseManager(native.client, { statePath, brainPath: brain, fsid: ready.fsid, brainUuid: ready.brainUuid });
  const state = new Database(statePath);
  try {
    expect(state.query("SELECT * FROM native_pool_leases").all(), "REFERENCE_POOL_LEASES_SURVIVE_MIGRATION").toEqual([{ id: ID, purpose: "source", from_id: null, allowance: 4096, state: "held" }]);
    expect(() => state.query("INSERT INTO native_pool_leases VALUES (?,'checkpoint',?,4096,'creating')").run(OTHER, ID), "REFERENCE_POOL_LEASES_ACCEPT_CHECKPOINTS").not.toThrow();
  } finally { state.close(); await owner.close().catch(() => {}); await native.close(); rmSync(root, { recursive: true, force: true }); }
});

/**
 * One held worktree under the real lease owner, observed through the real
 * worktree journal manager and observer (#3528). The raw pool records every
 * request it receives; by default it creates and deletes nothing.
 */
async function worktreeObservation() {
  const f = await fixture(), calls: string[] = [];
  const SOURCE = "33333333-3333-4333-8333-333333333528", WORKTREE = "44444444-4444-4444-8444-444444443528";
  const record = (id: string, purpose: string, from: string | null, state: string) =>
    ({ id, purpose, from, allowanceBytes: 4096, state, root: null, path: null, ownerBytes: null, reason: null, view: null, access: null }) as never;
  f.native.client.poolCreate = async (id, purpose, from) => record(id, purpose, from, "writable");
  f.native.client.poolCheckpoint = async id => { calls.push(`checkpoint:${id}`); throw new Error("the pool created no checkpoint"); };
  f.native.client.poolRelease = async id => { calls.push(`release:${id}`); return record(id, "checkpoint", WORKTREE, "reclaimed"); };
  await f.owner.client.poolCreate(SOURCE, "source", null, 4096);
  await f.owner.client.poolCreate(WORKTREE, "worktree", SOURCE, 4096);
  const recorded = new Set<string>();
  const ledger: ReferenceWorktreeCheckpointLedger = { record: id => { recorded.add(id); }, forget: id => { recorded.delete(id); } };
  const observer = createNativeJournalObserver(referenceWorktreeJournalManager(f.owner.client, WORKTREE, ledger));
  const checkpointLeases = () => f.state.query("SELECT id,state FROM native_pool_leases WHERE purpose='checkpoint'").all();
  return { ...f, calls, WORKTREE, ledger, recorded, observer, checkpointLeases };
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const abortable = (signal?: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal?.aborted) reject(signal.reason); else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
});

test("a worktree observation aborted while its checkpoint is being recorded closes with nothing retained (#3528)", async () => {
  const w = await worktreeObservation(), entered = deferred(), resume = deferred();
  let id = "";
  w.ledger.record = async checkpointId => { id = checkpointId; w.recorded.add(checkpointId); entered.resolve(); await resume.promise; };
  try {
    const controller = new AbortController(), reason = new Error("the turn was cancelled");
    const initialized = w.observer.initialize(controller.signal).then(() => null, error => error);
    await entered.promise;
    controller.abort(reason); resume.resolve();
    expect(await initialized, "WORKTREE_LEDGER_WAIT_ABORT_REFUSES_INITIALIZATION").toBe(reason);
    await w.observer.close();
    expect(w.recorded.size, "WORKTREE_LEDGER_WAIT_ABORT_FORGETS_ITS_RECORD").toBe(0);
    expect(w.calls, "WORKTREE_LEDGER_WAIT_ABORT_ASKS_THE_POOL_NOTHING").toEqual([]);
    expect(w.checkpointLeases(), "WORKTREE_LEDGER_WAIT_ABORT_RECORDS_NO_LEASE").toEqual([]);
    // The acknowledgment is spent: the identity is again one no lease covers.
    await expectRejection(w.owner.client.poolRelease(id), "no recorded app lease", "WORKTREE_REFUSED_CHECKPOINT_ACKNOWLEDGED_ONCE");
    await expectRejection(w.owner.client.poolRelease(OTHER), "no recorded app lease", "WORKTREE_UNLEASED_ROOT_STAYS_UNDELETABLE");
    expect(w.calls).toEqual([]);
  } finally { resume.resolve(); await w.close(); }
});

test("a worktree observation aborted while the owner settles the worktree's release closes with nothing retained (#3528)", async () => {
  const w = await worktreeObservation(), listing = deferred();
  // An interrupted release of the worktree makes the owner ask the pool before recording the checkpoint's lease.
  w.state.query("UPDATE native_pool_leases SET state='releasing' WHERE id=?").run(w.WORKTREE);
  w.native.client.listPoolRecovery = async (_after, signal) => { listing.resolve(); return abortable(signal); };
  try {
    const controller = new AbortController(), reason = new Error("the turn was cancelled");
    const initialized = w.observer.initialize(controller.signal).then(() => null, error => error);
    await listing.promise;
    controller.abort(reason);
    expect(await initialized, "WORKTREE_SETTLE_WAIT_ABORT_REFUSES_INITIALIZATION").toBe(reason);
    await w.observer.close();
    expect(w.recorded.size, "WORKTREE_SETTLE_WAIT_ABORT_FORGETS_ITS_RECORD").toBe(0);
    expect(w.calls, "WORKTREE_SETTLE_WAIT_ABORT_ASKS_THE_POOL_NOTHING").toEqual([]);
    expect(w.checkpointLeases(), "WORKTREE_SETTLE_WAIT_ABORT_RECORDS_NO_LEASE").toEqual([]);
    expect(w.state.query("SELECT state FROM native_pool_leases WHERE id=?").get(w.WORKTREE), "WORKTREE_SETTLE_WAIT_ABORT_KEEPS_THE_RELEASE_INTENT").toEqual({ state: "releasing" });
  } finally { await w.close(); }
});

test("a worktree checkpoint ledger record that fails asks the pool nothing and leaves nothing retained (#3528)", async () => {
  const w = await worktreeObservation();
  w.ledger.record = async id => { w.recorded.add(id); throw new Error("the ledger write was lost"); };
  try {
    await expectRejection(w.observer.initialize(), "the ledger write was lost");
    await w.observer.close();
    expect(w.recorded.size, "WORKTREE_LEDGER_FAILURE_FORGETS_ITS_RECORD").toBe(0);
    expect(w.calls, "WORKTREE_LEDGER_FAILURE_ASKS_THE_POOL_NOTHING").toEqual([]);
  } finally { await w.close(); }
});

test("a worktree checkpoint aborted after its lease is recorded keeps retryable cleanup ownership (#3528)", async () => {
  const w = await worktreeObservation(), creating = deferred();
  w.native.client.poolCheckpoint = async (id, _from, signal) => { w.calls.push(`checkpoint:${id}`); creating.resolve(); return abortable(signal); };
  w.native.client.listPoolRecovery = async () => ({ records: [], next: null });
  let failRelease = true;
  w.native.client.poolRelease = async id => {
    w.calls.push(`release:${id}`);
    if (failRelease) throw new Error("the manager connection dropped");
    return { id, purpose: "checkpoint", from: w.WORKTREE, allowanceBytes: 4096, state: "reclaimed", root: null, path: null, ownerBytes: 0, reason: null, view: null, access: null } as never;
  };
  try {
    const controller = new AbortController(), reason = new Error("the turn was cancelled");
    const initialized = w.observer.initialize(controller.signal).then(() => null, error => error);
    await creating.promise;
    controller.abort(reason);
    expect(await initialized).toBe(reason);
    await expectRejection(w.observer.close(), "remain retained after shutdown", "WORKTREE_LEASED_CHECKPOINT_STAYS_RETAINED");
    const [id] = [...w.recorded];
    expect(w.checkpointLeases(), "WORKTREE_LEASED_CHECKPOINT_KEEPS_ITS_LEASE").toEqual([{ id, state: "releasing" }]);
    expect(w.calls, "WORKTREE_LEASED_CHECKPOINT_RELEASE_REACHES_THE_POOL").toEqual([`checkpoint:${id}`, `release:${id}`, `release:${id}`]);
    failRelease = false;
    expect((await w.owner.client.poolRelease(id)).state, "WORKTREE_LEASED_CHECKPOINT_RELEASE_RETRIES").toBe("reclaimed");
    expect(w.checkpointLeases()).toEqual([]);
  } finally { await w.close(); }
});

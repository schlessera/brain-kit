import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBrainLeaseManager } from "../src/brain/native-brain-leases.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";

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
  let beforeRpc = false;
  f.native.client.checkpoint = async (...args) => {
    beforeRpc = (f.state.query("SELECT state FROM native_root_leases WHERE id=?").get(ID) as { state: string }).state === "creating";
    return checkpoint(...args);
  };
  const second = await createNativeBrainLeaseManager(f.native.client, f.options);
  try {
    await f.owner.client.checkpoint(ID);
    expect(beforeRpc, "NATIVE_LEASE_DURABLE_BEFORE_CREATION_RPC").toBe(true);
    await expect(second.client.release(ID)).rejects.toThrow("another live");
    await expect(second.client.checkpoint(ID)).rejects.toThrow("another live");
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
    await expect(f.owner.client.checkpoint(ID)).rejects.toThrow("Lost creation receipt");
    expect(f.state.query("SELECT state FROM native_root_leases WHERE id=?").get(ID)).toEqual({ state: "creating" });
    const second = await createNativeBrainLeaseManager(f.native.client, f.options);
    try {
      expect(await second.recoverDeadOwners()).toMatchObject({ retainedLive: 1, released: [] });
      await expect(f.owner.client.release(ID)).rejects.toThrow("Lost deletion receipt");
      expect(f.state.query("SELECT state FROM native_root_leases WHERE id=?").get(ID)).toEqual({ state: "deleting" });
      expect(await second.recoverDeadOwners()).toMatchObject({ released: [ID], unknown: [] });
      expect(f.state.query("SELECT count(*) AS n FROM native_root_leases").get()).toEqual({ n: 0 });
    } finally { await second.close(); }
  } finally { await f.close(); }
});

test("lease state never opens the UI database and mismatched store identity cannot authorize recovery", async () => {
  const f = await fixture();
  try {
    expect(f.state.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: "native_lease_store" }, { name: "native_root_leases" }]);
    await expect(createNativeBrainLeaseManager(f.native.client, { ...f.options, fsid: "another-store" })).rejects.toThrow("another managed brain");
    await expect(f.owner.client.release(ID)).rejects.toThrow("no recorded checkpoint lease");
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
    await expect(f.owner.client.prepareStage(OTHER, ID, 4096)).rejects.toThrow("retained sealed");
    await f.owner.client.checkpoint(ID); await f.owner.client.prepareStage(OTHER, ID, 4096);
    await expect(f.owner.client.prepareStage(OTHER, ID, 8192)).rejects.toThrow("another owner or deletion");
    await expect(f.owner.client.release(OTHER)).rejects.toThrow("no recorded checkpoint lease");
    await expect(f.owner.client.release(ID)).rejects.toThrow("stage still depends");
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
    await expect(f.owner.client.checkpoint(ID)).rejects.toThrow("durable lease identity");
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
    await Promise.resolve();
    expect(settled, "NATIVE_CLOSE_WAITS_FOR_UNKNOWN_CREATION").toBe(false);
    expect(events, "NATIVE_CLOSE_DRAINS_CREATION_BEFORE_RELEASE").toEqual(["creating"]);
    expect(f.state.query("SELECT state FROM native_root_leases WHERE id=?").get(ID)).toEqual({ state: "creating" });
    finish();
    expect((await failed).message).toBe("Cancelled admission");
    await closing;
    expect(events, "NATIVE_LATE_CREATION_RELEASED_ONLY_AFTER_SETTLEMENT").toEqual(["creating", "created", "released"]);
    expect(f.state.query("SELECT count(*) AS n FROM native_root_leases").get()).toEqual({ n: 0 });
    await expect(f.owner.client.checkpoint(OTHER)).rejects.toThrow("closed");
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
    await expect(f.owner.client.prepareStage(OTHER, ID, 4096)).rejects.toThrow("Lost stage creation receipt");
    expect(f.state.query("SELECT state FROM native_root_leases WHERE id=?").get(OTHER)).toEqual({ state: "creating" });
    expect(await second.recoverDeadOwners()).toMatchObject({ retainedLive: 2, released: [] });
    await expect(f.owner.client.release(ID)).rejects.toThrow("stage still depends");
    expect(releases, "NATIVE_UNKNOWN_STAGE_CREATION_PINS_LOWER").toEqual([]);
    await expect(f.owner.client.releaseStage(OTHER)).rejects.toThrow("Lost stage deletion receipt");
    expect(f.state.query("SELECT state FROM native_root_leases WHERE id=?").get(OTHER)).toEqual({ state: "deleting" });
    expect(await second.recoverDeadOwners()).toMatchObject({ released: [OTHER, ID], unknown: [] });
    expect(releases, "NATIVE_RECOVERY_DELETES_UNKNOWN_STAGE_BEFORE_LOWER").toEqual([`stage:${OTHER}`, `stage:${OTHER}`, `checkpoint:${ID}`]);
    expect(f.state.query("SELECT count(*) AS n FROM native_root_leases").get()).toEqual({ n: 0 });
  } finally { await second.close(); await f.close(); }
});

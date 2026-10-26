import { expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { createInboxCleanup } from "../src/inbox/cleanup.js";
import { createInboxStore } from "../src/inbox/store.js";
import type { AppEnv } from "../src/app-env.js";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, isUsablePrincipal, resolvePrincipal } from "../src/db/principals.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createSharedStorageScan } from "../src/storage/shared-scan.js";
import { createStorageCoordinator, StorageUnavailable } from "../src/storage/coordinator.js";
import { createStorageMaintenance } from "../src/storage/maintenance.js";
import { createStorageMaintenanceRoutes } from "../src/routes/storage-maintenance.js";
import { hashScope } from "../src/storage/history-model.js";
import * as processes from "../src/storage/process.js";
import { watchWriteSites } from "./helpers/write-sites.js";
import * as probe from "./fixtures/write-worker-probe.js";

const at = Date.UTC(2026, 6, 12, 9, 41), scope = hashScope("Odysseus stores");
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-scan-offloop-")), brain = join(root, "brain");
  mkdirSync(join(brain, ".git/objects"), { recursive: true });
  mkdirSync(join(brain, ".git/refs/heads"), { recursive: true });
  writeFileSync(join(brain, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(brain, "Odysseus.md"), "# Odysseus\n\nReturn to Ithaca on 2026-07-12.\n");
  const db = createUiDb(join(root, "ui.db"));
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const authorized = (id: string) => { const value = resolvePrincipal(db, id); return !!value && ["owner", "ambient"].includes(value.kind) && isUsablePrincipal(value, Date.now()); };
  const writer = openSqliteWriter(db);
  const shared = createSharedStorageScan(db, brain, join(root, "cache"), authorized, writer);
  const storage = createStorageCoordinator({ brainPath: brain, stores: [], shared, authorized });
  return { root, brain, db, owner, writer, shared, storage, authorized,
    async close() { await storage.close(); await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
async function refusal(work: () => unknown) {
  try { await work(); } catch (error) { return error; }
  throw Error("EXPECTED_STORAGE_REFUSAL");
}

test("scan acquire, join, reap, register, unregister, cancel and finish commit on the worker at FULL", async () => {
  const f = fixture();
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["storage_scan_leases", "storage_maintenance_operations"]);
    expect(f.writer.offloop, "STORAGE_SCAN_REAL_WRITE_WORKER").toBe(true);
    let count = 0;
    const committed = async (label: string) => expect(await sites.log(), label).toEqual(Array(++count).fill("storage_scan_leases"));
    const scan = (await f.shared.acquire(f.owner.id, randomUUID(), scope, 1, true, at))!;
    await committed("STORAGE_SCAN_ACQUIRE_WORKER_FULL");
    expect(f.shared.check(scan).job_id, "STORAGE_SCAN_LEASE_DURABLE_ON_RETURN").toBe(scan.id);
    const joined = (await f.shared.acquire(f.owner.id, randomUUID(), scope, 1, true, at))!;
    expect(joined.owner).toBe(false); expect(joined.id).toBe(scan.id);
    await committed("STORAGE_SCAN_JOIN_WORKER_FULL");
    await f.shared.reap(scan); await committed("STORAGE_SCAN_REAP_WORKER_FULL");
    await f.shared.register(scan, process.pid); await committed("STORAGE_SCAN_REGISTER_WORKER_FULL");
    expect(JSON.parse(f.shared.check(scan).workers_json), "STORAGE_SCAN_PID_DURABLE_ON_RETURN").toMatchObject([{ pid: process.pid }]);
    expect(await f.shared.finish(scan, true, false, at), "STORAGE_SCAN_LIVE_PID_PREVENTS_FINISH").toBe(false);
    await f.shared.unregister(scan, process.pid); await committed("STORAGE_SCAN_UNREGISTER_WORKER_FULL");
    expect(f.shared.check(scan).workers_json).toBe("[]");
    await f.shared.cancel(joined); await committed("STORAGE_SCAN_CANCEL_WORKER_FULL");
    expect(() => f.shared.check(scan), "STORAGE_SCAN_CANCEL_DURABLE_ON_RETURN").toThrow("storage-scan-authority-lost");
    expect(await f.shared.finish(scan, false, true, at)).toBe(true);
    await committed("STORAGE_SCAN_FINISH_WORKER_FULL");
    expect(f.db.query("SELECT job_id, result_id, result_at FROM storage_scan_leases").get(), "STORAGE_SCAN_FINISH_DURABLE_ON_RETURN").toEqual({ job_id: null, result_id: scan.id, result_at: at });
  } finally { await f.close(); }
});

test("held acquisition prevents collector launch and held finish prevents serving its result", async () => {
  const f = fixture(), queue = f.writer.channel(probe, { table: "odysseus_scan_queue" });
  const enteredFinish = deferred();
  let collectorCalls = 0, leaseSeen = false, heldFinish: Promise<unknown> | undefined;
  const originalCollect = processes.coreMetadata;
  const collect = spyOn(processes, "coreMetadata").mockImplementation((...args) => {
    collectorCalls++;
    leaseSeen = !!(f.db.query("SELECT job_id FROM storage_scan_leases").get() as { job_id: string | null } | null)?.job_id;
    return originalCollect(...args);
  });
  const originalFinish = f.shared.finish;
  const finish = spyOn(f.shared, "finish").mockImplementation((...args) => {
    if (!args[2] && !heldFinish) { heldFinish = queue.call("slow", "Ithaca finish", 300); enteredFinish.resolve(); }
    return originalFinish(...args);
  });
  try {
    await watchWriteSites(f.db, f.writer, ["storage_scan_leases", "storage_maintenance_operations"]);
    await queue.ready;
    const held = queue.call("slow", "Ithaca acquire", 300);
    let answered = false;
    const starting = Promise.resolve(f.storage.start(f.owner.id, true)).then(value => { answered = true; return value; });
    await Bun.sleep(20);
    expect(answered, "STORAGE_SCAN_START_WAITS_FOR_LEASE").toBe(false);
    expect(collectorCalls, "STORAGE_SCAN_NO_COLLECTOR_BEFORE_LEASE_COMMIT").toBe(0);
    expect(f.db.query("SELECT job_id FROM storage_scan_leases").get()).toBeNull();
    await held; await starting;
    await enteredFinish.promise;
    await Bun.sleep(20);
    expect(collectorCalls, "STORAGE_SCAN_COLLECTOR_REALLY_RAN").toBe(1);
    expect(leaseSeen, "STORAGE_SCAN_COLLECTOR_SEES_COMMITTED_LEASE").toBe(true);
    expect(f.storage.status(f.owner.id).snapshot, "STORAGE_SCAN_NO_RESULT_BEFORE_FINISH_COMMIT").toBeNull();
    await heldFinish; await f.storage.idle();
    expect(f.storage.status(f.owner.id).snapshot, "STORAGE_SCAN_RESULT_AFTER_FINISH_COMMIT").not.toBeNull();
    expect(f.db.query("SELECT job_id FROM storage_scan_leases").get()).toEqual({ job_id: null });
  } finally { collect.mockRestore(); finish.mockRestore(); await f.close(); }
});

test("collector completion waits for registration and unregister commits", async () => {
  const f = fixture(), queue = f.writer.channel(probe, { table: "odysseus_pid_queue" });
  try {
    await watchWriteSites(f.db, f.writer, ["storage_scan_leases", "storage_maintenance_operations"]);
    await queue.ready;
    const scan = (await f.shared.acquire(f.owner.id, randomUUID(), scope, 1, true, at))!;
    const registering = deferred(), unregistering = deferred();
    let registration: Promise<unknown> | undefined, unregistration: Promise<unknown> | undefined, done = false, registered = false, registeredBeforeUnregister = false;
    const result = processes.storageProcess([process.execPath, "--config=/dev/null", "--no-env-file", "-e", 'await Bun.sleep(450); console.log(JSON.stringify({ destination: "Ithaca" }))'], {
      signal: new AbortController().signal,
      lease: {
        register(pid) { registration = queue.call("slow", "Ithaca register", 300); registering.resolve(); return Promise.resolve(f.shared.register(scan, pid)).then(() => { registered = true; }); },
        unregister(pid) { registeredBeforeUnregister = registered; unregistration = queue.call("slow", "Ithaca unregister", 300); unregistering.resolve(); return f.shared.unregister(scan, pid); },
      },
    }).then(value => { done = true; return value; });
    await registering.promise; await Bun.sleep(20);
    expect(done, "STORAGE_SCAN_COLLECTOR_WAITS_FOR_REGISTER").toBe(false);
    await registration; await unregistering.promise; await Bun.sleep(20);
    expect(registeredBeforeUnregister, "STORAGE_SCAN_REGISTER_BEFORE_UNREGISTER").toBe(true);
    expect(done, "STORAGE_SCAN_COLLECTOR_WAITS_FOR_UNREGISTER").toBe(false);
    await unregistration;
    expect(await result).toEqual({ destination: "Ithaca" });
    expect(f.shared.check(scan).workers_json).toBe("[]");
    await f.shared.finish(scan, false, false, at);
  } finally { await f.close(); }
});

function maintenance(f: ReturnType<typeof fixture>, inbox: Parameters<typeof createStorageMaintenance>[1]["inbox"] = { cleanup: undefined }) {
  const measure = spyOn(f.storage, "measure").mockImplementation(async () => null);
  const entered = deferred(), cancelled = deferred();
  let ownerCancelled = false;
  const operations = createStorageMaintenance(f.db, {
    writer: f.writer, brainPath: f.brain, storage: f.storage, authorized: f.authorized,
    boundary: { status: () => ({ hostExecution: "worker", available: true, profile: "strict", protectedPaths: [], identity: "shared_uid", configurationView: "startup" }) },
    brain: { async storagePack(request) {
      entered.resolve();
      await new Promise<void>((_, reject) => {
        const abort = () => { ownerCancelled = true; cancelled.resolve(); reject(Error("Odysseus cancelled packing")); };
        request!.signal!.addEventListener("abort", abort, { once: true });
        if (request!.signal!.aborted) abort();
      });
    } },
    scratch: { async tick() {}, async close() {}, async run() { throw Error("Unexpected scratch work"); } }, inbox,
  });
  return { operations, entered, cancelled, ownerCancelled: () => ownerCancelled,
    async close() { await operations.close(); measure.mockRestore(); } };
}

test("maintenance route waits for its receipt and cancellation waits for its durable flag", async () => {
  const f = fixture(), m = maintenance(f), queue = f.writer.channel(probe, { table: "odysseus_maintenance_queue" });
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["storage_scan_leases", "storage_maintenance_operations"]);
    await queue.ready;
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("principal", f.owner); await next(); });
    app.route("/api", createStorageMaintenanceRoutes(m.operations));
    const id = "odysseus-maintenance-0001";
    const held = queue.call("slow", "Ithaca start", 300);
    let answered = false;
    const response = Promise.resolve(app.request("/api/storage/maintenance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, operation: "pack-git" }) })).then(value => { answered = true; return value; });
    await Bun.sleep(20);
    expect(answered, "STORAGE_MAINTENANCE_ROUTE_WAITS_FOR_RECEIPT").toBe(false);
    expect(f.db.query("SELECT id FROM storage_maintenance_operations").get()).toBeNull();
    await held;
    const answer = await response;
    expect(answer.status).toBe(202);
    expect(await answer.json(), "STORAGE_MAINTENANCE_ROUTE_COMMITTED_RECEIPT").toMatchObject({ id, state: "waiting" });
    expect(f.db.query("SELECT id FROM storage_maintenance_operations").get()).toEqual({ id });
    await m.entered.promise;
    expect(f.db.query("SELECT state FROM storage_maintenance_operations").get(), "STORAGE_MAINTENANCE_RUNNING_INTENT_BEFORE_OWNER").toEqual({ state: "running" });
    const slowCancel = queue.call("slow", "Ithaca cancel", 300);
    const cancelling = m.operations.cancel(f.owner.id, id);
    await Bun.sleep(20);
    expect(m.ownerCancelled(), "STORAGE_MAINTENANCE_NO_ABORT_BEFORE_CANCEL_COMMIT").toBe(false);
    expect(f.db.query("SELECT cancel_requested FROM storage_maintenance_operations").get()).toEqual({ cancel_requested: 0 });
    await slowCancel; await cancelling; await m.cancelled.promise; await m.operations.idle();
    expect(f.db.query("SELECT cancel_requested FROM storage_maintenance_operations").get()).toEqual({ cancel_requested: 1 });
    expect(await m.operations.receipt(f.owner.id, id)).toMatchObject({ state: "unknown", reason: "owner_outcome_unknown" });
    expect(await sites.log(), "STORAGE_MAINTENANCE_START_WRITE_CANCEL_WORKER_FULL").toEqual(Array(5).fill("storage_maintenance_operations"));
  } finally { await m.close(); await f.close(); }
});

test("worker transaction refusals retain StorageUnavailable status and scan Error messages", async () => {
  const f = fixture(), m = maintenance(f);
  try {
    await watchWriteSites(f.db, f.writer, ["storage_scan_leases", "storage_maintenance_operations"]);
    const scan = (await f.shared.acquire(f.owner.id, randomUUID(), scope, 1, true, at))!;
    const otherScope = await refusal(() => f.shared.acquire(f.owner.id, randomUUID(), hashScope("Troy stores"), 1, true, at));
    expect(otherScope, "STORAGE_SCAN_WORKER_ERROR_CLASS").toBeInstanceOf(Error);
    expect((otherScope as Error).message).toBe("storage-scan-other-scope-busy");
    await m.operations.start(f.owner.id, { id: "odysseus-refusal-0001", operation: "pack-git" });
    await m.entered.promise;
    const busy = await refusal(() => m.operations.start(f.owner.id, { id: "odysseus-refusal-0002", operation: "pack-git" }));
    expect(busy, "STORAGE_MAINTENANCE_WORKER_REFUSAL_CLASS").toBeInstanceOf(StorageUnavailable);
    expect(busy, "STORAGE_MAINTENANCE_WORKER_REFUSAL_FIELDS").toMatchObject({ status: 409, message: "Another Storage operation is active; read its receipt." });
    // register's owned() check is inside its transaction on the write connection.
    f.db.query("UPDATE principals SET revoked_at=? WHERE id=?").run(at, f.owner.id);
    const revoked = await refusal(() => f.shared.register(scan, process.pid));
    expect(revoked, "STORAGE_SCAN_TRANSACTION_REVOCATION_CLASS").toBeInstanceOf(Error);
    expect((revoked as Error).message, "STORAGE_SCAN_TRANSACTION_REVOCATION_MESSAGE").toBe("storage-scan-owner-revoked");
    await f.shared.finish(scan, false, true, at);
  } finally { await m.close(); await f.close(); }
});

test("a held scan cancellation leaves authority intact until its commit", async () => {
  const f = fixture(), queue = f.writer.channel(probe, { table: "odysseus_scan_cancel_queue" });
  try {
    await watchWriteSites(f.db, f.writer, ["storage_scan_leases", "storage_maintenance_operations"]);
    const scan = (await f.shared.acquire(f.owner.id, randomUUID(), scope, 1, true, at))!;
    await queue.ready;
    const held = queue.call("slow", "Ithaca cancel", 300);
    const cancelling = f.shared.cancel(scan);
    await Bun.sleep(20);
    expect(f.shared.check(scan).cancel_requested, "STORAGE_SCAN_AUTHORITY_UNTIL_CANCEL_COMMIT").toBe(0);
    await held; await cancelling;
    expect(() => f.shared.check(scan), "STORAGE_SCAN_AUTHORITY_REVOKED_AFTER_CANCEL_COMMIT").toThrow("storage-scan-authority-lost");
    await f.shared.finish(scan, false, true, at);
  } finally { await f.close(); }
});

test("maintenance receipt recovery commits before list and receipt readers answer", async () => {
  const f = fixture(), m = maintenance(f);
  try {
    const id = "odysseus-recovery-0001";
    f.db.query("INSERT INTO storage_maintenance_operations (id,brain,principal_id,operation,state,pid,pid_start,requested_at,receipt) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, f.brain, f.owner.id, "pack-git", "running", process.pid, "0", at, JSON.stringify({ id, operation: "pack-git", state: "running", requestedAt: at, startedAt: at, completedAt: null, outcome: null }));
    const sites = await watchWriteSites(f.db, f.writer, ["storage_scan_leases", "storage_maintenance_operations"]);
    const result = await m.operations.list(f.owner.id);
    expect(result.operations.find(value => value.id === "pack-git")?.latest, "STORAGE_MAINTENANCE_RECOVERY_READBACK").toMatchObject({ id, state: "unknown", reason: "interrupted_owner_outcome_unknown" });
    expect(await sites.log(), "STORAGE_MAINTENANCE_RECOVERY_WRITE_WORKER_FULL").toEqual(["storage_maintenance_operations"]);
    expect(await m.operations.receipt(f.owner.id, id)).toMatchObject({ state: "unknown" });
    expect(f.db.query("SELECT state FROM storage_maintenance_operations WHERE id=?").get(id)).toEqual({ state: "unknown" });
  } finally { await m.close(); await f.close(); }
});

test("staging removal waits for the maintenance item intent on the worker", async () => {
  const f = fixture(), queue = f.writer.channel(probe, { table: "odysseus_item_intent_queue" });
  const cleanup = createInboxCleanup(f.db, f.brain), entered = deferred();
  const id = "odysseus-staging-0001", stagingId = randomUUID(), itemId = "odysseus-staging-cleanup";
  const target = join(f.brain, SHARE_STAGING_DIR, stagingId);
  mkdirSync(target, { recursive: true }); writeFileSync(join(target, "chart.txt"), "Ithaca chart\n");
  const store = createInboxStore(f.db);
  const item = store.ingest({ threadId: "odysseus-staging", itemId: "odysseus-share", dedupKey: "odysseus-share", source: "share", stagingId, stakes: 2, expiresAt: Number.MAX_SAFE_INTEGER }).item;
  store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "claimed", leaseUntil: Number.MAX_SAFE_INTEGER }]);
  store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version + 1, to: "done" }]);
  store.commit([{ kind: "item", item: { id: itemId, dedupKey: itemId, threadId: "odysseus-staging", queue: "queue", type: "cleanup_pending", status: "ready", attempts: 0, maxAttempts: 3, version: 1, createdAt: at, updatedAt: at, expiresAt: Number.MAX_SAFE_INTEGER, payload: { stagingId } } }]);
  let held: Promise<unknown> | undefined, durableBeforeRemoval = false;
  const m = maintenance(f, { cleanup: request => cleanup.run({ ...request, async onItem(item) {
    if (item.state === "running") { held = queue.call("slow", "Ithaca item intent", 300); entered.resolve(); }
    await request.onItem?.(item);
    if (item.state === "running") {
      const row = f.db.query("SELECT receipt FROM storage_maintenance_operations WHERE id=?").get(id) as { receipt: string };
      durableBeforeRemoval = JSON.parse(row.receipt).outcome.items.some((value: { id: string; state: string }) => value.id === itemId && value.state === "running");
    }
  } }) });
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["storage_scan_leases", "storage_maintenance_operations"]);
    await queue.ready;
    await m.operations.start(f.owner.id, { id, operation: "cleanup-staging" });
    await entered.promise; await Bun.sleep(20);
    expect(existsSync(target), "STORAGE_STAGING_RETAINED_UNTIL_ITEM_INTENT_COMMIT").toBe(true);
    await held; await m.operations.idle();
    expect(durableBeforeRemoval, "STORAGE_STAGING_ITEM_INTENT_DURABLE_BEFORE_REMOVAL").toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(await m.operations.receipt(f.owner.id, id)).toMatchObject({ state: "complete", outcome: { items: [{ id: itemId, state: "cleaned" }] } });
    expect(await sites.log(), "STORAGE_MAINTENANCE_ITEM_WRITES_WORKER_FULL").toEqual(Array(6).fill("storage_maintenance_operations"));
  } finally { await m.close(); await cleanup.close(); await f.close(); }
});

test("overlapping maintenance starts retain one request identity and one owner intent", async () => {
  const f = fixture(), m = maintenance(f);
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["storage_scan_leases", "storage_maintenance_operations"]);
    const request = { id: "odysseus-repeated-0001", operation: "pack-git" as const };
    const [first, repeated] = await Promise.all([m.operations.start(f.owner.id, request), m.operations.start(f.owner.id, request)]);
    expect(repeated.id, "STORAGE_MAINTENANCE_QUEUED_START_IDEMPOTENT").toBe(first.id);
    expect(["waiting", "running"]).toContain(repeated.state);
    await m.entered.promise;
    expect(await sites.log(), "STORAGE_MAINTENANCE_SINGLE_ADMISSION_AND_OWNER_INTENT").toEqual(["storage_maintenance_operations", "storage_maintenance_operations"]);
  } finally { await m.close(); await f.close(); }
});

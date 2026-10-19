import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client";
import { createStorageCoordinator } from "../src/storage/coordinator";
import { createStorageMaintenance } from "../src/storage/maintenance";
import { createInboxCleanup } from "../src/inbox/cleanup";
import { createInboxStore } from "../src/inbox/store";
import { createBrainClient, STORAGE_PACK_CLI_VERSION } from "../src/brain/client";
import type { BrainExecution, HostBoundary } from "../src/brain/host-boundary";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-maintenance-")), brain = join(root, "brain"), dbPath = join(root, "ui.sqlite");
  mkdirSync(brain); mkdirSync(join(brain, ".brain", "scratch"), { recursive: true }); writeFileSync(join(brain, ".brain", "scratch", "chart.txt"), "Ithaca map");
  const db = createUiDb(dbPath); let allowed = true, calls = 0;
  const storage = createStorageCoordinator({ brainPath: brain, stores: [], authorized: () => allowed });
  const cleanup = createInboxCleanup(db, brain);
  const options: Parameters<typeof createStorageMaintenance>[1] = {
    brainPath: brain, storage, authorized: () => allowed,
    boundary: { status: () => ({ hostExecution: "worker", available: true, profile: "strict", protectedPaths: [], identity: "shared_uid", configurationView: "startup" }) },
    brain: { async storagePack(request) { request?.assertAuthorized?.(); calls++; return { schema_version: 1, action: "pack", state: "complete", packed: 2, reason: null }; } },
    scratch: { async tick() {}, async close() {}, async run(request) {
      request.assertAuthorized?.(); calls++; unlinkSync(join(brain, ".brain", "scratch", "chart.txt"));
      return JSON.stringify({ action: "prune", removed: [{ path: ".brain/scratch/chart.txt", bytes: 10, reason: "age" }], failed: [], bytes: 0, files: 0, pinned: { files: 0, bytes: 0 }, overageBytes: 0 });
    } },
    inbox: { cleanup: request => cleanup.run(request) },
  };
  const operations = createStorageMaintenance(db, options);
  return { root, brain, dbPath, db, storage, options, operations, get calls() { return calls; }, revoke() { allowed = false; }, allow() { allowed = true; },
    async close() { await operations.close(); await cleanup.close(); await storage.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("durable request identity serializes effects and exposes independent fresh measurements", async () => {
  const f = fixture(), request = { id: "odysseus-prune-0001", operation: "prune-scratch" as const };
  try {
    const first = f.operations.start("odysseus", request);
    expect(first.state).toBe("waiting");
    let repeatedId: string | undefined;
    expect(() => { repeatedId = f.operations.start("odysseus", request).id; }, "STORAGE_MAINTENANCE_IDEMPOTENT").not.toThrow();
    expect(repeatedId).toBe(first.id);
    expect(() => f.operations.start("odysseus", { id: "odysseus-prune-0002", operation: "prune-scratch" }), "STORAGE_MAINTENANCE_SERIALIZED").toThrow("active");
    await f.operations.idle();
    const result = f.operations.receipt("odysseus", request.id);
    expect(result.state, JSON.stringify(result)).toBe("complete"); expect(f.calls).toBe(1);
    expect(result.before?.stores[0]?.logical).toBe(10); expect(result.after?.stores[0]?.logical).toBe(0);
    expect(result.after!.observedAt).toBeGreaterThanOrEqual(result.before!.observedAt);
    expect(result.after?.attribution).toBe("concurrent-writers-possible"); expect(result.outcome?.removed).toBe(1);
    expect(JSON.stringify(result)).not.toContain("reclaimedBytes");
    const reopened = createUiDb(f.dbPath), second = createStorageMaintenance(reopened, f.options);
    try { expect(second.start("odysseus", request), "STORAGE_MAINTENANCE_REOPEN_RECEIPT").toEqual(result); expect(f.calls).toBe(1); }
    finally { await second.close(); reopened.close(); }
  } finally { await f.close(); }
});

test("revocation and full receipt storage refuse maintenance before its owner runs", async () => {
  const f = fixture();
  try {
    f.operations.start("odysseus", { id: "odysseus-revoked-1", operation: "pack-git" }); f.revoke(); await f.operations.idle();
    expect(f.calls, "STORAGE_MAINTENANCE_REVALIDATES_OWNER").toBe(0);
    expect(() => f.operations.list("odysseus")).toThrow("human-owner"); f.allow();
    expect(f.operations.receipt("odysseus", "odysseus-revoked-1").state).toBe("refused");
    f.db.exec("CREATE TRIGGER refuse_storage_receipt BEFORE INSERT ON storage_maintenance_operations BEGIN SELECT RAISE(ABORT,'SQLITE_FULL'); END");
    expect(() => f.operations.start("odysseus", { id: "odysseus-full-0001", operation: "pack-git" })).toThrow();
    await f.operations.idle(); expect(f.calls, "STORAGE_MAINTENANCE_INTENT_BEFORE_EFFECT").toBe(0);
    expect(existsSync(join(f.brain, ".brain", "scratch", "chart.txt"))).toBe(true);
  } finally { await f.close(); }
});

test("real settled staging cleanup records item intent and refuses recovery-gated work", async () => {
  const f = fixture(), stagingId = "12345678-1234-1234-1234-123456789abc", now = Date.now();
  // The established staging path is exported by the protocol.
  const { SHARE_STAGING_DIR } = await import("@schlessera/brain-ui-sdk/protocol");
  const target = join(f.brain, SHARE_STAGING_DIR, stagingId); mkdirSync(target, { recursive: true }); writeFileSync(join(target, "chart.txt"), "Ithaca");
  const store = createInboxStore(f.db);
  const seed = (threadId: string) => {
    const item = store.ingest({ threadId, itemId: `share-${threadId}`, dedupKey: `share-${threadId}`, source: "share", stagingId, stakes: 2, expiresAt: now + 86_400_000 }).item;
    store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "claimed", leaseUntil: now + 60_000 }]);
    store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version + 1, to: "done" }]);
  };
  seed("harbor");
  store.commit([{ kind: "item", item: { id: "cleanup-harbor", dedupKey: "cleanup-harbor", threadId: "harbor", queue: "queue", type: "cleanup_pending", status: "ready", attempts: 0, maxAttempts: 3, version: 1, createdAt: now, updatedAt: now, expiresAt: Number.MAX_SAFE_INTEGER, payload: { stagingId } } }]);
  try {
    f.operations.start("odysseus", { id: "odysseus-staging-1", operation: "cleanup-staging" }); await f.operations.idle();
    const result = f.operations.receipt("odysseus", "odysseus-staging-1");
    expect(result.state, JSON.stringify(result)).toBe("complete"); expect(existsSync(target), "STORAGE_SETTLED_OWNER_CLEANUP").toBe(false);
    expect(result.outcome?.items).toEqual([{ id: "cleanup-harbor", state: "cleaned", reason: null }]);
    expect(store.getItem("cleanup-harbor")).toMatchObject({ status: "done" });
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, "chart.txt"), "Ithaca");
    seed("retained");
    store.commit([{ kind: "item", item: { id: "cleanup-retained", dedupKey: "cleanup-retained", threadId: "retained", queue: "queue", type: "cleanup_pending", status: "ready", attempts: 0, maxAttempts: 3, version: 1, createdAt: now, updatedAt: now, expiresAt: Number.MAX_SAFE_INTEGER, payload: { stagingId } } }]);
    f.db.query("INSERT INTO inbox_recovery_state VALUES (1, ?, ?, 'pending', NULL)").run("a".repeat(64), f.brain);
    f.operations.start("odysseus", { id: "odysseus-staging-2", operation: "cleanup-staging" }); await f.operations.idle();
    expect(existsSync(target), "STORAGE_MAINTENANCE_RECOVERY_GATE").toBe(true);
    expect(store.getItem("cleanup-retained")).toMatchObject({ status: "ready", attempts: 0 });
  } finally { await f.close(); }
});

test("optional packing floor refuses old core before dispatch without raising the ordinary CLI floor", async () => {
  const f = fixture(); let version = "0.43.1"; const calls: BrainExecution[] = [];
  const boundary = { isolated: () => true, async run(execution: BrainExecution) {
    calls.push(execution); execution.assertAuthorized?.();
    return { exitCode: 0, stderr: "", stdout: execution.argv.at(-1) === "--version" ? version : JSON.stringify({ schema_version: 1, action: "pack", state: "complete", packed: 1, reason: null }) };
  } } as HostBoundary;
  const client = createBrainClient({ brainPath: f.brain, boundary, exec: {} });
  try {
    await expect(client.storagePack!()).rejects.toThrow("0.44.0");
    expect(calls.some(value => value.argv.includes("pack")), "STORAGE_PACK_VERSION_BEFORE_EFFECT").toBe(false);
    version = STORAGE_PACK_CLI_VERSION;
    await client.storagePack!();
    const command = calls.find(value => value.argv.includes("pack"))!;
    expect(command).toMatchObject({ credentials: false, gate: "shared", outputBytes: 1_048_576 });
    expect(command.argv.slice(-3), "STORAGE_PACK_FIXED_ARGV").toEqual(["storage", "pack", "--json"]);
  } finally { await f.close(); }
});

test("a killed owner leaves a restart-readable unknown receipt and is never automatically retried", async () => {
  const f = fixture(), marker = join(f.brain, "owner-effect"), id = "odysseus-crash-001";
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/storage-maintenance-worker.ts"), f.dbPath, f.brain, marker, id], { stdout: "pipe", stderr: "pipe" });
  try {
    for (let i = 0; i < 500 && !existsSync(marker); i++) await Bun.sleep(10);
    expect(existsSync(marker), "STORAGE_MAINTENANCE_CRASH_REACHED_OWNER").toBe(true);
    child.kill("SIGKILL"); await child.exited;
    const result = f.operations.receipt("odysseus", id);
    expect(result.state, "STORAGE_MAINTENANCE_CRASH_IS_UNKNOWN").toBe("unknown");
    expect(result.startedAt).not.toBeNull();
    expect(f.operations.start("odysseus", { id, operation: "pack-git" }).state).toBe("unknown");
    await f.operations.idle(); expect(f.calls, "STORAGE_MAINTENANCE_CRASH_NO_REPLAY").toBe(0);
  } finally { child.kill("SIGKILL"); await child.exited; await f.close(); }
});

test("another database connection can cancel an admitted operation without claiming its effects rolled back", async () => {
  const f = fixture(), secondDb = createUiDb(f.dbPath), second = createStorageMaintenance(secondDb, f.options);
  let entered = false;
  f.options.brain.storagePack = async request => { entered = true; await new Promise<void>((_, reject) => {
    const abort = () => reject(Error("owner interrupted")); request?.signal?.addEventListener("abort", abort, { once: true }); if (request?.signal?.aborted) abort();
  }); };
  try {
    const id = "odysseus-cancel-001"; f.operations.start("odysseus", { id, operation: "pack-git" });
    for (let i = 0; i < 500 && !entered; i++) await Bun.sleep(10);
    expect(entered).toBe(true); second.cancel("odysseus", id); await f.operations.idle();
    expect(second.receipt("odysseus", id).state, "STORAGE_MAINTENANCE_REMOTE_CANCEL_UNKNOWN").toBe("unknown");
  } finally { await second.close(); secondDb.close(); await f.close(); }
});

test("suspended pin refresh and partial scratch reports retain their owner's meaning", async () => {
  const { ScratchPruneSuspended } = await import("../src/cron/scratch-prune"), { BrainMaintenanceError } = await import("../src/brain/client");
  const f = fixture();
  try {
    f.options.scratch.run = async () => { throw new ScratchPruneSuspended("incomplete"); };
    f.operations.start("odysseus", { id: "odysseus-pins-0001", operation: "prune-scratch" }); await f.operations.idle();
    expect(f.operations.receipt("odysseus", "odysseus-pins-0001"), "STORAGE_PINS_SUSPENSION_RECEIPT").toMatchObject({ state: "refused", reason: "pins_refresh_incomplete", outcome: { suspended: true } });
    f.options.scratch.run = async () => { throw new BrainMaintenanceError("partial", JSON.stringify({ action: "prune", removed: [{ path: ".brain/scratch/removed.txt", bytes: 6 }], failed: [{ path: ".brain/scratch/kept.txt" }], bytes: 6, files: 1, pinned: { files: 1, bytes: 6 }, overageBytes: 2 }), 2); };
    f.operations.start("odysseus", { id: "odysseus-partial-01", operation: "prune-scratch" }); await f.operations.idle();
    expect(f.operations.receipt("odysseus", "odysseus-partial-01"), "STORAGE_PARTIAL_OWNER_REPORT_RETAINED").toMatchObject({ state: "partial", outcome: { removed: 1, failed: 1, pinnedFiles: 1, overageBytes: 2 } });
  } finally { await f.close(); }
});


test("manual staging cancellation finishes its current acknowledgement and preserves the next item", async () => {
  const f = fixture(), controller = new AbortController(), now = Date.now();
  const { SHARE_STAGING_DIR } = await import("@schlessera/brain-ui-sdk/protocol");
  const store = createInboxStore(f.db), targets: string[] = [];
  for (const suffix of ["a", "b"]) {
    const stagingId = `12345678-1234-1234-1234-123456789ab${suffix}`, target = join(f.brain, SHARE_STAGING_DIR, stagingId);
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, "chart.txt"), "Ithaca"); targets.push(target);
    const item = store.ingest({ threadId: suffix, itemId: `share-${suffix}`, dedupKey: suffix, source: "share", stagingId, stakes: 2, expiresAt: now + 86_400_000 }).item;
    store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "claimed", leaseUntil: now + 60_000 }]);
    store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version + 1, to: "done" }]);
    store.commit([{ kind: "item", item: { id: `cleanup-${suffix}`, dedupKey: `cleanup-${suffix}`, threadId: suffix, queue: "queue", type: "cleanup_pending", status: "ready", attempts: 0, maxAttempts: 3, version: 1, createdAt: now, updatedAt: now, expiresAt: Number.MAX_SAFE_INTEGER, payload: { stagingId } } }]);
  }
  const cleanup = createInboxCleanup(f.db, f.brain, { async afterRemove() { controller.abort(); } });
  try {
    const result = await cleanup.run({ signal: controller.signal });
    expect(result).toMatchObject({ cleaned: 1, cancelled: true });
    expect(store.getItem("cleanup-a"), "STORAGE_CANCEL_ACKNOWLEDGES_COMMITTED_ITEM").toMatchObject({ status: "done" });
    expect(existsSync(targets[0]!)).toBe(false);
    expect(existsSync(targets[1]!), "STORAGE_CANCEL_STOPS_NEXT_ITEM").toBe(true);
    expect(store.getItem("cleanup-b")).toMatchObject({ status: "ready", attempts: 0 });
  } finally { await cleanup.close(); await f.close(); }
});

test("a failed durable per-item intent prevents staging removal", async () => {
  const f = fixture(), now = Date.now(), stagingId = "12345678-1234-1234-1234-123456789abc";
  const { SHARE_STAGING_DIR } = await import("@schlessera/brain-ui-sdk/protocol");
  const target = join(f.brain, SHARE_STAGING_DIR, stagingId), store = createInboxStore(f.db);
  mkdirSync(target, { recursive: true }); writeFileSync(join(target, "chart.txt"), "Ithaca");
  const item = store.ingest({ threadId: "harbor", itemId: "share", dedupKey: "share", source: "share", stagingId, stakes: 2, expiresAt: now + 86_400_000 }).item;
  store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "claimed", leaseUntil: now + 60_000 }]);
  store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version + 1, to: "done" }]);
  store.commit([{ kind: "item", item: { id: "cleanup-harbor", dedupKey: "cleanup-harbor", threadId: "harbor", queue: "queue", type: "cleanup_pending", status: "ready", attempts: 0, maxAttempts: 3, version: 1, createdAt: now, updatedAt: now, expiresAt: Number.MAX_SAFE_INTEGER, payload: { stagingId } } }]);
  f.db.exec("CREATE TRIGGER refuse_item_intent BEFORE UPDATE ON storage_maintenance_operations WHEN json_array_length(NEW.receipt, '$.outcome.items') > 0 BEGIN SELECT RAISE(ABORT,'SQLITE_FULL'); END");
  try {
    f.operations.start("odysseus", { id: "odysseus-intent-001", operation: "cleanup-staging" }); await f.operations.idle();
    expect(existsSync(target), "STORAGE_ITEM_INTENT_BEFORE_REMOVE").toBe(true);
    expect(f.operations.receipt("odysseus", "odysseus-intent-001").state).toBe("unknown");
    expect(store.getItem("cleanup-harbor")).toMatchObject({ status: "claimed" });
  } finally { await f.close(); }
});


test("bounded packing refuses a host-only boundary before probing repository code", async () => {
  const f = fixture(), marker = join(f.root, "host-probe-entered"), bin = join(f.brain, "node_modules", ".bin", "brain");
  const { chmodSync } = await import("node:fs"); mkdirSync(join(f.brain, "node_modules", ".bin"), { recursive: true });
  writeFileSync(bin, `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)},"unexpected host evaluation");console.log("0.44.0");\n`); chmodSync(bin, 0o700);
  const boundary = { isolated: () => false, async run() { throw Error("worker unavailable"); } } as unknown as HostBoundary;
  const client = createBrainClient({ brainPath: f.brain, boundary, exec: {} });
  try {
    await expect(client.storagePack!()).rejects.toThrow();
    expect(existsSync(marker), "STORAGE_BOUNDED_PROBE_NEVER_RUNS_ON_HOST").toBe(false);
  } finally { await f.close(); }
});

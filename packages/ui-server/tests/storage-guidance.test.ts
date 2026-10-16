import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateSignedCookie } from "hono/cookie";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createStorageHistory } from "../src/storage/history-store.js";
import { createSharedStorageScan } from "../src/storage/shared-scan.js";
import { createStorageCoordinator } from "../src/storage/coordinator.js";
import { createStorageNotifier } from "../src/storage/notify.js";
import { createStorageSampling } from "../src/storage/sampling.js";
import { createPushSender } from "../src/activity/push-sender.js";
import { aggregateCollection, RECENT, hashScope, type Aggregate } from "../src/storage/history-model.js";
import { exportInboxSnapshot, restoreInboxSnapshot } from "../src/inbox/snapshot.js";
import { httpContractApp } from "./helpers/http-contract-app.js";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("mounted named history and guidance are read-only and require current human-owner authority", async () => {
  const secret = "storage-odysseus-history-secret-0123456789";
  const f = await httpContractApp({ env: { AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "unused-fixture-hash", COOKIE_SECRET: secret, BRAIN_UI_ALLOW_LOOPBACK_ORIGIN: "1" } }); cleanup.push(() => f.close());
  const owner = createPrincipal(f.app.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 }), agent = createPrincipal(f.app.db, { authMethod: "delegated", createdBy: owner.id, label: "Athena", ttlSeconds: 3600 });
  const cookie = async (id: string) => (await generateSignedCookie("brain_ui_session", id, secret)).split(";")[0]!;
  const ownerHeaders = { cookie: await cookie(owner.id) }, agentHeaders = { cookie: await cookie(agent.id) };
  const count = () => f.app.db.query("SELECT COUNT(*) AS count FROM storage_scan_leases").get();
  for (const path of ["/api/storage/history", "/api/storage/guidance"]) {
    expect((await f.fetch(path)).status).toBe(401);
    expect((await f.fetch(path, { headers: agentHeaders })).status, "STORAGE_HISTORY_AGENT_DENIED").toBe(403);
    const response = await f.fetch(path, { headers: ownerHeaders });
    expect(response.status, "STORAGE_NAMED_GUIDANCE_MOUNTED").toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ version: 1, pending: false });
  }
  expect(count(), "STORAGE_HISTORY_READ_NEVER_SCANS").toEqual({ count: 0 });
  expect((await f.fetch("/api/storage/scans", { method: "POST", headers: { ...ownerHeaders, "content-type": "application/json" }, body: "{}" })).status).toBe(202);
  let status: any;
  for (let i = 0; i < 100; i++) { status = await (await f.fetch("/api/storage", { headers: ownerHeaders })).json(); if (status.state === "idle") break; await Bun.sleep(20); }
  expect(status.snapshot).not.toBeNull();
  const history = await (await f.fetch("/api/storage/history", { headers: ownerHeaders })).json();
  expect(history.observations).toHaveLength(3);
  expect(history.observations[0]).toMatchObject({ tier: "six-hour", source: "refresh", basis: "storage-v1", at: status.snapshot.observedAt });
  expect(history.observations[0].capacities[0]).toHaveProperty("owners.app.logical");
  const text = JSON.stringify(history); expect(text).not.toContain(f.brainPath); expect(text).not.toContain("notes/arrival.md"); expect(text).not.toContain("salt");
  revokePrincipal(f.app.db, owner.id, Date.now());
  for (const path of ["/api/storage/history", "/api/storage/guidance"]) expect((await f.fetch(path, { headers: ownerHeaders })).status, "STORAGE_GUIDANCE_REVOKED").toBe(401);
});

test("real sampler waits for a future six-hour boundary, coalesces owners and does no outage catch-up", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-sampling-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain"), cache = join(root, "cache"); mkdirSync(join(brain, ".git/objects"), { recursive: true }); mkdirSync(join(brain, ".git/refs/heads"), { recursive: true }); writeFileSync(join(brain, ".git/HEAD"), "ref: refs/heads/main\n"); writeFileSync(join(brain, "Odysseus.md"), "# Odysseus\n");
  const db = createUiDb(join(root, "operations.sqlite")); cleanup.push(() => db.close());
  let owner = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 365 * 24 * 3600 });
  const history = createStorageHistory(db, brain), shared = createSharedStorageScan(db, brain, cache, id => id === owner.id);
  let count = 0;
  const storage = createStorageCoordinator({ brainPath: brain, stores: [], shared, salt: history.salt, authorized: id => id === owner.id,
    onCollection(value, source) { count++; history.offer(aggregateCollection(value, source, "0.44.0")); } }); cleanup.push(() => storage.close());
  const notices = createStorageNotifier(db, history), sender = createPushSender(db, { send: async () => { throw Error("No destination belongs to this fixture"); } });
  const boot = Date.now(), sampling = createStorageSampling(db, storage, history, shared, notices, sender, boot); cleanup.push(() => sampling.close());
  sampling.tick(boot); await storage.idle(); expect(count, "STORAGE_NO_BOOT_SCAN").toBe(0); expect(existsSync(cache)).toBe(false);
  await sampling.close();
  const started = spyOn(storage, "start"); cleanup.push(() => started.mockRestore());
  // A sleeping process wakes after thirty missed buckets. Its current tick
  // reaches the real coordinator once, without replaying those old intervals.
  const waking = createStorageSampling(db, storage, history, shared, notices, sender, boot - 30 * RECENT); cleanup.push(() => waking.close());
  revokePrincipal(db, owner.id, boot);
  waking.tick(boot); await storage.idle(); expect(count).toBe(0);
  owner = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 365 * 24 * 3600 });
  waking.tick(boot + 1); waking.tick(boot + 2); await storage.idle();
  expect(count, "STORAGE_SCHEDULE_SINGLE_COLLECTION").toBe(1);
  expect(started, "STORAGE_NO_OUTAGE_CATCHUP_REQUESTS").toHaveBeenCalledTimes(1);
  expect(started).toHaveBeenCalledWith(owner.id, true, 0);
  waking.tick(boot - 1); await storage.idle(); expect(count).toBe(1);
  expect(history.read()!.samples).toHaveLength(3);
  await waking.close(); waking.tick(boot + RECENT); expect(started).toHaveBeenCalledTimes(1);
});

test("operational export/restore carries history but suppresses old pending, accepted and uncertain episode authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-restore-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain"); mkdirSync(brain); const path = join(root, "source.sqlite"), db = createUiDb(path); cleanup.push(() => db.close());
  const at = Date.now(), history = createStorageHistory(db, brain, { now: () => at }), scope = hashScope("Odysseus stores");
  const value: Aggregate = { at, startedAt: at, source: 1, descriptor: ["0.44.0", scope, 1], coverage: 0, reason: 0, capacities: [{ descriptor: [hashScope("Odysseus volume"), scope], values: [1000, 960, 40, 40, 0, 1, 4096, 1, 4096, 0, 0, 2, 8192] }] };
  history.offer(value); const episode = history.read()!.metadata.state.pressures[0]!.episode!;
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const sender = createPushSender(db, { send: async () => {} });
  for (const state of ["pending", "accepted", "unknown"] as const) {
    const endpoint = `https://push.example.test/${state}`; sender.subscribe({ endpoint, keys: { p256dh: "opaque", auth: "opaque" } }, owner.id);
    db.query("INSERT INTO storage_notice_receipts (brain, episode, endpoint, principal_id, state, attempts) VALUES (?, ?, ?, ?, ?, ?)").run(history.brain, episode, endpoint, owner.id, state, state === "pending" ? 0 : 1);
  }
  const snapshot = await exportInboxSnapshot(db, brain, at), destination = join(root, "restored.sqlite");
  await restoreInboxSnapshot(snapshot, destination, brain, at + 60_000);
  const restoredDb = createUiDb(destination); cleanup.push(() => restoredDb.close());
  const restored = createStorageHistory(restoredDb, brain, { now: () => at + 120_000 });
  expect(restored.read()!.samples).toEqual(history.read()!.samples);
  expect(restored.read()!.metadata.state.suppressedEpisodes, "STORAGE_ACTUAL_RESTORE_SUPPRESSES_EPISODE").toContain(episode);
  expect(restoredDb.query("SELECT state FROM storage_notice_receipts ORDER BY endpoint").all()).toEqual([{ state: "accepted" }, { state: "suppressed" }, { state: "unknown" }]);
  restored.offer({ ...value, at: at + 120_000, startedAt: at + 120_000 });
  restoredDb.query("UPDATE push_subscriptions SET time_zone = 'UTC'").run();
  const notices = createStorageNotifier(restoredDb, restored);
  for (const name of ["pending", "accepted", "unknown"]) expect(notices.begin(`https://push.example.test/${name}`, at + 120_000), "STORAGE_RESTORED_HISTORY_HAS_NO_SEND_AUTHORITY").toBeNull();
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createPushSender } from "../src/activity/push-sender.js";
import { createActionNotifier } from "../src/inbox/notify.js";
import { createStorageHistory, invalidateRestoredStorage } from "../src/storage/history-store.js";
import { createStorageNotifier } from "../src/storage/notify.js";
import { hashScope, HOUR, type Aggregate } from "../src/storage/history-model.js";
const close: Array<() => void> = [];
afterEach(() => { for (const f of close.splice(0).reverse()) f(); });
const start = Date.UTC(2026, 6, 12, 9, 41), scope = hashScope("Odysseus stores");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-notices-")); close.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "operations.sqlite"), db = createUiDb(path); close.push(() => db.close());
  let now = start, mode: "accepted" | "failed" | "unknown" = "accepted";
  let before: ((endpoint: string) => void) | null = null;
  const sent: Array<{ endpoint: string; payload: Record<string, unknown>; p256dh: string }> = [];
  const history = createStorageHistory(db, root, { now: () => now }), notices = createStorageNotifier(db, history);
  const sender = createPushSender(db, { send: async (sub, payload) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), p256dh: sub.keys.p256dh }); before?.(sub.endpoint);
    if (mode === "failed") throw Object.assign(Error("provider refused"), { statusCode: 500 });
    if (mode === "unknown") throw Error("reply unavailable");
  } });
  const owner = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 365 * 24 * 3600 });
  const zones = createActionNotifier(db, { now: () => now });
  const device = (name: string, zone: string | null = "UTC", principalId = owner.id) => {
    const endpoint = `https://push.example.test/${name}`;
    expect(sender.subscribe({ endpoint, keys: { p256dh: name, auth: "opaque" } }, principalId)).toBe(true);
    if (zone) zones.reportDeviceZone(principalId, endpoint, zone, now);
    return endpoint;
  };
  function observe(at: number, available = 5000, capacities = 1) {
    now = at;
    const value: Aggregate = { at, startedAt: at - 10, source: 1, descriptor: ["0.44.0", scope, 1], coverage: 0, reason: 0,
      capacities: Array.from({ length: capacities }, (_, index) => ({ descriptor: [hashScope(`Odysseus volume ${index}`), scope], values: [100_000, 100_000 - available, available, available, 0, 1, 4096, 1, 4096, 0, 0, 2, 8192] })) };
    history.offer(value);
  }
  return { root, path, db, owner, history, notices, sender, sent, zones, device, observe,
    at(value: number) { now = value; }, mode(value: typeof mode) { mode = value; }, before(value: typeof before) { before = value; },
    deliver: () => sender.deliverStorage(notices, now) };
}
test("multiple Critical capacities coalesce into one generic push and durably record every episode", async () => {
  const f = fixture(); f.device("Ithaca"); f.observe(start, 5000, 4);
  expect(await f.deliver()).toBe(1); expect(f.sent).toHaveLength(1);
  expect(f.sent[0]!.payload).toEqual({ title: "Storage needs attention.", body: "Open Storage for details.", tag: expect.stringMatching(/^brain-storage:[a-f0-9]{32}$/), url: "/#/settings/storage" });
  const rows = f.notices.receipts(f.owner.id, start); expect(rows).toHaveLength(4); expect(rows.every(row => row.state === "accepted" && row.attempts === 1)).toBe(true);
  expect(await f.deliver(), "STORAGE_PUSH_DURABLE_DEDUP").toBe(0);
  const db = createUiDb(f.path); close.push(() => db.close());
  const other = createStorageNotifier(db, createStorageHistory(db, f.root));
  expect(await f.sender.deliverStorage(other, start + 60_000)).toBe(0);
});
test("known refusal retries only after one/five minutes and never after the third attempt", async () => {
  const f = fixture(); f.device("Ithaca"); f.observe(start); f.mode("failed");
  expect(await f.deliver()).toBe(1);
  f.at(start + 59_999); expect(await f.deliver()).toBe(0);
  f.at(start + 60_000); expect(await f.deliver()).toBe(1);
  f.at(start + 359_999); expect(await f.deliver()).toBe(0);
  f.at(start + 360_000); expect(await f.deliver()).toBe(1);
  f.at(start + HOUR); expect(await f.deliver()).toBe(0);
  expect(f.notices.receipts(f.owner.id, start + HOUR)[0]).toMatchObject({ state: "failed", attempts: 3, nextAt: null });
});
test("ambiguous acceptance and an abandoned durable intent never trigger an automatic retry", async () => {
  const f = fixture(), endpoint = f.device("Ithaca"); f.observe(start); f.mode("unknown");
  await f.deliver(); f.at(start + HOUR); expect(await f.deliver()).toBe(0);
  expect(f.notices.receipts(f.owner.id, start + HOUR)[0]?.state).toBe("unknown");
  const other = f.device("Troy");
  const attempt = f.notices.begin(other, start + HOUR); expect(attempt).not.toBeNull();
  f.db.query("UPDATE storage_notice_receipts SET pid = 2147483647, process_start = 'missing' WHERE endpoint = ?").run(other);
  expect(f.notices.begin(other, start + HOUR + 1), "STORAGE_PUSH_ABANDONED_INTENT_UNKNOWN").toBeNull();
  expect(f.notices.receipts(f.owner.id, start + HOUR).filter(row => row.state === "unknown")).toHaveLength(2);
  expect(f.sent.map(row => row.endpoint)).toEqual([endpoint]);
});
test("unknown zone, strict quiet hours, stale evidence and clock reversal defer without delivery scans", async () => {
  const f = fixture(), endpoint = f.device("Ithaca", null); f.observe(start);
  expect(await f.deliver()).toBe(0);
  f.zones.reportDeviceZone(f.owner.id, endpoint, "Europe/Athens", start);
  const evening = Date.UTC(2026, 6, 12, 19); f.observe(evening); expect(await f.deliver()).toBe(0);
  f.at(Date.UTC(2026, 6, 13, 4, 59, 59)); expect(await f.deliver()).toBe(0);
  const morning = Date.UTC(2026, 6, 13, 5); f.at(morning); expect(await f.deliver()).toBe(0); // stale, no delivery-only refresh
  f.observe(morning); f.at(morning - 1); expect(await f.deliver()).toBe(0);
  f.at(morning); expect(await f.deliver()).toBe(1);
});
test("DST boundaries use the destination's authenticated current timezone", async () => {
  const f = fixture(); f.device("Ithaca", "Europe/Athens");
  f.observe(Date.UTC(2026, 9, 24, 19)); expect(await f.deliver()).toBe(0); // 22:00 before fallback
  f.observe(Date.UTC(2026, 9, 25, 1)); expect(await f.deliver()).toBe(0); // repeated 03:00
  f.observe(Date.UTC(2026, 9, 25, 5, 59)); expect(await f.deliver()).toBe(0);
  f.observe(Date.UTC(2026, 9, 25, 6)); expect(await f.deliver()).toBe(1); // 08:00 after fallback
});
test("revocation and rebinding are rechecked for each actual transport attempt", async () => {
  const f = fixture(), first = f.device("Ithaca"), second = f.device("Troy"); f.observe(start);
  f.before(endpoint => { if (endpoint === first) revokePrincipal(f.db, f.owner.id, start); });
  expect(await f.deliver(), "STORAGE_PUSH_CURRENT_OWNER_AUTHORITY").toBe(1);
  expect(f.sent.map(row => row.endpoint)).toEqual([first]);
  expect(() => f.notices.receipts(f.owner.id, start)).toThrow();
  const other = fixture(), one = other.device("Ithaca"), two = other.device("Troy"); other.observe(start);
  other.before(endpoint => { if (endpoint === one) other.sender.subscribe({ endpoint: two, keys: { p256dh: "new-key", auth: "new-auth" } }, other.owner.id); });
  expect(await other.deliver()).toBe(2); expect(other.sent.find(row => row.endpoint === two)?.p256dh).toBe("new-key");
  expect(second).toContain("Troy");
});
test("confirmed recovery suppresses pending notices and restoration never replays an old pending episode", async () => {
  const f = fixture(); f.device("Ithaca", null); f.observe(start); await f.deliver();
  f.observe(start + 60_000, 8000); f.observe(start + 120_000, 8000); await f.deliver();
  expect(f.notices.receipts(f.owner.id, start + 120_000)[0]?.state).toBe("suppressed");
  const other = fixture(), endpoint = other.device("Troy", null); other.observe(start); await other.deliver();
  other.db.transaction(() => invalidateRestoredStorage(other.db, start + 60_000)).immediate();
  other.zones.reportDeviceZone(other.owner.id, endpoint, "UTC", start + 60_000);
  other.observe(start + 120_000); expect(await other.deliver(), "STORAGE_PUSH_RESTORE_NEVER_REPLAYS").toBe(0);
  expect(other.sent).toHaveLength(0);
});

test("delegated principals cannot dispatch or read Storage notice receipts", async () => {
  const f = fixture();
  const agent = createPrincipal(f.db, { authMethod: "delegated", createdBy: f.owner.id, label: "Odysseus agent", ttlSeconds: 3600 });
  f.device("Troy", "UTC", agent.id); f.observe(start);
  expect(await f.deliver(), "STORAGE_PUSH_DELEGATED_OWNER_DENIED").toBe(0);
  expect(() => f.notices.receipts(agent.id, start)).toThrow();
  expect(f.db.query("SELECT COUNT(*) AS count FROM storage_notice_receipts").get()).toEqual({ count: 0 });
});

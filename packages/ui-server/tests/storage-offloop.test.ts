import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createPrincipal } from "../src/db/principals.js";
import { createStorageHistory, type StorageWriteReport } from "../src/storage/history-store.js";
import { createStorageNotifier } from "../src/storage/notify.js";
import { createStorageSampling } from "../src/storage/sampling.js";
import { createStorageCoordinator } from "../src/storage/coordinator.js";
import { createSharedStorageScan } from "../src/storage/shared-scan.js";
import { createPushSender } from "../src/activity/push-sender.js";
import { HISTORY_LIMITS, jsonBytes, hashScope, type Aggregate } from "../src/storage/history-model.js";
import { watchWriteSites } from "./helpers/write-sites.js";
import * as probe from "./fixtures/write-worker-probe.js";
import { watchRetainedErrors } from "./helpers/retained-errors.js";
import { rejection } from "./helpers/expect-rejection.js";

const start = Date.UTC(2026, 6, 12, 9, 41), scope = hashScope("Odysseus stores");
function observation(at: number): Aggregate {
  return { at, startedAt: at, source: 1, descriptor: ["0.44.0", scope, 1], coverage: 0, reason: 0,
    capacities: [{ descriptor: [hashScope("Ithaca volume"), scope], values: [100_000, 95_000, 5000, 5000, 0, 1, 4096, 1, 4096, 0, 0, 2, 8192] }] };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-offloop-"));
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db);
  let now = start;
  return { root, db, writer, now: () => now, advance(at: number) { now = at; },
    async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("storage initialization, flush, begin, finish and sweep commit on the worker at FULL", async () => {
  const f = fixture();
  try {
    const owner = createPrincipal(f.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 365 * 24 * 3600 });
    const endpoint = "https://push.example.test/Ithaca";
    f.db.query("INSERT INTO push_subscriptions (endpoint, p256dh, auth, principal_id, time_zone, created_at) VALUES (?, 'opaque-key', 'opaque-auth', ?, 'UTC', ?)").run(endpoint, owner.id, start);
    const sites = await watchWriteSites(f.db, f.writer, ["storage_history", "storage_notice_receipts"]);
    expect(f.writer.offloop).toBe(true);
    const history = createStorageHistory(f.db, f.root, { now: f.now, writer: f.writer });
    await f.writer.idle();
    expect(await sites.log(), "STORAGE_INITIALIZE_COMMITS_ON_WORKER").toEqual(["storage_history"]);
    history.offer(observation(start));
    expect(await history.flush(), "STORAGE_FLUSH_COMMITS_ON_WORKER").toBe(true);
    expect(history.read()!.metadata.state.lastObservedAt).toBe(start);
    const notices = createStorageNotifier(f.db, history, f.writer);
    const attempt = await notices.begin(endpoint, start);
    expect(attempt, "STORAGE_BEGIN_COMMITS_ON_WORKER").not.toBeNull();
    expect(notices.receipts(owner.id, start)[0]).toMatchObject({ state: "sending", attempts: 1 });
    await notices.finish(attempt!.id, "failed", start);
    expect(notices.receipts(owner.id, start)[0], "STORAGE_FINISH_COMMITS_ON_WORKER").toMatchObject({ state: "failed", nextAt: start + 60_000 });
    const retry = await notices.begin(endpoint, start + 60_000);
    expect(retry).not.toBeNull();
    await notices.sweep(start + 120_000);
    expect(notices.receipts(owner.id, start + 120_000)[0], "STORAGE_SWEEP_COMMITS_ON_WORKER").toMatchObject({ state: "unknown", nextAt: null });
    expect(await sites.log(), "STORAGE_ALL_COMMITS_AT_FULL").toEqual([
      "storage_history", "storage_history", "storage_notice_receipts", "storage_notice_receipts",
      "storage_notice_receipts", "storage_notice_receipts", "storage_notice_receipts",
    ]);
  } finally { await f.close(); }
});

test("a held worker keeps flush off the loop and coalesces requests after the in-flight commit", async () => {
  const f = fixture();
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["storage_history", "storage_notice_receipts"]);
    const history = createStorageHistory(f.db, f.root, { now: f.now, writer: f.writer });
    const queue = f.writer.channel(probe, { table: "odysseus_storage_queue" });
    await queue.ready;
    const held = queue.call("slow", "Ithaca", 300);
    history.offer(observation(start));
    const first = history.flush();
    expect(first instanceof Promise, "STORAGE_FLUSH_RETURNS_WITHOUT_LOOP_COMMIT").toBe(true);
    f.advance(start + 60_000);
    history.offer(observation(f.now()));
    const second = history.flush();
    expect(second, "STORAGE_FLUSH_REQUESTS_COALESCED").toBe(first);
    expect(history.status().pending, "STORAGE_PENDING_INCLUDES_IN_FLIGHT").toBe(true);
    let committed = false;
    void Promise.resolve(first).then(() => { committed = true; });
    await Bun.sleep(20);
    expect(committed, "STORAGE_HELD_FLUSH_DOES_NOT_BLOCK_LOOP").toBe(false);
    expect(history.read()!.metadata.state.lastObservedAt).toBe(0);
    await held;
    expect(await second, "STORAGE_COALESCED_FLUSH_RUNS_AFTER_FIRST").toBe(true);
    expect(history.read()!.metadata.state.lastObservedAt).toBe(start + 60_000);
    expect(f.db.query("SELECT revision FROM storage_history").get(), "STORAGE_EXACTLY_TWO_ORDERED_FLUSH_COMMITS").toEqual({ revision: 2 });
    expect(await sites.log()).toEqual(["storage_history", "storage_history", "storage_history"]);
    expect(history.status().pending).toBe(false);
  } finally { await f.close(); }
});

test("sampling ticks submit without waiting or overlapping and close awaits the final flush", async () => {
  const f = fixture();
  const history = createStorageHistory(f.db, f.root, { now: f.now, writer: f.writer });
  const shared = createSharedStorageScan(f.db, f.root, join(f.root, "cache"), () => false);
  const storage = createStorageCoordinator({ brainPath: f.root, stores: [], shared, salt: history.salt, authorized: () => false });
  const notices = createStorageNotifier(f.db, history, f.writer);
  const sender = createPushSender(f.db, { send: async () => { throw Error("No Ithaca destination"); } });
  const sampling = createStorageSampling(f.db, storage, history, shared, notices, sender, start);
  const flush = spyOn(history, "flush"), sweep = spyOn(notices, "sweep");
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["storage_history", "storage_notice_receipts"]);
    history.offer(observation(start)); await history.flush();
    f.advance(start + 1); history.offer(observation(f.now())); await history.flush();
    const queue = f.writer.channel(probe, { table: "odysseus_sampling_queue" }); await queue.ready;
    const held = queue.call("slow", "Ithaca", 300);
    f.advance(start + 60_000); flush.mockClear(); sweep.mockClear();
    const result = sampling.tick(f.now());
    sampling.tick(f.now()); sampling.tick(f.now());
    expect(result, "STORAGE_TICK_RETURNS_SYNCHRONOUSLY").toBeUndefined();
    expect(flush, "STORAGE_TICK_NEVER_OVERLAPS_FLUSH").toHaveBeenCalledTimes(1);
    expect(sweep, "STORAGE_TICK_NEVER_OVERLAPS_SWEEP").toHaveBeenCalledTimes(1);
    let released = false; void held.then(() => { released = true; });
    await Bun.sleep(20);
    expect(released, "STORAGE_TICK_DOES_NOT_WAIT_FOR_FLUSH_SWEEP").toBe(false);
    expect(history.read()!.metadata.state.lastObservedAt).toBe(start);
    // A final observation arrives while the tick's write is still queued.
    f.advance(start + 120_000); history.offer(observation(f.now()));
    let closed = false;
    const closing = sampling.close().then(() => { closed = true; });
    await Bun.sleep(20);
    expect(closed, "STORAGE_CLOSE_WAITS_FOR_FINAL_FLUSH").toBe(false);
    await closing;
    expect(history.read()!.metadata.state.lastObservedAt, "STORAGE_CLOSE_PRESERVES_LAST_OBSERVATION").toBe(start + 120_000);
    expect(history.status().pending).toBe(false);
    expect((await sites.log()).filter(table => table === "storage_history")).toHaveLength(3);
  } finally { flush.mockRestore(); sweep.mockRestore(); await sampling.close(); await storage.close(); await f.close(); }
});

test("worker begin returns the same refusal-free shape as inline begin on identical inputs", async () => {
  const f = fixture();
  try {
    const history = createStorageHistory(f.db, f.root, { now: f.now });
    history.offer(observation(start));
    const owner = createPrincipal(f.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 365 * 24 * 3600 });
    const endpoint = "https://push.example.test/Ithaca";
    f.db.query("INSERT INTO push_subscriptions (endpoint, p256dh, auth, principal_id, time_zone, created_at) VALUES (?, 'opaque-key', 'opaque-auth', ?, 'UTC', ?)").run(endpoint, owner.id, start);
    const inline = createStorageNotifier(f.db, history);
    const before = inline.begin(endpoint, start);
    expect(before instanceof Promise, "STORAGE_INLINE_BEGIN_STAYS_SYNCHRONOUS").toBe(false);
    const expected = await before;
    expect(expected).not.toBeNull();
    f.db.query("DELETE FROM storage_notice_receipts").run();
    await watchWriteSites(f.db, f.writer, ["storage_history", "storage_notice_receipts"]);
    const worker = createStorageNotifier(f.db, history, f.writer);
    const actual = await worker.begin(endpoint, start);
    expect(actual, "STORAGE_WORKER_BEGIN_SHAPE_UNCHANGED").toEqual({ ...expected!, id: expect.any(String) });
    expect(actual!.id).toMatch(/^[a-f0-9-]{36}$/);
  } finally { await f.close(); }
});

test("a queued flush cannot clear a newer interruption or buffered owner report", async () => {
  const f = fixture();
  try {
    await watchWriteSites(f.db, f.writer, ["storage_history", "storage_notice_receipts"]);
    const history = createStorageHistory(f.db, f.root, { now: f.now, writer: f.writer });
    const queue = f.writer.channel(probe, { table: "odysseus_evidence_queue" }); await queue.ready;
    const held = queue.call("slow", "Ithaca", 200);
    history.offer(observation(start));
    const flushing = history.flush();
    f.advance(start + 60_000); history.failure(f.now());
    f.advance(start + 120_000); history.offer(observation(f.now()));
    history.ownerWrite({ identity: hashScope("Ithaca volume"), rootScope: scope, target: hashScope("Odysseus attachment"),
      resource: "unknown", at: f.now(), outcome: "no-space" });
    await held; await flushing;
    const stored = history.read()!;
    expect(stored.samples.filter(row => row[3] === f.now()).every(row => row[2] === 1), "STORAGE_IN_FLIGHT_COMPLETION_PRESERVES_INTERRUPTION").toBe(true);
    expect(stored.samples.some(row => row[3] === f.now())).toBe(true);
    expect(stored.metadata.state.pressures[0]!.refusals, "STORAGE_IN_FLIGHT_COMPLETION_PRESERVES_OWNER_REPORT").toEqual([
      { target: hashScope("Odysseus attachment"), resource: "unknown", at: f.now(), successAt: null },
    ]);
    expect(history.status().pending).toBe(false);
  } finally { await f.close(); }
});


test("owner-evidence overflow during a flush remains pending until its marker commits", async () => {
  const f = fixture();
  try {
    await watchWriteSites(f.db, f.writer, ["storage_history", "storage_notice_receipts"]);
    const history = createStorageHistory(f.db, f.root, { now: f.now, writer: f.writer });
    history.offer(observation(start)); await history.flush();
    f.advance(start + 1);
    const reports: StorageWriteReport[] = [];
    const report = (index: number): StorageWriteReport => ({ identity: hashScope("Ithaca volume"), rootScope: scope,
      target: hashScope(`Odysseus attachment ${index}`), resource: "unknown", at: f.now(), outcome: "no-space" });
    while (jsonBytes([...reports, report(reports.length)]) <= HISTORY_LIMITS.metadataBytes) reports.push(report(reports.length));
    for (const value of reports) history.ownerWrite(value);
    await history.flush(); // Still inside the one-minute write interval.
    expect(history.status().paused).toBeNull();
    const queue = f.writer.channel(probe, { table: "odysseus_overflow_queue" }); await queue.ready;
    const held = queue.call("slow", "Ithaca", 200);
    f.advance(start + 60_000);
    const flushing = history.flush();
    history.ownerWrite(report(reports.length));
    await held;
    expect(await flushing).toBe(true);
    expect(history.status(), "STORAGE_IN_FLIGHT_OVERFLOW_REMAINS_PENDING").toMatchObject({ pending: true, paused: "history-owner-evidence-budget" });
    f.advance(start + 120_000);
    expect(await history.flush()).toBe(true);
    expect(history.read()!.metadata.state.paused, "STORAGE_IN_FLIGHT_OVERFLOW_MARKER_COMMITS").toBe("history-owner-evidence-budget");
    expect(history.status().pending).toBe(false);
  } finally { await f.close(); }
});

test("a queued begin decides on the durable history at its commit, not the one at submission", async () => {
  const f = fixture();
  try {
    const owner = createPrincipal(f.db, { authMethod: "password", label: "Odysseus", ttlSeconds: 365 * 24 * 3600 });
    const endpoint = "https://push.example.test/Ithaca";
    f.db.query("INSERT INTO push_subscriptions (endpoint, p256dh, auth, principal_id, time_zone, created_at) VALUES (?, 'opaque-key', 'opaque-auth', ?, 'UTC', ?)").run(endpoint, owner.id, start);
    const history = createStorageHistory(f.db, f.root, { now: f.now, writer: f.writer });
    history.offer(observation(start));
    expect(await history.flush()).toBe(true);
    const notices = createStorageNotifier(f.db, history, f.writer);
    // Another process (the cron runner) persists a newer observation while the attempt waits.
    const later = start + HISTORY_LIMITS.writeInterval + 1;
    const other = createStorageHistory(f.db, f.root, { now: () => later });
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 300);
    const queued = notices.begin(endpoint, start);
    other.offer(observation(later));
    await slow;
    expect(history.read()!.metadata.state.lastPersistedAt).toBe(later);
    expect(await queued, "STORAGE_QUEUED_BEGIN_READS_DURABLE_HISTORY_AT_COMMIT").toBeNull();
  } finally { await f.close(); }
});


for (const mode of ["sync", "async"] as const) test(`sampling retains ${mode} flush, sweep and cleanup failures after settlement and still attempts the final flush`, async () => {
  const f = fixture();
  const history = createStorageHistory(f.db, f.root, { now: f.now, writer: f.writer });
  const shared = createSharedStorageScan(f.db, f.root, join(f.root, "cache"), () => false);
  const storage = createStorageCoordinator({ brainPath: f.root, stores: [], shared, salt: history.salt, authorized: () => false });
  const notices = createStorageNotifier(f.db, history, f.writer);
  const failures = [Error("Odysseus flush refused"), Error("Odysseus sweep refused"), Error("Odysseus cleanup refused")];
  const fail = (error: Error): never | Promise<never> => { if (mode === "sync") throw error; return Promise.reject(error); };
  const flush = spyOn(history, "flush").mockImplementation(() => fail(failures[0]!));
  const sweep = spyOn(notices, "sweep").mockImplementation(() => fail(failures[1]!));
  const clean = spyOn(shared, "cleanupCache").mockImplementation(() => fail(failures[2]!));
  const sampling = createStorageSampling(f.db, storage, history, shared, notices, { deliverStorage: async () => 0 }, start);
  try {
    sampling.tick(start + 60_000);
    await new Promise(resolve => setTimeout(resolve, 20));
    const closing = sampling.close();
    expect(sampling.close(), "SAMPLER_CONCURRENT_CLOSE_JOINS").toBe(closing);
    const error = await closing.then(() => undefined, error => error);
    expect(error, "SAMPLER_RETAINS_SETTLED_WRITE_AND_CLEANUP_FAILURES").toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(failures);
    expect(flush, "SAMPLER_FINAL_FLUSH_ATTEMPTED_AFTER_FAILURES").toHaveBeenCalledTimes(2);
    expect(await sampling.close().then(() => undefined, error => error)).toBe(error);
    sampling.tick(start + 120_000);
    expect(clean).toHaveBeenCalledTimes(1);
  } finally { flush.mockRestore(); sweep.mockRestore(); clean.mockRestore(); await sampling.close().catch(() => {}); await storage.close(); await f.close(); }
});

for (const mode of ["sync", "async"] as const) test(`sampling ${mode} retry failures retain bounded diagnostics through recovery and late close`, async () => {
  const f = fixture();
  const history = createStorageHistory(f.db, f.root, { now: f.now, writer: f.writer });
  const shared = createSharedStorageScan(f.db, f.root, join(f.root, "cache"), () => false);
  const storage = createStorageCoordinator({ brainPath: f.root, stores: [], shared, salt: history.salt, authorized: () => false });
  const notices = createStorageNotifier(f.db, history, f.writer);
  const errors = Array.from({ length: 80 }, (_, i) => Error(`Odysseus sampling refused ${i}`));
  const retained = watchRetainedErrors(errors);
  let calls = 0, recovered = false;
  const fail = (): never | Promise<never> => { const error = errors[calls++]; if (mode === "sync") throw error; return Promise.reject(error); };
  const flush = spyOn(history, "flush").mockImplementation(() => recovered ? true : fail());
  const sweep = spyOn(notices, "sweep").mockImplementation(() => recovered ? undefined : fail());
  const clean = spyOn(shared, "cleanupCache").mockImplementation(() => recovered ? Promise.resolve() : fail());
  const sampling = createStorageSampling(f.db, storage, history, shared, notices, { deliverStorage: () => recovered ? Promise.resolve(0) : Promise.reject(errors[calls++]) }, start);
  try {
    for (let i = 1; i <= 20; i++) {
      sampling.tick(start + i * 60_000);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(calls).toBe(80);
    recovered = true;
    sampling.tick(start + 21 * 60_000);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(retained.peak(), "SAMPLER_RETRY_ERROR_RETENTION_BOUNDED_WHILE_RUNNING").toBeLessThanOrEqual(4);
    const closing = sampling.close();
    expect(sampling.close()).toBe(closing);
    const failure = await rejection(closing) as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors, "SAMPLER_RETRY_DIAGNOSTICS_BOUNDED").toHaveLength(4);
    expect(failure.errors).toContain(errors[0]);
    expect(failure.cause).toBe(failure.errors[0]);
    expect(failure.message).toContain("80 failed operations");
    expect(failure.message).toContain("representatives");
    expect(await rejection(sampling.close())).toBe(failure);
  } finally { retained.restore(); flush.mockRestore(); sweep.mockRestore(); clean.mockRestore(); await sampling.close().catch(() => {}); await storage.close(); await f.close(); }
});

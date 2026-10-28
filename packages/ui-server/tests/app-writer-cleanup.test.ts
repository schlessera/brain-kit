import * as storageSampling from "../src/storage/sampling.js";
import * as storageHistory from "../src/storage/history-store.js";
import { hashScope } from "../src/storage/history-model.js";
import * as activityRuntime from "../src/activity/runtime.js";
import webpush from "web-push";
import { createPrincipal } from "../src/db/principals.js";
import { createInboxStore } from "../src/inbox/store.js";
import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import * as writers from "../src/db/write-worker.js";
import * as probe from "./fixtures/write-worker-probe.js";
import * as principals from "../src/db/principal-writes.js";
import { createNativeAppFixture } from "./helpers/native-app-fixture.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { rejection } from "./helpers/expect-rejection.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-owned-writer-")), brain = join(root, "brain"), path = join(root, "ui.sqlite");
  mkdirSync(brain);
  const native = createNativeAppFixture(brain);
  const config = { ...resolveServerConfig({ AUTH_MODE: "none", HOST: "127.0.0.1", BRAIN_PATH: brain, DB_PATH: path, BRAIN_UI_PRICING_DISCOVERY: "0" }), nativeBrain: native.nativeBrain };
  const registry = createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]);
  const observability = createRecordingObservability();
  return { root, path, config, registry, observability, async close() { await native.close(); rmSync(root, { recursive: true, force: true }); } };
}

/** Observe the actual worker at the shared send boundary; all messages still execute. */
function observe(path: string) {
  const send = Worker.prototype.postMessage, open = writers.openSqliteWriter;
  const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, "postMessage")!;
  let worker: Worker | undefined, writer: writers.SqliteWriter | undefined, closed = false, closes = 0;
  let acknowledge!: () => void;
  const ended = new Promise<void>(resolve => { acknowledge = resolve; });
  const messages = spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args: [message: unknown, options?: StructuredSerializeOptions | Transferable[]]) {
    const message = args[0] as { kind?: string; path?: string };
    if (message.kind === "open" && message.path === path) {
      // oxlint-disable-next-line typescript/no-this-alias -- Retain the actual Worker identity while forwarding its native method.
      worker = this;
      this.addEventListener("close", () => { closed = true; acknowledge(); }, { once: true });
    }
    if (this === worker && message.kind === "close") closes++;
    return Reflect.apply(send, this, args);
  });
  const acquisition = spyOn(writers, "openSqliteWriter").mockImplementation((db, options) => {
    const result = open(db, options);
    if (db.filename === path) writer = result;
    return result;
  });
  return {
    get worker() { return worker; }, get writer() { return writer!; }, get closes() { return closes; }, get closed() { return closed; },
    async expectClosed() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([ended, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
        expect(closed, "APP_OWNED_SQLITE_WORKER_CLOSED").toBe(true);
      } finally { clearTimeout(timer); }
    },
    async restore() {
      // A red assertion must not leave the real worker behind.
      try { await writer?.close(); if (worker && !closed) await ended; }
      finally { acquisition.mockRestore(); messages.mockRestore(); Object.defineProperty(Worker.prototype, "postMessage", descriptor); }
    },
  };
}

test("ordinary app close stops its real owned worker once and retains queued FULL writes", async () => {
  const f = fixture(), observed = observe(f.path);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp(f);
    expect(observed.worker instanceof Worker, "APP_USES_REAL_SQLITE_WORKER").toBe(true);
    expect(observed.writer.offloop).toBe(true);
    const channel = observed.writer.channel(probe, { table: "odysseus_log" });
    await channel.ready;
    expect(await channel.call<number>("level")).toBe(2);
    const pending = channel.call("slow", "Ithaca", 100);
    const closing = app.close();
    expect(app.close(), "CONCURRENT_APP_CLOSE_SHARES_COMPLETION").toBe(closing);
    expect((await app.fetch(new Request("http://localhost/api/health"))).status).toBe(503);
    expect(await pending, "QUEUED_WRITE_COMMITS_BEFORE_SHUTDOWN").toBe(1);
    await closing;
    // Negative control: an unclosed, unref'ed worker can still execute SQLite.
    if (!observed.closes) {
      const level = await channel.call<number>("level");
      console.info(JSON.stringify({ oracle: "UNCLOSED_OWNED_WORKER_STILL_RESPONDS", synchronous: level }));
      expect(level, "UNCLOSED_OWNED_WORKER_STILL_RESPONDS").toBe(2);
    }
    await observed.expectClosed();
    expect(observed.closes, "OWNED_WRITER_CLOSE_SENT_ONCE").toBe(1);
    await app.close();
    expect(observed.closes).toBe(1);
    expect(() => app!.db.query("SELECT 1").get(), "APP_DATABASE_CLOSED").toThrow();
    expect(await rejection(channel.call("log", "Troy"))).toBeInstanceOf(writers.SqliteWriterClosed);
    const disk = new Database(f.path, { readonly: true });
    try { expect(disk.query("SELECT label FROM odysseus_log").all(), "QUEUED_WRITE_DURABLE_AFTER_CLOSE").toEqual([{ label: "Ithaca" }]); }
    finally { disk.close(); }
  } finally { await app?.close().catch(() => {}); await observed.restore(); await f.close(); }
});

test("borrowed journal close keeps the app writer alive until app shutdown", async () => {
  const f = fixture(), observed = observe(f.path);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp(f);
    await app.wsHost.journal!.close();
    const channel = observed.writer.channel(probe, { table: "odysseus_log" });
    await channel.ready;
    expect(await channel.call<number>("log", "Penelope"), "BORROWED_JOURNAL_LEAVES_SHARED_WRITER_USABLE").toBe(1);
    expect(observed.closed).toBe(false);
    await app.close();
    await observed.expectClosed();
  } finally { await app?.close().catch(() => {}); await observed.restore(); await f.close(); }
});

test("journal cleanup failure still stops the owned worker and preserves the failure", async () => {
  const f = fixture(), observed = observe(f.path);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp(f);
    const journal = app.wsHost.journal!, close = journal.close.bind(journal), failure = Error("Odysseus cleanup refusal");
    journal.close = async () => { await close(); throw failure; };
    expect(await rejection(app.close())).toBe(failure);
    await observed.expectClosed();
    expect(await rejection(app.close())).toBe(failure);
    expect(observed.closes).toBe(1);
    expect(() => app!.db.query("SELECT 1").get()).toThrow();
  } finally { await app?.close().catch(() => {}); await observed.restore(); await f.close(); }
});

test("writer cleanup failure preserves other cleanup and repeated close outcome", async () => {
  const f = fixture(), observed = observe(f.path);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await createApp(f);
    const close = observed.writer.close.bind(observed.writer), failure = Error("Odysseus writer cleanup refusal");
    observed.writer.close = async () => { await close(); throw failure; };
    expect(await rejection(app.close())).toBe(failure);
    await observed.expectClosed();
    expect(() => app!.db.query("SELECT 1").get(), "WRITER_FAILURE_STILL_CLOSES_DATABASE").toThrow();
    expect(await rejection(app.close())).toBe(failure);
    observed.writer.close = close;
  } finally { await app?.close().catch(() => {}); await observed.restore().catch(() => {}); await f.close(); }
});

test("late boot failure stops the real owned writer", async () => {
  const f = fixture(), observed = observe(f.path), meter = f.observability.meter.bind(f.observability), failure = Error("Odysseus late startup refusal");
  f.observability.meter = name => { if (name === "auth") throw failure; return meter(name); };
  try {
    expect(await rejection(createApp(f))).toBe(failure);
    expect(observed.worker instanceof Worker).toBe(true);
    await observed.expectClosed();
    expect(observed.closes).toBe(1);
  } finally { await observed.restore(); await f.close(); }
});


test("startup registration failure closes the writer acquired immediately beforehand", async () => {
  const f = fixture(), observed = observe(f.path), failure = Error("Odysseus registration refusal");
  const registration = spyOn(principals, "registerPrincipalWrites").mockImplementation(() => { throw failure; });
  try {
    expect(await rejection(createApp(f))).toBe(failure);
    expect(observed.worker instanceof Worker).toBe(true);
    await observed.expectClosed();
    expect(observed.closes).toBe(1);
  } finally { registration.mockRestore(); await observed.restore(); await f.close(); }
});

test("multiple shutdown failures retain both errors while closing the database", async () => {
  const f = fixture(), observed = observe(f.path);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let restoreWriter: (() => Promise<void>) | undefined;
  try {
    app = await createApp(f);
    const journal = app.wsHost.journal!, closeJournal = journal.close.bind(journal);
    const journalFailure = Error("Odysseus journal refusal"), writerFailure = Error("Odysseus writer refusal");
    journal.close = async () => { await closeJournal(); throw journalFailure; };
    restoreWriter = observed.writer.close.bind(observed.writer);
    observed.writer.close = async () => { await restoreWriter!(); throw writerFailure; };
    const error = await rejection(app.close());
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([journalFailure, writerFailure]);
    expect(await rejection(app.close())).toBe(error);
    await observed.expectClosed();
    expect(observed.closes).toBe(1);
    expect(() => app!.db.query("SELECT 1").get()).toThrow();
  } finally {
    if (restoreWriter) observed.writer.close = restoreWriter;
    await app?.close().catch(() => {}); await observed.restore(); await f.close();
  }
});

for (const kind of ["activity", "actions"] as const) test(`${kind} acceptance overlapping app close commits before the real worker stops and never resends after reopen`, async () => {
  const f = fixture(), observed = observe(f.path);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let accept!: () => void, started!: () => void;
  const submitted = new Promise<void>(resolve => { started = resolve; });
  const accepted = new Promise<void>(resolve => { accept = resolve; });
  let sends = 0;
  let activity!: activityRuntime.ActivityRuntime;
  const createRuntime = activityRuntime.createActivityRuntime;
  const assembly = spyOn(activityRuntime, "createActivityRuntime").mockImplementation((...args) => { activity = createRuntime(...args); return activity; });
  const transport = spyOn(webpush, "sendNotification").mockImplementation(async () => { sends++; started(); await accepted; return { statusCode: 201, body: "", headers: {} }; });
  let delivery: Promise<number> | undefined;
  try {
    app = await createApp(f);
    const owner = createPrincipal(app.db, { authMethod: "password", label: "Athena", ttlSeconds: 3600 });
    app.db.query("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, principal_id, time_zone) VALUES (?, 'k', 'a', ?, ?, 'UTC')")
      .run("https://push.example.test/ithaca", Date.now(), owner.id);
    if (kind === "activity") {
      await activity.store.startSpan({ runId: "voyage", spanId: "voyage:root", name: "invoke_agent", kind: "turn", origin: "session" });
      await activity.store.endSpan("voyage:root", { outcome: "error" });
      await activity.notifier.tick();
      expect(activity.notifier.pending()).toHaveLength(1);
      delivery = activity.pushSender.deliverPending(activity.notifier);
    } else {
      const now = Date.UTC(2026, 6, 12, 12);
      const store = createInboxStore(app.db, { now: () => now });
      store.ingest({ threadId: "sail", itemId: "sail-triage", source: "cli", dedupKey: "sail-triage", stagingId: "sail-staging", expiresAt: now + 86_400_000, stakes: 3 });
      store.commit([{ kind: "item", item: { id: "sail", dedupKey: "sail", threadId: "sail", queue: "actions", type: "approve", status: "pending", version: 1,
        createdAt: now, updatedAt: now, expiresAt: now + 86_400_000, payload: { title: "Set sail", detail: "Decide before departure." },
        options: [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }] } }]);
      await activity.actionNotices.enroll(now);
      delivery = activity.pushSender.deliverActions(activity.actionNotices, now + 60_000);
    }
    // Observe the real provider call before initiating shutdown; this cannot
    // pass with an empty queue or a delivery that has not started yet.
    await submitted;
    const result = delivery.then(value => ({ value }), error => ({ error }));
    let reached!: () => void;
    const draining = new Promise<void>(resolve => { reached = resolve; });
    const closeActivity = activity.close.bind(activity);
    activity.close = () => { const completion = closeActivity(); reached(); return completion; };
    const closing = app.close();
    expect(app.close()).toBe(closing);
    // A handshake proves shutdown reached the actual Activity close. Keep
    // transport held through another event-loop turn, including on old code.
    await draining;
    await new Promise(resolve => setTimeout(resolve, 20));
    const closedBeforeAcceptance = observed.closes;
    accept();
    await closing;
    const outcome = await result;
    const disk = new Database(f.path, { readonly: true });
    try {
      const receipt = kind === "activity"
        ? disk.query("SELECT status AS outcome FROM notification_intents WHERE run_id = 'voyage'").get()
        : disk.query("SELECT outcome FROM inbox_notice_attempts").get();
      expect(receipt, `${kind.toUpperCase()}_ACCEPTANCE_DURABLE_BEFORE_WRITER_CLOSE`).toEqual({ outcome: kind === "activity" ? "sent" : "success" });
      expect(disk.query("SELECT last_used_at FROM push_subscriptions").get()).not.toEqual({ last_used_at: null });
    } finally { disk.close(); }
    expect(outcome).toEqual({ value: 1 });
    expect(closedBeforeAcceptance, "OWNED_WORKER_REMAINS_OPEN_DURING_ACCEPTANCE").toBe(0);
    await observed.expectClosed();
    expect(sends).toBe(1);
    app = await createApp(f);
    const reopened = activity;
    await reopened.pushSender.deliverPending(reopened.notifier);
    await reopened.pushSender.deliverActions(reopened.actionNotices, Date.UTC(2026, 6, 12, 12, 2));
    expect(sends, "ACCEPTED_NOTICE_NOT_RESENT_AFTER_REOPEN").toBe(1);
  } finally { accept(); await delivery?.catch(() => {}); await app?.close().catch(() => {}); transport.mockRestore(); assembly.mockRestore(); await observed.restore(); await f.close(); }
});

test("Activity close bounds a stalled transport, releases its agent, and joins failed outcome persistence", async () => {
  const f = fixture(), observed = observe(f.path);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let activity!: activityRuntime.ActivityRuntime;
  const createRuntime = activityRuntime.createActivityRuntime;
  const assembly = spyOn(activityRuntime, "createActivityRuntime").mockImplementation((...args) => { activity = createRuntime(...args); return activity; });
  let started!: () => void, release!: () => void;
  const submitted = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let agent: import("node:https").Agent | undefined;
  let destroyed = 0;
  const transport = spyOn(webpush, "sendNotification").mockImplementation(async (_sub, _payload, options) => {
    agent = options!.agent as import("node:https").Agent;
    const destroy = agent.destroy.bind(agent);
    agent.destroy = () => { destroyed++; return destroy(); };
    started(); await pending; return { statusCode: 201, body: "", headers: {} };
  });
  const failure = new Error("Odysseus outcome commit refused");
  let mark: ReturnType<typeof spyOn> | undefined;
  try {
    app = await createApp(f);
    const owner = createPrincipal(app.db, { authMethod: "password", label: "Athena", ttlSeconds: 3600 });
    app.db.query("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, principal_id) VALUES (?, 'k', 'a', 0, ?)")
      .run("https://push.example.test/ithaca", owner.id);
    await activity.store.startSpan({ runId: "voyage", spanId: "voyage:root", name: "invoke_agent", kind: "turn", origin: "session" });
    await activity.store.endSpan("voyage:root", { outcome: "error" });
    await activity.notifier.tick();
    const deliver = activity.pushSender.deliverPending(activity.notifier);
    const result = deliver.catch(error => error);
    await submitted;
    // Persistence is deliberately refused after the real deadline classifies
    // the stalled submission. Shutdown must retain this error and still clean up.
    mark = spyOn(activity.notifier, "markDelivered").mockImplementation(async (_id, status) => {
      expect(status, "DEADLINE_IS_NEVER_PROVIDER_SUCCESS").toBe("send_failed");
      throw failure;
    });
    const at = performance.now();
    const closing = app.close();
    const runtimeClosing = activity.close();
    expect(activity.close(), "CONCURRENT_ACTIVITY_CLOSE_JOINS").toBe(runtimeClosing);
    void runtimeClosing.catch(() => {});
    expect(await rejection(closing), "DELIVERY_COMMIT_FAILURE_RETAINED_BY_APP_CLOSE").toBe(failure);
    expect(await result).toBe(failure);
    expect(performance.now() - at, "PUSH_DRAIN_HAS_AN_ABSOLUTE_DEADLINE").toBeLessThan(15_000);
    expect(destroyed, "DEADLINE_RELEASES_THE_OWNED_TRANSPORT_AGENT").toBeGreaterThan(0);
    expect(await activity.pushSender.deliverPending(activity.notifier), "CLOSED_DELIVERY_REFUSES_NEW_WORK").toBe(0);
    expect(await rejection(app.close())).toBe(failure);
    await observed.expectClosed();
    expect(() => app!.db.query("SELECT 1").get()).toThrow();
  } finally { release(); mark?.mockRestore(); await app?.close().catch(() => {}); transport.mockRestore(); assembly.mockRestore(); await observed.restore(); await f.close(); }
});


for (const kind of ["storage", "activity", "actions"] as const) for (const status of [201, 410, 503, 0]) test(`${kind} tick outcome write failure after transport ${status} before Activity drain rejects app close and still closes its worker`, async () => {
  const f = fixture(), observed = observe(f.path);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let activity!: activityRuntime.ActivityRuntime, history!: storageHistory.StorageHistory;
  let sampler!: ReturnType<typeof storageSampling.createStorageSampling>;
  let storageNotices!: Parameters<typeof storageSampling.createStorageSampling>[4];
  let tick!: () => void, storageTick!: () => void;
  let accept!: () => void, started!: () => void, failed!: (error: unknown) => void, release!: () => void;
  const submitted = new Promise<void>(resolve => { started = resolve; });
  const accepted = new Promise<void>(resolve => { accept = resolve; });
  const refused = new Promise<unknown>(resolve => { failed = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const createRuntime = activityRuntime.createActivityRuntime, createHistory = storageHistory.createStorageHistory, createSampling = storageSampling.createStorageSampling;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "setInterval")!, interval = globalThis.setInterval;
  function capture<T>(run: () => T, save: (callback: () => void) => void): T {
    Object.defineProperty(globalThis, "setInterval", { ...descriptor, value: (callback: () => void, ms: number) => {
      if (ms === 20_000) save(callback);
      return interval(callback, ms);
    } });
    try { return run(); } finally { Object.defineProperty(globalThis, "setInterval", descriptor); }
  }
  const assembly = spyOn(activityRuntime, "createActivityRuntime").mockImplementation((...args) => {
    activity = capture(() => createRuntime(...args), callback => { tick = callback; }); return activity;
  });
  const histories = spyOn(storageHistory, "createStorageHistory").mockImplementation((...args) => { history = createHistory(...args); return history; });
  const sampling = spyOn(storageSampling, "createStorageSampling").mockImplementation((...args) => {
    storageNotices = args[4];
    sampler = capture(() => createSampling(...args), callback => { storageTick = callback; });
    // Activity/Actions fail while an earlier shutdown owner is still held.
    const close = sampler.close.bind(sampler);
    if (kind !== "storage") sampler.close = async () => { await close(); await held; };
    return sampler;
  });
  let sends = 0, finish: ReturnType<typeof spyOn> | undefined;
  const transport = spyOn(webpush, "sendNotification").mockImplementation(async () => {
    sends++; started(); await accepted;
    if (status !== 201) throw Object.assign(Error("Odysseus transport refusal"), status ? { statusCode: status } : {});
    return { statusCode: 201, body: "", headers: {} };
  });
  try {
    app = await createApp(f);
    const now = Date.now(), offset = 12 - new Date(now).getUTCHours();
    const zone = offset === 0 ? "UTC" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
    const owner = createPrincipal(app.db, { authMethod: "password", label: "Athena", ttlSeconds: 3600 });
    app.db.query("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, principal_id, time_zone) VALUES (?, 'k', 'a', ?, ?, ?)")
      .run("https://push.example.test/ithaca", now, owner.id, zone);
    if (kind === "storage") {
      const scope = hashScope("Odysseus stores");
      history.offer({ at: now, startedAt: now, source: 1, descriptor: ["0.44.0", scope, 1], coverage: 0, reason: 0,
        capacities: [{ descriptor: [hashScope("Ithaca volume"), scope], values: [100_000, 95_000, 5000, 5000, 0, 1, 4096, 1, 4096, 0, 0, 2, 8192] }] });
      await history.flush();
      const original = storageNotices.finish.bind(storageNotices);
      finish = spyOn(storageNotices, "finish").mockImplementation((...args) => {
        expect(args[1], "STORAGE_TRANSPORT_OUTCOME_PRESERVED").toBe(status === 201 ? "accepted" : status === 410 ? "gone" : status ? "failed" : "unknown");
        return Promise.resolve(original(...args)).catch(error => { failed(error); throw error; });
      });
      app.db.exec("CREATE TRIGGER odysseus_refuse_outcome BEFORE UPDATE OF state ON storage_notice_receipts WHEN OLD.state = 'sending' BEGIN SELECT RAISE(ABORT, 'Odysseus durable outcome refused'); END");
      storageTick();
    } else if (kind === "activity") {
      await activity.store.startSpan({ runId: "voyage", spanId: "voyage:root", name: "invoke_agent", kind: "turn", origin: "session" });
      await activity.store.endSpan("voyage:root", { outcome: "error" }); await activity.notifier.tick();
      const original = activity.notifier.markDelivered.bind(activity.notifier);
      finish = spyOn(activity.notifier, "markDelivered").mockImplementation((...args) => {
        expect(args[1], "ACTIVITY_TRANSPORT_OUTCOME_PRESERVED").toBe(status === 201 ? "sent" : "send_failed");
        return Promise.resolve(original(...args)).catch(error => { failed(error); throw error; });
      });
      app.db.exec("CREATE TRIGGER odysseus_refuse_outcome BEFORE UPDATE OF status ON notification_intents BEGIN SELECT RAISE(ABORT, 'Odysseus durable outcome refused'); END");
      tick();
    } else {
      const at = now - 120_000, store = createInboxStore(app.db, { now: () => at });
      store.ingest({ threadId: "sail", itemId: "sail-triage", source: "cli", dedupKey: "sail-triage", stagingId: "sail-staging", expiresAt: now + 86_400_000, stakes: 3 });
      store.commit([{ kind: "item", item: { id: "sail", dedupKey: "sail", threadId: "sail", queue: "actions", type: "approve", status: "pending", version: 1,
        createdAt: at, updatedAt: at, expiresAt: now + 86_400_000, payload: { title: "Set sail", detail: "Decide before departure." },
        options: [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }] } }]);
      await activity.actionNotices.enroll(at);
      const original = activity.actionNotices.finishAttempt.bind(activity.actionNotices);
      finish = spyOn(activity.actionNotices, "finishAttempt").mockImplementation((...args) => {
        expect(args[1], "ACTIONS_TRANSPORT_OUTCOME_PRESERVED").toBe(status === 201 ? "success" : status === 410 ? "gone" : status ? "failed" : "ambiguous");
        return Promise.resolve(original(...args)).catch(error => { failed(error); throw error; });
      });
      app.db.exec("CREATE TRIGGER odysseus_refuse_outcome BEFORE UPDATE OF outcome ON inbox_notice_attempts BEGIN SELECT RAISE(ABORT, 'Odysseus durable outcome refused'); END");
      tick();
    }
    await submitted;
    const closing = app.close(), outcome = closing.then(() => undefined, error => error);
    expect(app.close()).toBe(closing);
    expect(observed.closes).toBe(0);
    accept();
    const originalError = await refused;
    expect(originalError).toBeInstanceOf(Error);
    expect((originalError as Error).message).toContain("Odysseus durable outcome refused");
    // Let both the sampler and runtime catches observe settlement before the
    // late Activity drain. The original worker failure must remain owned.
    await new Promise(resolve => setTimeout(resolve, 20));
    release();
    expect(await outcome, `${kind.toUpperCase()}_SETTLED_COMMIT_FAILURE_RETAINED_BY_APP_CLOSE`).toBe(originalError);
    expect(await rejection(app.close())).toBe(originalError);
    await observed.expectClosed();
    expect(observed.closes).toBe(1);
    expect(() => app!.db.query("SELECT 1").get()).toThrow();
    expect(sends, "FAILED_OUTCOME_DOES_NOT_REPEAT_TRANSPORT").toBe(1);
    const disk = new Database(f.path, { readonly: true });
    try {
      const sql = kind === "storage" ? "SELECT state AS outcome FROM storage_notice_receipts" : kind === "activity" ? "SELECT status AS outcome FROM notification_intents" : "SELECT outcome FROM inbox_notice_attempts";
      expect(disk.query(sql).all()).toEqual([{ outcome: kind === "storage" ? "sending" : kind === "activity" ? "pending" : "in_flight" }]);
    } finally { disk.close(); }
  } finally { accept(); release(); await app?.close().catch(() => {}); finish?.mockRestore(); transport.mockRestore(); sampling.mockRestore(); histories.mockRestore(); assembly.mockRestore(); await observed.restore(); await f.close(); }
});


test("failed final history flush still closes history, writer and reader and retains the error", async () => {
  const f = fixture(), observed = observe(f.path);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let history!: storageHistory.StorageHistory;
  const original = storageHistory.createStorageHistory;
  const histories = spyOn(storageHistory, "createStorageHistory").mockImplementation((...args) => { history = original(...args); return history; });
  let flush: ReturnType<typeof spyOn> | undefined, close: ReturnType<typeof spyOn> | undefined;
  try {
    app = await createApp(f);
    const failure = new Error("Odysseus final history flush refused");
    flush = spyOn(history, "flush").mockImplementation(async () => { throw failure; });
    close = spyOn(history, "close");
    const error = await rejection(app.close());
    expect(close, "FAILED_FLUSH_STILL_CLOSES_HISTORY").toHaveBeenCalledTimes(1);
    expect(error, "FINAL_FLUSH_FAILURE_RETAINED").toBe(failure);
    expect(await rejection(app.close())).toBe(failure);
    await observed.expectClosed();
    expect(() => app!.db.query("SELECT 1").get()).toThrow();
  } finally { await app?.close().catch(() => {}); flush?.mockRestore(); close?.mockRestore(); histories.mockRestore(); await observed.restore(); await f.close(); }
});

test("same-kind different-input deliveries both persist outcomes before app writer closure", async () => {
  const f = fixture(), observed = observe(f.path);
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let activity!: activityRuntime.ActivityRuntime;
  const createRuntime = activityRuntime.createActivityRuntime;
  const assembly = spyOn(activityRuntime, "createActivityRuntime").mockImplementation((...args) => { activity = createRuntime(...args); return activity; });
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const tags: string[] = [];
  const transport = spyOn(webpush, "sendNotification").mockImplementation(async (_sub, payload) => {
    const tag = JSON.parse(String(payload)).tag as string;
    tags.push(tag);
    await (tag.endsWith(":ithaca") ? firstGate : secondGate);
    return { statusCode: 201, body: "", headers: {} };
  });
  const deliveries: Promise<number>[] = [];
  try {
    app = await createApp(f);
    const owner = createPrincipal(app.db, { authMethod: "password", label: "Athena", ttlSeconds: 3600 });
    await activity.pushSender.subscribe({ endpoint: "https://push.example.test/ithaca", keys: { p256dh: "k", auth: "a" } }, owner.id);
    for (const runId of ["ithaca", "troy"]) {
      await activity.store.startSpan({ runId, spanId: `${runId}:root`, name: "invoke_agent", kind: "turn", origin: "session" });
      await activity.store.endSpan(`${runId}:root`, { outcome: "error" });
    }
    await activity.notifier.tick();
    const pending = activity.notifier.pending();
    expect(pending).toHaveLength(2);
    const notifier = (runId: string) => ({ ...activity.notifier, pending: () => pending.filter(intent => intent.runId === runId) });
    deliveries.push(activity.pushSender.deliverPending(notifier("ithaca")), activity.pushSender.deliverPending(notifier("troy")));
    expect(deliveries[0], "SAME_KIND_CALLS_OWN_DISTINCT_PROMISES").not.toBe(deliveries[1]);
    for (let i = 0; i < 100 && tags.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(tags.sort(), "SAME_KIND_DIFFERENT_INPUTS_BOTH_SEND").toEqual(["brain-activity:ithaca", "brain-activity:troy"]);
    let reached!: () => void;
    const draining = new Promise<void>(resolve => { reached = resolve; });
    const closeActivity = activity.close.bind(activity);
    activity.close = () => { const result = closeActivity(); reached(); return result; };
    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    await draining;
    releaseFirst();
    expect(await deliveries[0], "FIRST_DELIVERY_HAS_OWN_RESULT").toBe(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(closed, "APP_CLOSE_JOINS_SECOND_SAME_KIND_DELIVERY").toBe(false);
    expect(observed.closes, "WRITER_OPEN_UNTIL_ALL_SAME_KIND_OUTCOMES").toBe(0);
    expect(app.db.query("SELECT run_id, status FROM notification_intents ORDER BY run_id").all()).toEqual([
      { run_id: "ithaca", status: "sent" }, { run_id: "troy", status: "pending" },
    ]);
    expect(await activity.pushSender.deliverPending(notifier("troy")), "CLOSE_STOPS_NEW_ADMISSION_SYNCHRONOUSLY").toBe(0);
    releaseSecond();
    expect(await deliveries[1], "SECOND_DELIVERY_HAS_OWN_RESULT").toBe(1);
    await closing;
    await observed.expectClosed();
    const disk = new Database(f.path, { readonly: true });
    try {
      expect(disk.query("SELECT run_id, status FROM notification_intents ORDER BY run_id").all(), "ALL_SAME_KIND_OUTCOMES_DURABLE_BEFORE_WRITER_CLOSE").toEqual([
        { run_id: "ithaca", status: "sent" }, { run_id: "troy", status: "sent" },
      ]);
      expect(disk.query("SELECT last_used_at FROM push_subscriptions").get()).not.toEqual({ last_used_at: null });
    } finally { disk.close(); }
  } finally {
    releaseFirst(); releaseSecond(); await Promise.allSettled(deliveries); await app?.close().catch(() => {});
    transport.mockRestore(); assembly.mockRestore(); await observed.restore(); await f.close();
  }
});

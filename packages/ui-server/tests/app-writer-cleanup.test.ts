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
    if (!observed.closes) expect(await channel.call<number>("level"), "UNCLOSED_OWNED_WORKER_STILL_RESPONDS").toBe(2);
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
  let tick!: () => void;
  const intervalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setInterval")!;
  const interval = globalThis.setInterval;
  const assembly = spyOn(activityRuntime, "createActivityRuntime").mockImplementation((...args) => {
    Object.defineProperty(globalThis, "setInterval", { ...intervalDescriptor, value: (callback: () => void, ms: number) => {
      if (ms === 20_000) tick = callback;
      return interval(callback, ms);
    } });
    try { activity = createRuntime(...args); return activity; }
    finally { Object.defineProperty(globalThis, "setInterval", intervalDescriptor); }
  });
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
      tick(); tick();
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
    expect(activity.pushSender.deliverPending(activity.notifier), "CONCURRENT_DELIVERY_JOINS_THE_SAME_PASS").toBe(deliver);
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

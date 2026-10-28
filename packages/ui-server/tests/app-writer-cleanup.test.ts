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

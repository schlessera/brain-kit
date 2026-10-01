import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { createInboxStore, InboxStore } from "../src/inbox/store.js";
import { createActivityStore } from "../src/activity/store.js";
import { createInboxRuntime, INBOX_STALE_MS, INBOX_TICK_MS } from "../src/inbox/runtime.js";
import { createInboxPokeAuth } from "../src/routes/internal.js";
import { createApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";

const START = Date.UTC(2026, 9, 1);
const worker = join(import.meta.dir, "fixtures/inbox-runtime-worker.ts");
type Runtime = ReturnType<typeof createInboxRuntime>;
type Timer = ReturnType<typeof setInterval>;
let dir: string, path: string, db: ReturnType<typeof createUiDb>, now: number;
let runtimes: Runtime[], apps: Awaited<ReturnType<typeof createApp>>[];
let servers: ReturnType<typeof Bun.serve>[], children: ReturnType<typeof Bun.spawn>[];
const log = { emit() {}, enabled: () => false };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-inbox-runtime-"));
  path = join(dir, "ui.db"); db = createUiDb(path); now = START;
  runtimes = []; apps = []; servers = []; children = [];
});
afterEach(async () => {
  for (const child of children) { if (child.exitCode === null) child.kill(); await child.exited; }
  for (const server of servers) server.stop(true);
  for (const runtime of runtimes) await runtime.close();
  for (const app of apps) await app.close();
  db.close(); rmSync(dir, { recursive: true, force: true });
});
function store() { return createInboxStore(db, { now: () => now }); }
function seed(id = "odysseus") {
  return store().ingest({ threadId: `thread-${id}`, itemId: `item-${id}`, dedupKey: id,
    stagingId: id, source: "share", stakes: 2, expiresAt: now + 86_400_000 });
}
function fakeTimers() {
  const callbacks = new Map<Timer, () => void>(); let id = 0;
  return { callbacks, setInterval(callback: () => void, ms: number) {
    expect(ms).toBe(INBOX_TICK_MS);
    const timer = ++id as unknown as Timer; callbacks.set(timer, callback); return timer;
  }, clearInterval(timer: Timer) { callbacks.delete(timer); } };
}
function runtime(extra: Partial<Parameters<typeof createInboxRuntime>[1]> = {}) {
  const r = createInboxRuntime(db, { now: () => now, log, timers: fakeTimers(),
    budget: { config: { spendUsd: 5, turns: 100, emergencySpendUsd: 0, emergencyTurns: 0, timeZone: "UTC", unpricedUsdPerToken: 0.01 }, pricing: { resolve: () => null } },
    operation: (item) => ({ runId: `${item.id}-${item.attempts + 1}`, principalId: "fixture", model: "fixture", billingMode: "subscription", purpose: "triage" }), ...extra });
  runtimes.push(r); return r;
}
async function ready(file: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(5);
  expect(existsSync(file)).toBe(true);
}
function spawn(mode: string, name: string, gate = join(dir, "gate")) {
  const readyFile = join(dir, name);
  const child = Bun.spawn([process.execPath, worker, mode, path, readyFile, gate, String(now)],
    { stdout: "pipe", stderr: "pipe" });
  children.push(child); return { child, readyFile };
}

describe("inbox drain lifecycle", () => {
  test("empty ticks create zero model calls and zero Activity runs, with a nonempty control", async () => {
    let calls = 0; const activity = createActivityStore(db);
    const r = runtime({ dispatch: async (item) => {
      calls++;
      activity.startSpan({ spanId: item.id, runId: item.id, name: "fixture", kind: "turn", origin: "session" });
    } });
    expect(await r.tick()).toMatchObject({ claimed: 0 });
    expect(calls).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM activity_spans").get()).toEqual({ n: 0 });
    seed(); expect((await r.tick()).claimed).toBe(1);
    expect(calls).toBe(1);
    expect(db.query("SELECT COUNT(DISTINCT run_id) AS n FROM activity_spans").get()).toEqual({ n: 1 });
  });

  test("unwired production runtime leaves nonempty ready work unclaimed", async () => {
    seed(); const r = runtime();
    expect(await r.tick()).toMatchObject({ claimed: 0, dispatchEnabled: false });
    expect(store().getItem("item-odysseus")).toMatchObject({ status: "ready", attempts: 0 });
  });

  test("tick and poke cannot overlap, including synchronous dispatcher reentry", async () => {
    seed(); seed("penelope"); let release!: () => void; let calls = 0;
    let reentry!: Promise<unknown>; let r: Runtime;
    r = runtime({ dispatch: async () => {
      calls++;
      if (calls === 1) { reentry = r.tick(); await new Promise<void>((resolve) => { release = resolve; }); }
    } });
    const first = r.tick(); await Bun.sleep(0);
    try {
      expect(await reentry).toMatchObject({ busy: true, claimed: 0 });
      expect(await r.poke()).toMatchObject({ busy: true, claimed: 0 });
      expect(calls).toBe(1);
    } finally { release(); await first; }
    expect((await first).claimed).toBe(2); expect(calls).toBe(2);
  });

  test("boot and periodic sweeps recover expired leases, and stale poke rearms a stopped interval", async () => {
    seed(); seed("penelope"); const s = store();
    for (const id of ["item-odysseus", "item-penelope"]) s.commit([{
      kind: "transition", itemId: id, expectedVersion: 1, to: "claimed",
      leaseUntil: now + (id === "item-odysseus" ? 1 : 1000),
    }]);
    now++; const timers = fakeTimers(); const r = runtime({ timers });
    expect(s.getItem("item-odysseus")).toMatchObject({ status: "ready", attempts: 1 });
    expect(s.getItem("item-penelope")).toMatchObject({ status: "claimed" });
    expect(await r.poke()).toMatchObject({ rearmed: false, recovered: 0 });
    now += 1000; [...timers.callbacks.values()][0]!(); await Bun.sleep(0);
    expect(s.getItem("item-penelope")).toMatchObject({ status: "ready", attempts: 1 });
    expect(s.getItem("item-penelope")).not.toHaveProperty("leaseUntil");
    timers.callbacks.clear(); now += INBOX_STALE_MS;
    expect(await r.poke()).toMatchObject({ rearmed: true }); expect(timers.callbacks.size).toBe(1);
    const heartbeat = db.query("SELECT tick_at, change_cursor FROM inbox_scheduler_heartbeats WHERE name = 'inbox-drain'").get();
    expect(heartbeat).toEqual({ tick_at: now, change_cursor: s.snapshot().cursor });
    await r.close(); expect(timers.callbacks.size).toBe(0);
    const before = s.exportState(); now++;
    expect(await r.poke()).toMatchObject({ closed: true, rearmed: false });
    await r.tick(); expect(s.exportState()).toEqual(before);
  });

  test("close aborts the in-flight fixture before resolving and never starts the next item", async () => {
    seed(); seed("penelope"); let entered = false, aborted = false; let release!: () => void;
    const r = runtime({ dispatch: async (_item, signal) => {
      entered = true; await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
      });
    } });
    const pass = r.tick(); await Bun.sleep(0); expect(entered).toBe(true);
    const closing = r.close();
    try { await Promise.race([closing, Bun.sleep(50)]); expect(aborted).toBe(true); }
    finally { release(); await closing; }
    expect((await pass).claimed).toBe(1);
    expect(store().snapshot().items.filter((i) => i.status === "ready")).toHaveLength(1);
  });

  test("dispatch runs outside SQLite transactions and failed work retains a recoverable lease", async () => {
    seed(); const second = createUiDb(path);
    try {
      let wrote = false;
      const r = runtime({ dispatch: async () => {
        createInboxStore(second).commit([{ kind: "heartbeat", name: "other-writer", tickAt: now, changeCursor: 0 }]);
        wrote = true; throw new Error("fixture dispatch failure");
      } });
      expect((await r.tick()).claimed).toBe(1); expect(wrote).toBe(true);
      const item = store().getItem("item-odysseus")!;
      expect(item).toMatchObject({ status: "claimed", attempts: 1, claimedAt: now });
      expect(item.queue === "queue" && item.leaseUntil! > now).toBe(true);
      await r.close(); now += 600_000;
      runtime(); expect(store().getItem(item.id)).toMatchObject({ status: "ready", attempts: 1 });
    } finally { second.close(); }
  });

  test("two real processes race one immediate claim and produce exactly one dispatch", async () => {
    seed(); const a = spawn("claim", "ready-a"), b = spawn("claim", "ready-b");
    await Promise.all([ready(a.readyFile), ready(b.readyFile)]); writeFileSync(join(dir, "gate"), "go");
    const exits = await Promise.all([a.child.exited, b.child.exited]); expect(exits).toEqual([0, 0]);
    const outputs = await Promise.all([new Response(a.child.stdout).text(), new Response(b.child.stdout).text()]);
    const claims = outputs.join("").trim().split("\n").filter(Boolean).map((row) => JSON.parse(row));
    expect(claims).toHaveLength(1); expect(claims[0]).toMatchObject({ id: "item-odysseus", status: "claimed", attempts: 1 });
    expect(store().getItem("item-odysseus")).toMatchObject({ status: "claimed", attempts: 1 });
  });

  test("claim acquires the write lock before selecting ready work", async () => {
    seed(); const second = createUiDb(path); second.exec("PRAGMA busy_timeout = 0");
    let selectionLocked = false;
    const original = InboxStore.prototype.orderedItems;
    const probe = spyOn(InboxStore.prototype, "orderedItems").mockImplementation(function(this: InboxStore) {
      try {
        second.query("INSERT INTO inbox_scheduler_heartbeats VALUES ('selection-probe', ?, 0)").run(now);
      } catch (error) {
        selectionLocked = error instanceof Error && error.message.includes("database is locked");
      }
      return original.call(this);
    });
    try {
      const r = runtime({ dispatch: async () => {} });
      expect((await r.tick()).claimed).toBe(1);
      expect(selectionLocked).toBe(true);
    } finally { probe.mockRestore(); second.close(); }
  });

  test("cron heartbeat racing a claim waits within the configured five-second timeout", async () => {
    seed(); let calls = 0; const r = runtime({ dispatch: async () => { calls++; } });
    const holder = spawn("hold", "held"); await ready(holder.readyFile);
    const started = performance.now(); const pending = r.tick();
    writeFileSync(join(dir, "gate"), "attempt queued");
    const pass = await pending; const elapsed = performance.now() - started;
    expect(pass.claimed).toBe(1); expect(calls).toBe(1);
    expect(elapsed).toBeGreaterThan(100); expect(elapsed).toBeLessThan(5000);
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    expect(await holder.child.exited).toBe(0);
  });
});

async function boot(mode: string, tokenFile: string | null = join(dir, "poke.token")) {
  const backend = makeFakeBackend({ id: "fixture" });
  const app = await createApp({
    config: resolveServerConfig({ AUTH_MODE: mode, HOST: "0.0.0.0", DB_PATH: join(dir, `app-${apps.length}.db`),
      BRAIN_PATH: dir, BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_MODEL_DISCOVERY: "0",
      BRAIN_UI_DANGEROUSLY_DISABLE_AUTH: "1", TRUST_PROXY: "1",
      BRAIN_UI_PASSWORD_HASH: mode === "password" ? await Bun.password.hash("fixture-password") : undefined,
      COOKIE_SECRET: "fixture-cookie-secret-for-inbox-only", BRAIN_UI_INBOX_POKE_TOKEN_FILE: tokenFile ?? undefined,
    }), registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability(),
  });
  apps.push(app); const server = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: app.fetch, websocket: app.websocket });
  servers.push(server); return { app, server, url: `http://127.0.0.1:${server.port}/api/internal/inbox/poke` };
}
function token(file = join(dir, "poke.token")) { return readFileSync(file, "utf8").trim(); }
async function externalSocket(port: number, authorization: string): Promise<string> {
  const address = Object.values(networkInterfaces()).flat().find((i) => i?.family === "IPv4" && !i.internal)?.address;
  if (!address) throw new Error("non-loopback local fixture interface required");
  return await new Promise<string>((resolve, reject) => {
    let response = "";
    void Bun.connect({ hostname: address, port, socket: {
      open(socket) { socket.write(`POST /api/internal/inbox/poke HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAuthorization: Bearer ${authorization}\r\nX-Forwarded-For: 127.0.0.1\r\nX-Real-IP: ::1\r\nContent-Length: 0\r\n\r\n`); },
      data(_socket, bytes) { response += new TextDecoder().decode(bytes); },
      close() { resolve(response); }, error(_socket, error) { reject(error); },
    } }).catch(reject);
  });
}

describe("mounted internal poke", () => {
  test("separate server processes rotate boot authorization and recover the persisted lease", async () => {
    now = Date.now() - 10_000; seed(); const s = store();
    s.commit([{ kind: "transition", itemId: "item-odysseus", expectedVersion: 1, to: "claimed", leaseUntil: Date.now() + 60_000 }]);
    const stopOne = join(dir, "stop-one"); const first = spawn("serve", "server-one", stopOne);
    await ready(first.readyFile);
    const url = (file: string) => `http://127.0.0.1:${JSON.parse(readFileSync(file, "utf8")).port}/api/internal/inbox/poke`;
    const file = join(dir, "process.token"), old = token(file);
    expect((await fetch(url(first.readyFile), { method: "POST", headers: { authorization: `Bearer ${old}` } })).status).toBe(200);
    expect(s.getItem("item-odysseus")).toMatchObject({ status: "claimed", attempts: 1 });
    s.commit([{ kind: "transition", itemId: "item-odysseus", expectedVersion: 2, to: "ready" },
      { kind: "transition", itemId: "item-odysseus", expectedVersion: 3, to: "claimed", leaseUntil: now + 1 }]);
    writeFileSync(stopOne, "stop"); expect(await first.child.exited).toBe(0);
    const stopTwo = join(dir, "stop-two"), second = spawn("serve", "server-two", stopTwo);
    await ready(second.readyFile);
    expect(token(file)).not.toBe(old);
    expect((await fetch(url(second.readyFile), { method: "POST", headers: { authorization: `Bearer ${old}` } })).status).toBe(403);
    expect((await fetch(url(second.readyFile), { method: "POST", headers: { authorization: `Bearer ${token(file)}` } })).status).toBe(200);
    expect(s.getItem("item-odysseus")).toMatchObject({ status: "ready", attempts: 2 });
    writeFileSync(stopTwo, "stop"); expect(await second.child.exited).toBe(0);
  });

  test("atomic token publication replaces a symlink without writing its target", () => {
    const target = join(dir, "odysseus-runtime-sentinel");
    const file = join(dir, "poke.token");
    writeFileSync(target, "Odysseus sentinel"); symlinkSync(target, file);
    createInboxPokeAuth(file);
    expect(readFileSync(target, "utf8")).toBe("Odysseus sentinel");
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(token(file)).toMatch(/^[0-9a-f]{64}$/);
  });
  for (const mode of ["none", "password", "tailscale", "proxy"]) {
    test(`${mode}: actual listener success without cookie; token and actual socket guard refusals`, async () => {
      const { app, server, url } = await boot(mode); const current = token();
      createInboxStore(app.db).ingest({ threadId: "odysseus", itemId: "odysseus", dedupKey: "odysseus",
        stagingId: "odysseus", source: "share", stakes: 2, expiresAt: Date.now() + 86_400_000 });
      const success = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${current}`,
        "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" } });
      expect(success.status).toBe(200);
      expect(await success.json()).toEqual({ ok: true, rearmed: false, busy: false, recovered: 0, claimed: 0, dispatchEnabled: false });
      expect(createInboxStore(app.db).getItem("odysseus")).toMatchObject({ status: "ready", attempts: 0 });
      for (const authorization of [undefined, "Bearer malformed", `Bearer ${"a".repeat(64)}`, `Basic ${current}`]) {
        const refused = await fetch(url, { method: "POST", headers: authorization ? { authorization } : {} });
        expect(refused.status).toBe(403); expect(await refused.json()).toEqual({ error: "inbox_poke_forbidden" });
      }
      const external = await externalSocket(server.port!, current);
      expect(external).toContain("403 Forbidden"); expect(external).toContain('"inbox_poke_forbidden"');
      const unavailable = await app.fetch(new Request(url, { method: "POST", headers: { authorization: `Bearer ${current}` } }));
      expect(unavailable.status).toBe(403); // no socket information fails closed
      expect((await fetch(url)).status).toBe(405);
      if (mode === "password" || mode === "proxy") {
        expect((await fetch(new URL("/api/status", url))).status).toBe(401);
      }
    });
  }

  test("restart rotates the atomically written 0600 token and real app recovers persisted leases", async () => {
    const file = join(dir, "poke.token"); writeFileSync(file, "old", { mode: 0o666 });
    const first = await boot("password"); const old = token();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const s = createInboxStore(first.app.db, { now: () => Date.now() - 10_000 });
    const item = s.ingest({ threadId: "odysseus", itemId: "odysseus", dedupKey: "odysseus", stagingId: "odysseus", source: "share", stakes: 2, expiresAt: Date.now() + 86_400_000 }).item;
    s.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "claimed", leaseUntil: Date.now() - 1000 }]);
    const database = first.app.config.dbPath;
    first.server.stop(true); await first.app.close(); apps.splice(apps.indexOf(first.app), 1); servers.splice(servers.indexOf(first.server), 1);
    // The next createApp uses the same operational store, as a process restart does.
    const backend = makeFakeBackend({ id: "fixture" });
    const second = await createApp({ config: { ...first.app.config, dbPath: database },
      registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
    apps.push(second); const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: second.fetch }); servers.push(server);
    expect(token()).not.toBe(old); expect(statSync(file).mode & 0o777).toBe(0o600);
    const url = `http://127.0.0.1:${server.port}/api/internal/inbox/poke`;
    expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${old}` } })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token()}` } })).status).toBe(200);
    expect(createInboxStore(second.db).getItem(item.id)).toMatchObject({ status: "ready", attempts: 1 });
    expect(readdirSync(dir).filter((name) => name.startsWith(".inbox-poke-"))).toEqual([]);
  });

  test("unconfigured poke is unavailable and invalid runtime provisioning refuses boot", async () => {
    const { url } = await boot("none", null);
    expect((await fetch(url, { method: "POST" })).status).toBe(503);
    expect(() => createInboxPokeAuth("relative.token")).toThrow("absolute runtime file path");
    expect(() => createInboxPokeAuth(join(dir, "missing", "poke.token"))).toThrow("Unable to write");
    expect(readdirSync(dir).filter((name) => name.startsWith(".inbox-poke-"))).toEqual([]);
  });
});

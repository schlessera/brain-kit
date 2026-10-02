import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeSigned } from "hono/utils/cookie";
import { BrainUiClient, type InboxActionItem, type InboxItem, type InboxThread, type InboxView, type ServerMessage } from "@schlessera/brain-ui-sdk/client";
import { createApp } from "../../src/app.js";
import { createUiDb } from "../../src/db/client.js";
import { createInboxStore } from "../../src/inbox/store.js";
import { createPrincipal, revokePrincipal } from "../../src/db/principals.js";
import { resolveServerConfig } from "../../src/config/env.js";
import { createStaticBackendRegistry } from "../../src/agent/backend.js";
import { createSilentObservability } from "../../src/observability/index.js";
import { makeFakeBackend } from "../helpers/fake-backend.js";

// The monorepo includes lib.dom, whose constructor omits Bun's documented
// headers overload (bun-types/globals.d.ts). The real runtime supplies it.
const NativeWebSocket = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket;
};
const SECRET = "fixture-cookie-secret-0123456789abcdef";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function waitFor(predicate: () => boolean, budgetMs = 2000): Promise<boolean> {
  const end = Date.now() + budgetMs;
  while (Date.now() < end) { if (predicate()) return true; await Bun.sleep(10); }
  return predicate();
}
async function start(path: string) {
  let starts = 0;
  const backend = makeFakeBackend({ id: "fake", startTurn: async () => { starts++; } });
  const app = await createApp({
    config: resolveServerConfig({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "fixture-hash",
      COOKIE_SECRET: SECRET, HOST: "127.0.0.1", DB_PATH: path, BRAIN_PATH: join(path, ".."),
      BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }),
    observability: createSilentObservability(),
    registry: createStaticBackendRegistry([backend], backend.id),
  });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, websocket: app.websocket });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; server.stop(true); await app.close(); };
  cleanup.push(close);
  return { app, url: `ws://127.0.0.1:${server.port}/ws`, close, starts: () => starts };
}
async function connect(running: Awaited<ReturnType<typeof start>>) {
  const principal = createPrincipal(running.app.db, { authMethod: "password", label: "Example browser", ttlSeconds: 3600 });
  const cookie = await serializeSigned("brain_ui_session", principal.id, SECRET);
  const frames: ServerMessage[] = [];
  const errors: string[] = [];
  const closes: number[] = [];
  const client = new BrainUiClient({ url: running.url,
    socketFactory: (url) => new NativeWebSocket(url, { headers: { cookie } }),
    handlers: { onAny: (f) => frames.push(f) },
    onProtocolError: (e) => errors.push(`${e.reason}: ${e.detail}`),
    onClose: (e) => closes.push(e.code),
  });
  cleanup.push(() => client.close());
  client.connect();
  expect(await waitFor(() => frames.some((f) => f.type === "server_hello"))).toBe(true);
  expect(client.capabilities.inbox).toBe(true);
  return { client, frames, errors, closes, principal };
}
function project(frames: ServerMessage[], view: InboxView) {
  const threads = new Map<string, InboxThread>(), items = new Map<string, InboxItem>();
  let highWaterSeq: Record<string, number> = {}, cursor = 0, initialized = false;
  for (const frame of frames) {
    if (frame.type === "inbox_snapshot" && frame.view === view) {
      if (!frame.append) { threads.clear(); items.clear(); highWaterSeq = {}; }
      initialized = true;
      for (const thread of frame.threads) threads.set(thread.id, thread);
      for (const item of frame.items) items.set(item.id, item);
      Object.assign(highWaterSeq, frame.highWaterSeq);
      cursor = frame.cursor;
    } else if (frame.type === "inbox_delta" && frame.view === view && initialized) {
      const c = frame.change;
      if (c.seq <= (highWaterSeq[c.threadId] ?? 0)) continue;
      highWaterSeq[c.threadId] = c.seq;
      cursor = c.changeId;
      if (c.kind === "upsert_thread") threads.set(c.threadId, c.thread);
      else if (c.kind === "upsert_item") items.set(c.itemId, c.item);
      else if (c.kind === "remove_item") items.delete(c.itemId);
      else threads.delete(c.threadId);
    }
  }
  return { threads: [...threads.values()].sort((a, b) => a.id < b.id ? -1 : 1),
    items: [...items.values()].sort((a, b) => a.id < b.id ? -1 : 1), highWaterSeq, cursor };
}
function ingest(store: ReturnType<typeof createInboxStore>, id: string) {
  return store.ingest({ threadId: `thread-${id}`, itemId: `item-${id}`, dedupKey: `dedup-${id}`,
    stagingId: `staging-${id}`, source: "share", stakes: 2, expiresAt: Date.now() + 86_400_000 });
}
function action(id: string, threadId: string): InboxActionItem {
  const now = Date.now();
  return { id, threadId, dedupKey: `dedup-${id}`, queue: "actions", type: "approve",
    status: "pending", version: 1, createdAt: now, updatedAt: now, expiresAt: now + 86_400_000,
    payload: { title: "Archive document?", detail: "Keep a reversible copy." },
    options: [{ id: "accept", label: "Archive", effect: { kind: "enqueue", payload: { instruction: "Archive document" } } }] };
}
function directory() {
  const dir = mkdtempSync(join(tmpdir(), "brain-inbox-socket-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "ui.sqlite");
}
function bothViews(s: Awaited<ReturnType<typeof connect>>) {
  expect(s.client.send({ type: "inbox_subscribe", view: "queue" })).toBe(true);
  expect(s.client.send({ type: "inbox_subscribe", view: "actions" })).toBe(true);
}
function assertConverged(s: Awaited<ReturnType<typeof connect>>, store: ReturnType<typeof createInboxStore>) {
  const snapshot = store.snapshot();
  const queue = project(s.frames, "queue"), actions = project(s.frames, "actions");
  expect(queue.threads).toEqual(snapshot.threads);
  expect(actions.threads).toEqual(snapshot.threads);
  expect(queue.items).toEqual(snapshot.items.filter((i) => i.queue === "queue"));
  expect(actions.items).toEqual(snapshot.items.filter((i) => i.queue === "actions"));
  expect(Math.max(queue.cursor, actions.cursor)).toBe(snapshot.cursor);
  const mergedHighWater: Record<string, number> = { ...queue.highWaterSeq };
  for (const [id, seq] of Object.entries(actions.highWaterSeq)) mergedHighWater[id] = Math.max(seq, mergedHighWater[id] ?? 0);
  expect(mergedHighWater).toEqual(snapshot.highWaterSeq);
  for (const view of ["queue", "actions"] as const) {
    const ids = s.frames.filter((f) => f.type === "inbox_delta" && f.view === view).map((f) => f.type === "inbox_delta" ? f.change.changeId : 0);
    expect(new Set(ids).size).toBe(ids.length);
  }
  expect(s.errors).toEqual([]);
}

describe("durable inbox over real authenticated sockets", () => {
  test("two clients converge across a foreign snapshot race, polling, reconnect, tombstones and app restart", async () => {
    const path = directory();
    const running = await start(path);
    const foreignDb = createUiDb(path);
    cleanup.push(() => foreignDb.close());
    const foreign = createInboxStore(foreignDb);
    ingest(foreign, "seed");
    foreign.commit([{ kind: "item", item: action("decision-seed", "thread-seed") }]);
    const first = await connect(running), second = await connect(running);
    const original = running.app.db.query.bind(running.app.db);
    let raced = false;
    running.app.db.query = ((sql: string) => {
      const stmt = original(sql);
      if (!sql.includes("SELECT * FROM inbox_threads WHERE deleted_at IS NULL")) return stmt;
      return new Proxy(stmt, { get(target, prop, receiver) {
        if (prop === "all") return (...args: unknown[]) => {
          const rows = Reflect.apply(target.all, target, args);
          if (!raced) { raced = true; ingest(foreign, "race"); }
          return rows;
        };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }) as typeof running.app.db.query;
    bothViews(first);
    await waitFor(() => first.frames.some((f) => f.type === "inbox_snapshot" && f.view === "actions"));
    bothViews(second);
    await waitFor(() => project(first.frames, "queue").items.length === 2 && project(second.frames, "queue").items.length === 2);
    running.app.db.query = original;
    expect(raced).toBe(true);
    const initial = first.frames.find((f) => f.type === "inbox_snapshot" && f.view === "queue");
    expect(initial?.type === "inbox_snapshot" ? initial.items.map((i) => i.id) : []).toEqual(["item-seed"]);
    expect(first.frames.some((f) => f.type === "inbox_delta" && f.change.threadId === "thread-race")).toBe(true);
    expect(project(first.frames, "actions").items.map((i) => i.id)).toEqual(["decision-seed"]);
    expect(project(second.frames, "actions").items.map((i) => i.id)).toEqual(["decision-seed"]);
    assertConverged(first, foreign); assertConverged(second, foreign);

    // No pump() call: only the shipped timer can discover this other writer.
    ingest(foreign, "polled");
    foreign.commit([{ kind: "item", item: action("decision-polled", "thread-polled") }]);
    await waitFor(() => project(first.frames, "queue").items.length === 3 && project(second.frames, "queue").items.length === 3 && project(first.frames, "actions").items.length === 2 && project(second.frames, "actions").items.length === 2);
    expect(project(first.frames, "actions").items.map((i) => i.id)).toContain("decision-polled");
    expect(project(second.frames, "actions").items.map((i) => i.id)).toContain("decision-polled");
    expect(project(first.frames, "queue").items.map((i) => i.id)).toContain("item-polled");
    expect(project(second.frames, "queue").items.map((i) => i.id)).toContain("item-polled");
    first.client.close();
    foreign.commit([{ kind: "transition", itemId: "item-seed", expectedVersion: 1, to: "dropped" }]);
    foreign.commit([{ kind: "transition", itemId: "decision-seed", expectedVersion: 1, to: "dismissed" }]);
    foreign.commit([{ kind: "remove_item", itemId: "item-seed", expectedVersion: 2 }, { kind: "remove_item", itemId: "decision-seed", expectedVersion: 2 }, { kind: "remove_thread", threadId: "thread-seed" }]);
    const reconnect = await connect(running); bothViews(reconnect);
    await waitFor(() => project(second.frames, "queue").threads.length === 2 && project(reconnect.frames, "queue").items.length === 2 && project(reconnect.frames, "actions").items.length === 1);
    expect(second.frames.some((f) => f.type === "inbox_delta" && f.change.kind === "remove_thread")).toBe(true);
    assertConverged(second, foreign); assertConverged(reconnect, foreign);
    expect(reconnect.frames.filter((f) => f.type === "inbox_delta")).toHaveLength(0);
    await running.close();
    const restarted = await start(path), restored = await connect(restarted); bothViews(restored);
    await waitFor(() => project(restored.frames, "actions").cursor === foreign.snapshot().cursor);
    expect(project(restored.frames, "queue").items).toHaveLength(2);
    expect(project(restored.frames, "actions").items.map((i) => i.id)).toEqual(["decision-polled"]);
    assertConverged(restored, foreign);
  });
  test("an idle foreign revocation closes only its principal and suppresses later operational records", async () => {
    const path = directory(), running = await start(path);
    const foreignDb = createUiDb(path); cleanup.push(() => foreignDb.close());
    const foreign = createInboxStore(foreignDb);
    ingest(foreign, "seed");
    const revoked = await connect(running), survivor = await connect(running);
    bothViews(revoked); bothViews(survivor);
    await waitFor(() => project(revoked.frames, "actions").cursor > 0 && project(survivor.frames, "actions").cursor > 0);
    expect(project(revoked.frames, "queue").items).toHaveLength(1);
    expect(revokePrincipal(foreignDb, revoked.principal.id, Date.now())).toEqual([revoked.principal.id]);
    // Polling rechecks authority even with no pending changes.
    await waitFor(() => revoked.closes.length > 0);
    expect(revoked.closes).toEqual([1008]);
    const before = revoked.frames.length;
    ingest(foreign, "after-revocation");
    await waitFor(() => project(survivor.frames, "queue").items.length === 2);
    expect(project(survivor.frames, "queue").items.map((i) => i.id)).toContain("item-after-revocation");
    expect(revoked.frames).toHaveLength(before);
    expect(survivor.closes).toEqual([]);
    expect(running.app.wsHost.inbox?.subscriptionCount()).toBe(2);
    assertConverged(survivor, foreign);
  });
  test("foreign polling reaches both idle clients without a local writer notification", async () => {
    const path = directory(), running = await start(path);
    const foreignDb = createUiDb(path); cleanup.push(() => foreignDb.close());
    const foreign = createInboxStore(foreignDb);
    ingest(foreign, "seed");
    const first = await connect(running), second = await connect(running);
    bothViews(first); bothViews(second);
    await waitFor(() => project(first.frames, "queue").items.length === 1 && project(second.frames, "queue").items.length === 1);
    expect(project(first.frames, "queue").items).toHaveLength(1);
    expect(project(second.frames, "queue").items).toHaveLength(1);
    const before = foreign.snapshot().cursor;
    ingest(foreign, "foreign");
    await waitFor(() => project(first.frames, "queue").cursor > before && project(second.frames, "queue").cursor > before);
    expect(project(first.frames, "queue").items.map((i) => i.id)).toContain("item-foreign");
    expect(project(second.frames, "queue").items.map((i) => i.id)).toContain("item-foreign");
    assertConverged(first, foreign); assertConverged(second, foreign);
  });

});

test("two real clients resolve stored work once, converge both views and make zero backend calls", async () => {
  const path = directory(), running = await start(path), store = createInboxStore(running.app.db);
  const source = ingest(store, "resolution"), decision = action("decision", source.thread.id);
  store.commit([{ kind: "item", item: decision }, { kind: "transition", itemId: source.item.id, expectedVersion: 1, to: "claimed", leaseUntil: Date.now() + 600_000 },
    { kind: "transition", itemId: source.item.id, expectedVersion: 2, to: "blocked", blockedByItemId: decision.id }]);
  const first = await connect(running), second = await connect(running);
  bothViews(first); bothViews(second);
  expect(await waitFor(() => project(first.frames, "actions").items.length === 1 && project(second.frames, "actions").items.length === 1)).toBe(true);
  expect(decision.options).toHaveLength(1);
  expect(first.client.send({ type: "inbox_snooze", itemId: decision.id })).toBe(true);
  expect(await waitFor(() => store.getItem(decision.id)?.status === "snoozed")).toBe(true);
  expect(store.getItem(source.item.id)).toMatchObject({ status: "blocked" });
  expect(running.app.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 0 });
  const msg = { type: "inbox_resolve" as const, itemId: decision.id, optionId: "accept" };
  expect(first.client.send(msg)).toBe(true); expect(second.client.send(msg)).toBe(true);
  expect(await waitFor(() => store.getItem(decision.id)?.status === "resolved")).toBe(true);
  const execute = () => store.snapshot().items.filter(item => item.queue === "queue" && item.type === "execute");
  expect(execute()).toHaveLength(1);
  expect(running.app.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 1 });
  expect(store.getItem(source.item.id)).toMatchObject({ status: "superseded" });
  expect(running.starts()).toBe(0);
  expect(await waitFor(() => project(first.frames, "actions").items[0]?.status === "resolved" && project(second.frames, "actions").items[0]?.status === "resolved")).toBe(true);
  assertConverged(first, store); assertConverged(second, store);
  expect(first.errors).toEqual([]); expect(second.errors).toEqual([]);
});

test("mounted decision routing fails closed for exact operations until current server authority is installed", async () => {
  const path = directory(), running = await start(path), store = createInboxStore(running.app.db);
  const source = ingest(store, "authority"), decision = action("authority-decision", source.thread.id);
  decision.options[0]!.effect = { kind: "enqueue", payload: { instruction: "Write the note", operation: { toolName: "write", input: { path: "notes/harbor.md" }, targetPath: "notes/harbor.md" } } };
  store.commit([{ kind: "item", item: decision }]);
  const client = await connect(running);
  expect(client.client.send({ type: "inbox_resolve", itemId: decision.id, optionId: "accept" })).toBe(true);
  expect(await waitFor(() => client.frames.some(frame => frame.type === "error" && frame.code === "INBOX_DECISION_REFUSED"))).toBe(true);
  expect(store.getItem(decision.id)).toMatchObject({ status: "pending" });
  expect(running.app.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions").get()).toEqual({ n: 0 });
  expect(running.starts()).toBe(0);
});

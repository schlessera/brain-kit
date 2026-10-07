import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxActionItem, InboxDelta, InboxSnapshot, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal, isUsablePrincipal, resolvePrincipal } from "../src/db/principals.js";
import { createInboxStore } from "../src/inbox/store.js";
import { createInboxStream } from "../src/inbox/stream.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { WsHost } from "../src/ws/host.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";

describe("durable inbox stream", () => {
  let dir: string, db: Database, foreignDb: Database;
  let store: ReturnType<typeof createInboxStore>, foreign: ReturnType<typeof createInboxStore>;
  let stream: ReturnType<typeof createInboxStream>, host: WsHost;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brain-inbox-stream-"));
    const path = join(dir, "ui.sqlite");
    db = createUiDb(path);
    foreignDb = createUiDb(path);
    store = createInboxStore(db);
    foreign = createInboxStore(foreignDb);
    stream = createInboxStream(store, db);
    const backend = makeFakeBackend({ id: "fake" });
    host = new WsHost({
      registry: createStaticBackendRegistry([backend], backend.id),
      catalog: createSessionCatalog(() => db),
      inbox: stream,
      isPrincipalValid: (p) => {
        const row = resolvePrincipal(db, p.id);
        return row !== null && isUsablePrincipal(row, Date.now());
      },
    });
  });
  afterEach(() => {
    host.close();
    stream.close();
    foreignDb.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function ingest(id: string, writer = store) {
    return writer.ingest({ threadId: `thread-${id}`, itemId: `item-${id}`,
      dedupKey: `dedup-${id}`, stagingId: `staging-${id}`, source: "share", stakes: 2,
      expiresAt: Date.now() + 86_400_000 });
  }
  function socket() {
    const principal = createPrincipal(db, { authMethod: "password", label: "Example session", ttlSeconds: 3600 });
    const handlers = createWsHandlers(host, principal);
    const frames: ServerMessage[] = [];
    const wires: string[] = [];
    const closed: number[] = [];
    const raw = {};
    const ws: WSContext = { raw, send(data) {
      wires.push(data);
      const parsed = parseServerMessage(data);
      if (!parsed.ok) throw new Error(parsed.error);
      frames.push(parsed.message);
    }, close(code) { closed.push(code ?? 0); } };
    return { principal, handlers, frames, wires, closed, ws,
      async subscribe(view = "queue", threadId?: string) {
        handlers.onMessage(new MessageEvent("message", { data: JSON.stringify({ type: "inbox_subscribe", view, ...(threadId ? { threadId } : {}) }) }), ws);
        await Bun.sleep(0);
      },
    };
  }
  test("inbound subscribe sends a nonempty snapshot through the shipped dispatch", async () => {
    ingest("seed");
    expect(store.snapshot().items).toHaveLength(1);
    const s = socket();
    await s.handlers.onOpen(new Event("open"), s.ws);
    await s.subscribe();
    const snapshots = s.frames.filter((f): f is InboxSnapshot => f.type === "inbox_snapshot");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].items).toEqual(store.snapshot().items);
    expect(snapshots[0].cursor).toBe(store.snapshot().cursor);
  });
  function action(id: string, threadId = "thread-seed", detail = "Keep a reversible copy."): InboxActionItem {
    const now = Date.now();
    return { id, threadId, dedupKey: `dedup-${id}`, queue: "actions", type: "approve",
      status: "pending", version: 1, createdAt: now, updatedAt: now, expiresAt: now + 86_400_000,
      payload: { title: "Archive document?", detail },
      options: [{ id: "accept", label: "Archive", effect: { kind: "enqueue", payload: { instruction: "Archive document" } } }] };
  }
  function deltas(frames: ServerMessage[]): InboxDelta[] {
    return frames.filter((f): f is InboxDelta => f.type === "inbox_delta");
  }
  test("a later snapshot cannot skip pending changes owed to an earlier subscriber", async () => {
    ingest("seed");
    const first = socket(), later = socket();
    await first.subscribe();
    const boundary = store.snapshot().cursor;
    ingest("pending", foreign);
    expect(deltas(first.frames)).toHaveLength(0);
    await later.subscribe();
    stream.pump();
    expect(deltas(first.frames).map((d) => d.change.changeId)).toEqual(store.changesSince(boundary).map((c) => c.changeId));
    expect(deltas(later.frames)).toHaveLength(0);
    ingest("next", foreign);
    stream.pump();
    expect(deltas(later.frames)).toHaveLength(2);
    expect(deltas(first.frames)).toHaveLength(4);
  });
  test("a foreign write after snapshot capture crosses the subscription boundary exactly once", async () => {
    ingest("seed");
    const original = store.snapshot.bind(store);
    let raced = false;
    store.snapshot = () => {
      const result = original();
      if (!raced) { raced = true; ingest("racing", foreign); }
      return result;
    };
    const s = socket();
    await s.subscribe();
    const snapshot = s.frames.find((f): f is InboxSnapshot => f.type === "inbox_snapshot")!;
    expect(snapshot.items.map((i) => i.id)).toEqual(["item-seed"]);
    stream.pump();
    stream.pump();
    const changes = deltas(s.frames).map((d) => d.change);
    expect(changes.map((c) => c.changeId)).toEqual(foreign.changesSince(snapshot.cursor).map((c) => c.changeId));
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.seq > (snapshot.highWaterSeq[c.threadId] ?? 0))).toBe(true);
  });
  test("view and existing-thread filters are validated, overlap is deduplicated, and input cannot supply run authority", async () => {
    ingest("seed"); ingest("other");
    store.commit([{ kind: "item", item: action("decision") }]);
    const s = socket();
    await s.subscribe("actions", "thread-seed");
    const first = s.frames.find((f): f is InboxSnapshot => f.type === "inbox_snapshot")!;
    expect(first.items.map((i) => i.id)).toEqual(["decision"]);
    expect(first.threads.map((t) => t.id)).toEqual(["thread-seed"]);
    expect(first.highWaterSeq).toEqual({ "thread-seed": store.snapshot().highWaterSeq["thread-seed"] });
    await s.subscribe("actions");
    const boundary = store.snapshot().cursor;
    foreign.commit([{ kind: "transition", itemId: "decision", expectedVersion: 1, to: "snoozed", waitUntil: Date.now() + 1000 }]);
    stream.pump();
    expect(deltas(s.frames).map((d) => d.change.changeId)).toEqual(foreign.changesSince(boundary).map((c) => c.changeId));
    await s.subscribe("queue", "not-a-thread");
    expect(s.frames.filter((f) => f.type === "error").at(-1)).toMatchObject({ code: "INBOX_SCOPE_NOT_FOUND" });
    s.handlers.onMessage(new MessageEvent("message", { data: JSON.stringify({ type: "inbox_subscribe", view: "queue", runId: "untrusted-run" }) }), s.ws);
    await Bun.sleep(0);
    expect(s.frames.at(-1)).toMatchObject({ type: "error", code: "PARSE_ERROR" });
    expect(stream.subscriptionCount()).toBe(2);
  });
  test("whole UTF-8 records survive bounded snapshot chunks and delta delivery", async () => {
    ingest("seed");
    const items = Array.from({ length: 180 }, (_, i) => action(`decision-${i}`, "thread-seed", "界".repeat(1200)));
    store.commit(items.map((item) => ({ kind: "item", item })));
    const s = socket();
    await s.subscribe("actions");
    const snapshots = s.frames.filter((f): f is InboxSnapshot => f.type === "inbox_snapshot");
    expect(snapshots.length).toBeGreaterThan(1);
    expect(snapshots[0].append).toBeUndefined();
    expect(snapshots.slice(1).every((f) => f.append === true)).toBe(true);
    expect(new Set(snapshots.map((f) => f.cursor))).toEqual(new Set([store.snapshot().cursor]));
    expect(snapshots.flatMap((f) => f.items)).toEqual(store.snapshot().items.filter((i) => i.queue === "actions"));
    expect(s.wires.every((f) => Buffer.byteLength(f, "utf8") <= 512_000)).toBe(true);
    foreign.commit([{ kind: "item", item: action("later", "thread-seed", "界".repeat(1200)) }]);
    stream.pump();
    expect(deltas(s.frames).at(-1)?.change).toMatchObject({ kind: "upsert_item", item: { payload: { detail: "界".repeat(1200) } } });
  });
  test("an oversized delta stops the subscription", async () => {
    ingest("seed");
    const item = action("oversized");
    item.options[0].effect = { kind: "enqueue", payload: { instruction: "Archive", operation: { toolName: "archive", targetPath: "inbox/example.md", input: { data: "a".repeat(512_000) } } } };
    const s = socket();
    await s.subscribe("actions");
    expect(s.frames.filter((f) => f.type === "inbox_snapshot")).toHaveLength(1);
    foreign.commit([{ kind: "item", item }]);
    stream.pump();
    expect(s.frames.at(-1)).toMatchObject({ type: "error", code: "INBOX_FRAME_TOO_LARGE" });
    expect(deltas(s.frames)).toHaveLength(0);
    expect(s.closed).toEqual([1009]);
    expect(stream.subscriptionCount()).toBe(0);
  });
  test("an oversized snapshot record is refused before any chunk", async () => {
    ingest("seed");
    const item = action("oversized");
    item.options[0].effect = { kind: "enqueue", payload: { instruction: "Archive", operation: { toolName: "archive", targetPath: "inbox/example.md", input: { data: "a".repeat(512_000) } } } };
    foreign.commit([{ kind: "item", item }]);
    const reconnect = socket();
    await reconnect.subscribe("actions");
    expect(reconnect.frames.filter((f) => f.type === "inbox_snapshot")).toHaveLength(0);
    expect(reconnect.frames.at(-1)).toMatchObject({ type: "error", code: "INBOX_FRAME_TOO_LARGE" });
    expect(stream.subscriptionCount()).toBe(0);
  });
  test("revocation between parse and dispatch and during idle polling stops operational delivery", async () => {
    ingest("seed");
    const parsed = socket();
    parsed.handlers.onMessage(new MessageEvent("message", { data: JSON.stringify({ type: "inbox_subscribe", view: "queue" }) }), parsed.ws);
    host.revokePrincipals([parsed.principal.id], 1008, "Sessions invalidated");
    await Bun.sleep(0);
    expect(parsed.frames).toHaveLength(0);
    const idle = socket(), survivor = socket();
    await idle.subscribe(); await survivor.subscribe();
    foreignDb.query("UPDATE principals SET revoked_at = ? WHERE id = ?").run(Date.now(), idle.principal.id);
    stream.pump();
    expect(idle.closed).toEqual([1008]);
    expect(stream.subscriptionCount()).toBe(1);
    ingest("after-revocation", foreign); stream.pump();
    expect(deltas(idle.frames)).toHaveLength(0);
    expect(deltas(survivor.frames)).toHaveLength(2);
  });
  test("durable expiry is checked before delivery, including expiry changed through another connection", async () => {
    ingest("seed");
    const s = socket(); await s.subscribe();
    foreignDb.query("UPDATE principals SET expires_at = ? WHERE id = ?").run(Date.now() - 1, s.principal.id);
    ingest("expired", foreign); stream.pump();
    expect(deltas(s.frames)).toHaveLength(0);
    expect(s.closed).toEqual([1008]);
    expect(stream.subscriptionCount()).toBe(0);
  });
  test("fresh Hono wrappers, unsubscribe, parsed-then-closed frames, revocation and host close release subscriptions", async () => {
    ingest("seed");
    const s = socket(); await s.subscribe();
    expect(stream.subscriptionCount()).toBe(1);
    stream.handleUnsubscribe({ ...s.ws }, { type: "inbox_unsubscribe", view: "queue" });
    expect(stream.subscriptionCount()).toBe(0);
    s.handlers.onMessage(new MessageEvent("message", { data: JSON.stringify({ type: "inbox_subscribe", view: "queue" }) }), s.ws);
    s.handlers.onClose(new CloseEvent("close", { code: 1000 }), { ...s.ws });
    await Bun.sleep(0);
    expect(stream.subscriptionCount()).toBe(0);
    expect(host.coordinator.authorizationRegistry.size).toBe(0);
    const revoked = socket(); await revoked.handlers.onOpen(new Event("open"), revoked.ws); await revoked.subscribe();
    host.revokePrincipals([revoked.principal.id], 1008, "Sessions invalidated");
    expect(stream.subscriptionCount()).toBe(0);
    const last = socket(); await last.subscribe();
    host.close();
    expect(stream.subscriptionCount()).toBe(0);
    const count = last.frames.length;
    ingest("after-close", foreign); stream.pump(); await last.subscribe();
    expect(last.frames).toHaveLength(count);
  });
  test("an unavailable host reports unsupported subscriptions and preserves the ordinary handshake", async () => {
    const backend = makeFakeBackend({ id: "old-host" });
    const old = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db) });
    try {
      const principal = createPrincipal(db, { authMethod: "password", label: "Example session", ttlSeconds: 3600 });
      const frames: ServerMessage[] = [];
      const ws: WSContext = { send: (f) => frames.push(JSON.parse(f)), close() {} };
      const handlers = createWsHandlers(old, principal);
      await handlers.onOpen(new Event("open"), ws);
      expect(frames.find((f) => f.type === "server_hello")).toMatchObject({ type: "server_hello", capabilities: { multiSession: true } });
      const hello = frames.find((f) => f.type === "server_hello");
      expect(hello?.type === "server_hello" ? hello.capabilities?.inbox : true).toBeUndefined();
      for (const type of ["inbox_subscribe", "inbox_unsubscribe"]) {
        handlers.onMessage(new MessageEvent("message", { data: JSON.stringify({ type, view: "queue" }) }), ws);
        await Bun.sleep(0);
        expect(frames.at(-1)).toMatchObject({ type: "error", code: "INBOX_UNAVAILABLE" });
      }
      handlers.onClose(new CloseEvent("close", { code: 1000 }), ws);
    } finally { old.close(); }
  });

  test("high-water metadata is also chunked losslessly, including the constructor property name", async () => {
    ingest("seed");
    const snapshot = store.snapshot();
    snapshot.highWaterSeq = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`thread-${i}-` + "x".repeat(235), i + 1]));
    snapshot.highWaterSeq["constructor"] = 8;
    store.snapshot = () => snapshot;
    const s = socket(); await s.subscribe();
    const snapshots = s.frames.filter((f): f is InboxSnapshot => f.type === "inbox_snapshot");
    expect(snapshots.length).toBeGreaterThan(1);
    expect(Object.assign({}, ...snapshots.map((f) => f.highWaterSeq))).toEqual(snapshot.highWaterSeq);
    expect(s.wires.every((f) => Buffer.byteLength(f, "utf8") <= 512_000)).toBe(true);
  });
  test("new thread names do not inherit fake high-water marks from Object.prototype", async () => {
    const s = socket(); await s.subscribe();
    foreign.ingest({ threadId: "constructor", itemId: "item-prototype", dedupKey: "prototype", stagingId: "stage", source: "share", stakes: 1, expiresAt: Date.now() + 10000 });
    stream.pump();
    expect(deltas(s.frames)).toHaveLength(2);
    expect(deltas(s.frames).at(-1)?.change).toMatchObject({ kind: "upsert_item", item: { id: "item-prototype" } });
  });
  test("revocation between snapshot chunks prevents the next chunk from being sent", async () => {
    ingest("seed");
    store.commit(Array.from({ length: 180 }, (_, i) => ({ kind: "item" as const, item: action(`chunk-${i}`, "thread-seed", "界".repeat(1200)) })));
    const s = socket();
    const send = s.ws.send;
    s.ws.send = (data) => {
      send(data);
      if (JSON.parse(data).type === "inbox_snapshot") foreignDb.query("UPDATE principals SET revoked_at = ? WHERE id = ?").run(Date.now(), s.principal.id);
    };
    await s.subscribe("actions");
    expect(s.frames.filter((f) => f.type === "inbox_snapshot")).toHaveLength(1);
    expect(s.closed).toEqual([1008]);
    expect(stream.subscriptionCount()).toBe(0);
  });
  test("queued backpressure survives and dropped or throwing transports release the subscription", async () => {
    ingest("seed");
    const s = socket();
    let result = -1;
    (s.ws.raw as { send?: (data: string) => number }).send = (data) => { if (result !== 0) s.ws.send(data); return result; };
    await s.subscribe();
    expect(s.frames.filter((f) => f.type === "inbox_snapshot")).toHaveLength(1);
    expect(stream.subscriptionCount()).toBe(1);
    result = 0;
    ingest("dropped", foreign); stream.pump();
    expect(deltas(s.frames)).toHaveLength(0);
    expect(s.closed).toEqual([1011]);
    expect(stream.subscriptionCount()).toBe(0);
    const throwing = socket();
    throwing.ws.send = () => { throw new Error("Transport failure"); };
    await throwing.subscribe();
    expect(throwing.closed).toEqual([1011]);
    expect(stream.subscriptionCount()).toBe(0);
  });
  test("unsubscribe stops the foreign-write poller and failed snapshots release authorization", async () => {
    ingest("seed");
    const s = socket(); await s.subscribe();
    expect(stream.subscriptionCount()).toBe(1);
    let scans = 0;
    const original = store.changesSince.bind(store);
    store.changesSince = (...args) => { scans++; return original(...args); };
    stream.handleUnsubscribe(s.ws, { type: "inbox_unsubscribe", view: "queue" });
    ingest("idle", foreign);
    await Bun.sleep(150);
    expect(scans).toBe(0);
    const failed = socket();
    store.snapshot = () => { throw new Error("Snapshot read failed"); };
    await failed.subscribe();
    expect(failed.frames.at(-1)).toMatchObject({ type: "error", code: "INTERNAL_ERROR" });
    failed.handlers.onClose(new CloseEvent("close", { code: 1000 }), failed.ws);
    expect(stream.subscriptionCount()).toBe(0);
    // Only the still-open ordinary socket remains registered.
    expect(host.coordinator.authorizationRegistry.size).toBe(1);
  });

  test("the subscription cap rejects a new scope but permits replacing an existing scope", async () => {
    for (let i = 0; i < 65; i++) ingest(`scope-${i}`);
    const s = socket();
    for (let i = 0; i < 64; i++) await s.subscribe("queue", `thread-scope-${i}`);
    expect(stream.subscriptionCount()).toBe(64);
    await s.subscribe("queue", "thread-scope-64");
    expect(s.frames.at(-1)).toMatchObject({ type: "error", code: "INBOX_SUBSCRIPTION_LIMIT" });
    await s.subscribe("queue", "thread-scope-0");
    expect(s.frames.at(-1)).toMatchObject({ type: "inbox_snapshot", threadId: "thread-scope-0" });
    expect(stream.subscriptionCount()).toBe(64);
  });

});

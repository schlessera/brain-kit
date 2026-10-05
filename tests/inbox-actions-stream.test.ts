/**
 * Durable Actions end to end (#684): the real ui-server stream, resolver and
 * WebSocket dispatch, feeding two real ui-react client roots. Each server
 * frame is parsed by the SDK wire parser and handed to the client's own
 * frame handler, so this is the path a browser takes minus the socket.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, InboxActionItem, InboxOperation, ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import { createUiDb } from "../packages/ui-server/src/db/client.js";
import { createPrincipal } from "../packages/ui-server/src/db/principals.js";
import { createInboxStore } from "../packages/ui-server/src/inbox/store.js";
import { createInboxStream } from "../packages/ui-server/src/inbox/stream.js";
import { createInboxResolver } from "../packages/ui-server/src/inbox/resolve.js";
import { createInboxAction } from "../packages/ui-server/src/inbox/actions.js";
import { inboxPriority } from "../packages/ui-server/src/inbox/state.js";
import { createStaticBackendRegistry } from "../packages/ui-server/src/agent/backend.js";
import { WsHost } from "../packages/ui-server/src/ws/host.js";
import { createSessionCatalog } from "../packages/ui-server/src/ws/session-catalog.js";
import { createWsHandlers } from "../packages/ui-server/src/ws/connection.js";
import type { WSContext } from "../packages/ui-server/src/ws/clients.js";
import { makeFakeBackend } from "../packages/ui-server/tests/helpers/fake-backend.js";
import { createBrainUiRoot, type BrainUiRoot } from "../packages/ui-react/src/root.js";
import { pendingDecisionCount } from "../packages/ui-react/src/stores/inbox-state.js";
import { decisionPriority } from "../packages/ui-react/src/components/activity/inbox-model.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const operation: InboxOperation = {
  toolName: "Edit",
  input: { path: "finances/ithaca-port.md", append: "| 2026-07-12 | harbour fee | 12 dr |" },
  targetPath: "finances/ithaca-port.md",
};

function fixture(allowed: () => InboxOperation[] = () => [operation]) {
  const dir = mkdtempSync(join(tmpdir(), "brain-inbox-actions-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = createUiDb(join(dir, "ui.sqlite"));
  cleanup.push(() => db.close());
  const store = createInboxStore(db);
  const stream = createInboxStream(store, db, undefined, createInboxResolver(db, { allowedOperations: allowed }));
  cleanup.push(() => stream.close());
  const backend = makeFakeBackend({ id: "fake" });
  const host = new WsHost({
    registry: createStaticBackendRegistry([backend], backend.id),
    catalog: createSessionCatalog(() => db),
    inbox: stream,
  });
  cleanup.push(() => host.close());
  const now = Date.now();
  function seed(id: string, extra: Partial<InboxActionItem> = {}): InboxActionItem {
    store.ingest({ threadId: `thread-${id}`, itemId: `work-${id}`, dedupKey: `work-${id}`, stagingId: `staging-${id}`, source: "share", stakes: 1, expiresAt: now + 30 * 86_400_000 });
    const action: InboxActionItem = {
      id: `action-${id}`, dedupKey: `action-${id}`, threadId: `thread-${id}`, queue: "actions", type: "approve", status: "pending",
      version: 1, createdAt: now, updatedAt: now, expiresAt: now + 30 * 86_400_000,
      payload: { title: "File the harbour-fee notice into the port ledger?", detail: "Penelope forwarded the Ithaca port notice." },
      options: [
        { id: "approve", label: "File it", effect: { kind: "enqueue", payload: { instruction: "Append the fee row", operation } } },
        { id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } },
      ],
      ...extra,
    };
    expect(createInboxAction(db, action, [operation])).toBe(true);
    return action;
  }
  /** One device: a real client root wired to a real server connection. */
  async function device(label: string) {
    const principal = createPrincipal(db, { authMethod: "password", label, ttlSeconds: 3600 });
    const handlers = createWsHandlers(host, principal);
    const root: BrainUiRoot = createBrainUiRoot({ storage: null, request: async () => { throw new Error("keyless and offline"); } });
    cleanup.push(() => root.dispose());
    let held: ServerMessage[] | null = null;
    const sent: ClientMessage[] = [];
    const ws: WSContext = {
      raw: {},
      send(data) {
        const parsed = parseServerMessage(data);
        if (!parsed.ok) throw new Error(parsed.error);
        if (held) held.push(parsed.message);
        else root.connection.handleServerMessage(parsed.message);
      },
      close() {},
    };
    async function frame(msg: ClientMessage) {
      sent.push(msg);
      handlers.onMessage(new MessageEvent("message", { data: JSON.stringify(msg) }), ws);
      await Bun.sleep(5);
    }
    // The client's own frames (its hello-time subscriptions, a refusal's
    // fresh-snapshot request) take this socket to the real server.
    root.connection.send = (msg) => { void frame(msg); return true; };
    await handlers.onOpen(new Event("open"), ws);
    await Bun.sleep(20);
    expect(root.stores.inbox.getState().supported).toBe(true);
    expect(sent.filter((m) => m.type === "inbox_subscribe").map((m) => (m as { view: string }).view).sort()).toEqual(["actions", "queue"]);
    return {
      root, sent, frame,
      inbox: () => root.stores.inbox.getState(),
      /** Hold this device's incoming frames, as a slow network would. */
      hold() { held = []; },
      release() { const frames = held ?? []; held = null; for (const m of frames) root.connection.handleServerMessage(m); },
      /** Record, then send: the order the card uses. The frame is in flight
       * until the server has handled it. */
      async approve(item: InboxActionItem) {
        const begun = root.stores.inbox.getState().beginDecision(item.id, { kind: "commit", optionId: "approve", label: "Approve", receipt: "Approved · queued Edit → finances/ithaca-port.md" });
        await frame({ type: "inbox_resolve", itemId: item.id, optionId: "approve" });
        return begun;
      },
    };
  }
  return { db, store, stream, seed, device };
}

test("the client mirror counts open decisions from the real snapshot", async () => {
  const f = fixture();
  f.seed("one");
  f.seed("two");
  const a = await f.device("Laptop");
  expect(a.inbox().online).toBe(true);
  expect(Object.keys(a.inbox().items).filter((id) => id.startsWith("action-")).sort()).toEqual(["action-one", "action-two"]);
  expect(pendingDecisionCount(a.inbox())).toBe(2);
  expect(Object.values(a.inbox().items).some((item) => item.queue === "queue" && item.status === "blocked")).toBe(false);
});

test("approval is confirmed by the delta on this device and shown as resolved elsewhere on the other", async () => {
  const f = fixture();
  const action = f.seed("harbour");
  const a = await f.device("Laptop");
  const b = await f.device("Phone");
  // Nothing has been confirmed at the moment of sending: the card stays.
  a.hold();
  expect(await a.approve(action)).toBe(true);
  expect(a.inbox().inFlight[action.id]?.state).toBe("applying");
  expect(a.inbox().items[action.id]).toMatchObject({ status: "pending" });
  expect(pendingDecisionCount(a.inbox())).toBe(1);
  a.release();
  expect(a.inbox().inFlight[action.id]).toBeUndefined();
  expect(a.inbox().outcomes[action.id]).toMatchObject({ kind: "receipt", status: "resolved", by: "you", text: "Approved · queued Edit → finances/ithaca-port.md" });
  expect(b.inbox().outcomes[action.id]).toMatchObject({ kind: "receipt", status: "resolved", by: "elsewhere" });
  expect(pendingDecisionCount(a.inbox())).toBe(0);
  expect(pendingDecisionCount(b.inbox())).toBe(0);
  const resolutions = f.db.query("SELECT COUNT(*) AS n FROM inbox_resolutions WHERE item_id = ?").get(action.id) as { n: number };
  expect(resolutions.n).toBe(1);
  const followUps = Object.values(a.inbox().items).filter((item) => item.queue === "queue" && item.type === "execute");
  expect(followUps).toHaveLength(1);
});

test("a dismissal that loses the race says so and is not applied", async () => {
  const f = fixture();
  const action = f.seed("raft");
  const a = await f.device("Laptop");
  const b = await f.device("Phone");
  b.hold();
  await a.approve(action);
  // B still sees the old card and dismisses it. The server refuses that.
  expect(b.inbox().beginDecision(action.id, { kind: "dismiss", optionId: "dismiss", label: "Dismiss", receipt: "Dismissed" })).toBe(true);
  await b.frame({ type: "inbox_resolve", itemId: action.id, optionId: "dismiss" });
  b.release();
  expect(b.inbox().outcomes[action.id]).toMatchObject({ kind: "receipt", status: "resolved", by: "elsewhere", lost: "Dismiss" });
  expect(b.inbox().inFlight[action.id]).toBeUndefined();
  const row = f.db.query("SELECT option_id FROM inbox_resolutions WHERE item_id = ?").get(action.id) as { option_id: string };
  expect(row.option_id).toBe("approve");
});

test("a generic refusal unlocks every decision in flight and reconciles from a fresh snapshot without resending", async () => {
  // No operation is allowed now: the server refuses the approval.
  const f = fixture(() => []);
  const one = f.seed("one");
  const two = f.seed("two");
  const a = await f.device("Laptop");
  expect(await a.approve(one)).toBe(true);
  await Bun.sleep(5);
  expect(a.inbox().inFlight[one.id]).toBeUndefined();
  expect(a.inbox().outcomes[one.id]).toEqual({ kind: "not-applied" });
  // The refusal asked for one fresh snapshot, and resent nothing.
  expect(a.sent.filter((m) => m.type === "inbox_resolve")).toHaveLength(1);
  expect(a.sent.filter((m) => m.type === "inbox_subscribe" && m.view === "actions")).toHaveLength(2);
  expect(a.inbox().items[one.id]).toMatchObject({ status: "pending" });
  expect(a.inbox().items[two.id]).toMatchObject({ status: "pending" });
});

test("a snoozed decision shows the server's time and can still be approved directly", async () => {
  const f = fixture();
  const action = f.seed("ogygia");
  const a = await f.device("Laptop");
  expect(a.inbox().beginDecision(action.id, { kind: "later", label: "Later", receipt: "Snoozed" })).toBe(true);
  await a.frame({ type: "inbox_snooze", itemId: action.id });
  const stored = f.store.getItem(action.id) as InboxActionItem;
  expect(stored.waitUntil).toBeGreaterThan(Date.now());
  expect(a.inbox().items[action.id]).toMatchObject({ status: "snoozed", waitUntil: stored.waitUntil });
  expect(a.inbox().outcomes[action.id]).toMatchObject({ kind: "receipt", status: "snoozed", by: "you", waitUntil: stored.waitUntil });
  expect(pendingDecisionCount(a.inbox())).toBe(0);
  expect(await a.approve(action)).toBe(true);
  expect(a.inbox().outcomes[action.id]).toMatchObject({ kind: "receipt", status: "resolved", by: "you" });
});

test("a socket lost after sending reconciles from the reconnect snapshot", async () => {
  const f = fixture();
  const landed = f.seed("landed");
  const lost = f.seed("lost");
  const a = await f.device("Laptop");
  a.hold();
  await a.approve(landed);
  // The second answer never reaches the server.
  a.inbox().beginDecision(lost.id, { kind: "commit", optionId: "approve", label: "Approve", receipt: "Approved" });
  a.inbox().connectionLost();
  expect(a.inbox().inFlight[landed.id]?.state).toBe("unconfirmed");
  expect(a.inbox().online).toBe(false);
  // Frames from the dead socket arrive late: without a snapshot they are ignored.
  a.release();
  expect(a.inbox().inFlight[landed.id]?.state).toBe("unconfirmed");
  // Reconnect: fresh snapshots decide; nothing is resent.
  const resolves = a.sent.filter((m) => m.type === "inbox_resolve").length;
  await a.frame({ type: "inbox_subscribe", view: "actions" });
  await a.frame({ type: "inbox_subscribe", view: "queue" });
  expect(a.inbox().outcomes[landed.id]).toMatchObject({ kind: "receipt", status: "resolved", by: "you", afterReconnect: true });
  expect(a.inbox().outcomes[lost.id]).toEqual({ kind: "not-received", label: "Approve" });
  expect(a.inbox().items[lost.id]).toMatchObject({ status: "pending" });
  expect(a.sent.filter((m) => m.type === "inbox_resolve")).toHaveLength(resolves);
});

test("the client orders decisions by the server's priority formula", () => {
  const now = Date.UTC(2026, 6, 12, 9);
  for (const stakes of [0, 1, 2, 3]) {
    for (const deadline of [undefined, now + 3_600_000, now + 2 * 86_400_000, now + 5 * 86_400_000, now + 30 * 86_400_000]) {
      for (const age of [0, 1, 4, 9]) {
        const createdAt = now - age * 86_400_000;
        expect(decisionPriority(stakes, deadline, createdAt, 0, now)).toBe(inboxPriority(stakes, deadline, createdAt, 0, now));
      }
    }
  }
});

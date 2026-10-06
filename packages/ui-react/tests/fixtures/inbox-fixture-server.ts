import type {
  ClientMessage,
  InboxActionItem,
  InboxChange,
  InboxItem,
  InboxQueueItem,
  InboxThread,
  InboxView,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";

/**
 * An in-browser durable inbox for the Actions browser tests (#684).
 *
 * The real server (`packages/ui-server/src/inbox/`) runs on bun:sqlite and
 * cannot run in Chromium; `tests/inbox-actions-stream.test.ts` drives the
 * real one against the same client store. This fixture keeps that stream's
 * protocol rules — per-view snapshots, per-thread seq, deltas to every
 * subscribed connection, server-computed snooze times, unique resolution and
 * an unattributed `INBOX_DECISION_REFUSED` — so the cards can be exercised
 * through the real client frame handler. Every frame it emits passes the
 * SDK's wire parser first, as a browser's would.
 */

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface FixtureClient {
  id: string;
  deliver: (msg: ServerMessage) => void;
  online: boolean;
  /** Frames held while `hold` is set, released in order. */
  held: ServerMessage[] | null;
  views: Set<InboxView>;
  sent: ClientMessage[];
}

export function createInboxFixtureServer(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const threads = new Map<string, InboxThread>();
  const items = new Map<string, InboxItem>();
  const seq = new Map<string, number>();
  const resolutions = new Map<string, { optionId: string; reason?: string; client: string }>();
  const clients = new Map<string, FixtureClient>();
  let changeId = 0;
  /** Refuse the next n decision frames, whatever they are. */
  let refuseNext = 0;
  /** Swallow decision frames without any reply, as a stalled host would. */
  let stall = false;
  /** Snooze offset the server applies, in ms. */
  let snoozeFor = 10 * 3_600_000;
  const policyWrites: unknown[] = [];

  function emit(client: FixtureClient, msg: ServerMessage) {
    const parsed = parseServerMessage(JSON.stringify(msg));
    if (!parsed.ok) throw new Error(`fixture emitted an invalid frame: ${parsed.error}`);
    if (!client.online) return;
    if (client.held) client.held.push(parsed.message);
    else client.deliver(parsed.message);
  }
  function snapshot(client: FixtureClient, view: InboxView) {
    const highWaterSeq: Record<string, number> = {};
    for (const [id, n] of seq) highWaterSeq[id] = n;
    emit(client, {
      type: "inbox_snapshot", view,
      threads: [...threads.values()],
      items: [...items.values()].filter((item) => item.queue === view),
      highWaterSeq, cursor: changeId,
    });
  }
  function change(threadId: string, body: DistOmit<InboxChange, "changeId" | "threadId" | "seq">) {
    const next = (seq.get(threadId) ?? 0) + 1;
    seq.set(threadId, next);
    const full = { ...body, changeId: ++changeId, threadId, seq: next } as InboxChange;
    for (const client of clients.values()) {
      for (const view of client.views) {
        if (full.kind === "upsert_item" && full.item.queue !== view) continue;
        emit(client, { type: "inbox_delta", view, change: full });
      }
    }
  }
  function putThread(thread: InboxThread) {
    threads.set(thread.id, thread);
    change(thread.id, { kind: "upsert_thread", thread });
  }
  function putItem(item: InboxItem) {
    items.set(item.id, item);
    change(item.threadId, { kind: "upsert_item", itemId: item.id, item });
  }
  function transition<T extends InboxItem>(item: T, patch: Partial<T>) {
    putItem({ ...item, ...patch, version: item.version + 1, updatedAt: now() } as T);
  }
  function refuse(client: FixtureClient) {
    emit(client, { type: "error", code: "INBOX_DECISION_REFUSED", message: "The decision could not be applied. Refresh the Action and check its current authority." });
  }

  function receive(clientId: string, msg: ClientMessage): boolean {
    const client = clients.get(clientId)!;
    if (!client.online) return false;
    client.sent.push(msg);
    // Answer asynchronously, as a socket does.
    queueMicrotask(() => handle(client, msg));
    return true;
  }
  function handle(client: FixtureClient, msg: ClientMessage) {
    if (!client.online) return;
    if (msg.type === "inbox_subscribe") {
      client.views.add(msg.view);
      snapshot(client, msg.view);
      return;
    }
    if (msg.type !== "inbox_resolve" && msg.type !== "inbox_snooze") return;
    if (stall) return;
    if (refuseNext > 0) { refuseNext--; refuse(client); return; }
    const item = items.get(msg.itemId);
    if (!item || item.queue !== "actions" || item.type === "fyi" || !["pending", "snoozed"].includes(item.status)) {
      refuse(client);
      return;
    }
    if (msg.type === "inbox_snooze") {
      if (item.status === "snoozed") return;
      transition(item, { status: "snoozed", waitUntil: now() + snoozeFor });
      return;
    }
    const option = item.options.find((o) => o.id === msg.optionId);
    if (!option || option.effect.kind === "write_policy" || option.effect.kind === "open_session") { refuse(client); return; }
    if (option.effect.kind === "snooze") { transition(item, { status: "snoozed", waitUntil: now() + snoozeFor }); return; }
    const prior = resolutions.get(item.id);
    if (prior) { refuse(client); return; }
    resolutions.set(item.id, { optionId: option.id, ...(msg.reason ? { reason: msg.reason } : {}), client: client.id });
    for (const blocked of items.values()) {
      if (blocked.queue === "queue" && blocked.status === "blocked" && blocked.blockedByItemId === item.id) transition(blocked, { status: "superseded" });
    }
    transition(item, { status: option.effect.kind === "dismiss" ? "dismissed" : "resolved" });
    if (option.effect.kind === "enqueue") {
      putItem({
        id: `follow-up-${item.id}`, dedupKey: `follow-up-${item.id}`, threadId: item.threadId, queue: "queue", type: "execute",
        status: "ready", version: 1, attempts: 0, maxAttempts: 3, createdAt: now(), updatedAt: now(), expiresAt: item.expiresAt,
        payload: option.effect.payload,
      });
    }
  }

  return {
    threads, items, resolutions, policyWrites, clients,
    connect(id: string, deliver: (msg: ServerMessage) => void): FixtureClient {
      const client: FixtureClient = { id, deliver, online: true, held: null, views: new Set(), sent: [] };
      clients.set(id, client);
      return client;
    },
    receive,
    /** Close a client's socket: its subscriptions die with it. */
    disconnect(id: string) {
      const client = clients.get(id)!;
      client.online = false;
      client.views.clear();
    },
    reconnect(id: string) {
      const client = clients.get(id)!;
      client.online = true;
      client.held = null;
    },
    hold(id: string) { clients.get(id)!.held = []; },
    release(id: string) {
      const client = clients.get(id)!;
      const frames = client.held ?? [];
      client.held = null;
      for (const msg of frames) client.deliver(msg);
    },
    refuseNext(n = 1) { refuseNext = n; },
    stall(on = true) { stall = on; },
    setSnoozeFor(ms: number) { snoozeFor = ms; },
    putThread,
    putItem,
    /** Seed without deltas, before anyone subscribes. */
    seed(thread: InboxThread, list: InboxItem[]) {
      threads.set(thread.id, thread);
      for (const item of list) items.set(item.id, item);
      seq.set(thread.id, (seq.get(thread.id) ?? 0) + list.length + 1);
    },
    /** A server-side edit that bumps the version of an open decision. */
    revise(id: string, patch: Partial<InboxActionItem>) {
      const item = items.get(id) as InboxActionItem;
      transition(item, patch);
    },
    retire(id: string, status: "dropped" | "expired") {
      const item = items.get(id) as InboxActionItem;
      transition(item, { status });
    },
    action(id: string): InboxActionItem { return items.get(id) as InboxActionItem; },
    queueItem(id: string): InboxQueueItem { return items.get(id) as InboxQueueItem; },
  };
}

export type InboxFixtureServer = ReturnType<typeof createInboxFixtureServer>;

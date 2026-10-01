import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import type {
  ClientInboxSubscribe, ClientInboxUnsubscribe, InboxChange, InboxSnapshot,
  InboxView, ServerMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import type { WSContext } from "../ws/clients.js";
import { MAX_WS_MESSAGE_BYTES } from "../ws/shrink.js";
import type { AuthorizationContext } from "../ws/turns.js";
import type { InboxStore, InboxStoreSnapshot } from "./store.js";

const POLL_MS = 100;
const CHANGE_BATCH = 200;
const MAX_BATCHES_PER_PUMP = 5;
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 64;

export interface InboxStream {
  handleSubscribe(ws: WSContext, msg: ClientInboxSubscribe, authorization: AuthorizationContext): void;
  handleUnsubscribe(ws: WSContext, msg: ClientInboxUnsubscribe): void;
  dropConnection(ws: WSContext): void;
  dropFor(principalId: string): void;
  pump(): void;
  subscriptionCount(): number;
  close(): void;
}
interface Subscription {
  view: InboxView;
  threadId?: string;
  cursor: number;
  highWaterSeq: Record<string, number>;
}
interface Connection {
  ws: WSContext;
  authorization: AuthorizationContext;
  release: () => void;
  subscriptions: Map<string, Subscription>;
}
function key(ws: WSContext): unknown { return ws.raw ?? ws; }
function scope(msg: ClientInboxSubscribe | ClientInboxUnsubscribe): string {
  return JSON.stringify([msg.view, msg.threadId ?? null]);
}
class FrameTooLarge extends Error {}

/** Build every chunk before sending any: one oversized record is an explicit failure. */
function snapshotFrames(snapshot: InboxStoreSnapshot, msg: ClientInboxSubscribe): string[] {
  const base = (): InboxSnapshot => ({
    type: "inbox_snapshot", view: msg.view,
    ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
    threads: [], items: [], highWaterSeq: Object.create(null), cursor: snapshot.cursor,
  });
  const frames: string[] = [];
  let frame = base();
  let bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
  let highWaterCount = 0;
  // Entries as well as rows are chunked: repeating an unbounded high-water map
  // in every frame would make even a one-row chunk exceed the transport cap.
  const flush = () => {
    frames.push(JSON.stringify(frame));
    frame = { ...base(), append: true };
    bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    highWaterCount = 0;
  };
  const add = (put: (frame: InboxSnapshot) => void, recordBytes: number, occupied: () => boolean) => {
    let extra = recordBytes + (occupied() ? 1 : 0);
    if (bytes + extra > MAX_WS_MESSAGE_BYTES) {
      flush();
      extra = recordBytes;
    }
    if (bytes + extra > MAX_WS_MESSAGE_BYTES) throw new FrameTooLarge();
    put(frame);
    bytes += extra;
  };
  for (const [id, seq] of Object.entries(snapshot.highWaterSeq)) {
    if (msg.threadId !== undefined && id !== msg.threadId) continue;
    add((f) => { f.highWaterSeq[id] = seq; highWaterCount++; },
      Buffer.byteLength(`${JSON.stringify(id)}:${seq}`, "utf8"), () => highWaterCount > 0);
  }
  for (const thread of snapshot.threads) {
    if (msg.threadId !== undefined && thread.id !== msg.threadId) continue;
    add((f) => { f.threads.push(thread); }, Buffer.byteLength(JSON.stringify(thread), "utf8"), () => frame.threads.length > 0);
  }
  for (const item of snapshot.items) {
    if (item.queue !== msg.view || (msg.threadId !== undefined && item.threadId !== msg.threadId)) continue;
    add((f) => { f.items.push(item); }, Buffer.byteLength(JSON.stringify(item), "utf8"), () => frame.items.length > 0);
  }
  flush();
  return frames;
}

/**
 * The inbox owns its frozen change log, separate from activity. The global
 * cursor scans writes from every database connection; each subscription owns
 * the transaction boundary captured with its snapshot. A later subscriber
 * must never move the scan cursor past changes still owed to an earlier one.
 */
export function createInboxStream(store: InboxStore, db: Database, log?: Logger): InboxStream {
  const connections = new Map<unknown, Connection>();
  let cursor = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let pumping = false;

  function stopIfIdle(): void {
    if (connections.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }
  function dropConnection(ws: WSContext): void {
    const entry = connections.get(key(ws));
    if (!entry) return;
    connections.delete(key(ws));
    entry.release();
    stopIfIdle();
  }
  function closeConnection(entry: Connection, code: number, reason: string): void {
    dropConnection(entry.ws);
    try { entry.ws.close?.(code, reason); } catch { /* Transport already closed. */ }
  }
  function authorized(entry: Connection): boolean {
    const auth = entry.authorization;
    try {
      const now = Date.now();
      const principal = auth.valid && now < auth.expiresAt ? resolvePrincipal(db, auth.principalId) : null;
      if (principal !== null && isUsablePrincipal(principal, now)) return true;
    } catch (error) {
      log?.emit({ severityText: "ERROR", body: "inbox authorization check failed",
        attributes: { error: error instanceof Error ? error.message : String(error) } });
    }
    auth.valid = false;
    closeConnection(entry, 1008, "Sessions invalidated");
    return false;
  }
  function send(entry: Connection, data: string): boolean {
    if (!authorized(entry)) return false;
    try {
      const raw = entry.ws.raw as { send?: (data: string) => number } | undefined;
      // Hono discards Bun's return value. Zero means a dropped frame; -1 is
      // queued backpressure. Preserve that distinction and recover by snapshot.
      if (raw && typeof raw.send === "function") {
        if (raw.send(data) === 0) throw new Error("Socket dropped inbox frame");
      } else {
        entry.ws.send(data);
      }
      return true;
    } catch {
      closeConnection(entry, 1011, "Inbox delivery failed; reconnect");
      return false;
    }
  }
  function error(entry: Connection, code: string, message: string): void {
    const frame: ServerMessage = { type: "error", code, message };
    send(entry, JSON.stringify(frame));
  }
  function tooLarge(entry: Connection): void {
    error(entry, "INBOX_FRAME_TOO_LARGE", "Inbox record exceeds the frame limit; subscription stopped.");
    closeConnection(entry, 1009, "Inbox record exceeds frame limit");
  }
  function subscriptionCount(): number {
    let count = 0;
    for (const entry of connections.values()) count += entry.subscriptions.size;
    return count;
  }
  function matches(sub: Subscription, change: InboxChange): boolean {
    return (sub.threadId === undefined || sub.threadId === change.threadId)
      && change.changeId > sub.cursor
      && change.seq > (Object.hasOwn(sub.highWaterSeq, change.threadId) ? sub.highWaterSeq[change.threadId] : 0);
  }
  function pump(): void {
    if (closed || pumping || connections.size === 0) return;
    pumping = true;
    try {
      // Check idle sockets too: revocation need not coincide with a write.
      for (const entry of [...connections.values()]) authorized(entry);
      for (let batch = 0; batch < MAX_BATCHES_PER_PUMP && connections.size > 0; batch++) {
        const changes = store.changesSince(cursor, CHANGE_BATCH);
        if (changes.length === 0) break;
        for (const change of changes) {
          for (const entry of [...connections.values()]) {
            const views = new Set<InboxView>();
            for (const sub of entry.subscriptions.values()) {
              if (!matches(sub, change)) continue;
              sub.cursor = change.changeId;
              sub.highWaterSeq[change.threadId] = change.seq;
              // Thread updates/removals and item tombstones reach both views.
              // An item upsert reaches its own view only. Overlapping filters
              // share a single delta per view on this connection.
              if (change.kind !== "upsert_item" || change.item.queue === sub.view) views.add(sub.view);
            }
            for (const view of views) {
              const data = JSON.stringify({ type: "inbox_delta", view, change });
              if (Buffer.byteLength(data, "utf8") > MAX_WS_MESSAGE_BYTES) {
                tooLarge(entry);
                break;
              }
              if (!send(entry, data)) break;
            }
          }
          cursor = change.changeId;
        }
        if (changes.length < CHANGE_BATCH) break;
      }
    } catch (error) {
      log?.emit({ severityText: "ERROR", body: "inbox change scan failed",
        attributes: { error: error instanceof Error ? error.message : String(error) } });
      // A failed read does not advance the cursor. The next bounded tick retries.
    } finally { pumping = false; }
  }
  function handleSubscribe(ws: WSContext, msg: ClientInboxSubscribe, authorization: AuthorizationContext): void {
    if (closed) return;
    const existing = connections.get(key(ws));
    const entry: Connection = existing ?? { ws, authorization, release: authorization.retain(), subscriptions: new Map() };
    // Include new entries in cleanup, even when admission or snapshot fails.
    connections.set(key(ws), entry);
    if (!authorized(entry)) return;
    const subKey = scope(msg);
    if (!entry.subscriptions.has(subKey) && entry.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
      error(entry, "INBOX_SUBSCRIPTION_LIMIT", "Too many inbox subscriptions on this connection.");
      return;
    }
    const wasIdle = subscriptionCount() === 0;
    let snapshot: InboxStoreSnapshot;
    try { snapshot = store.snapshot(); }
    catch (err) {
      if (entry.subscriptions.size === 0) dropConnection(ws);
      throw err;
    }
    if (msg.threadId !== undefined && !snapshot.threads.some((t) => t.id === msg.threadId)) {
      error(entry, "INBOX_SCOPE_NOT_FOUND", "Inbox thread is unavailable.");
      if (entry.subscriptions.size === 0) dropConnection(ws);
      return;
    }
    let frames: string[];
    try { frames = snapshotFrames(snapshot, msg); }
    catch (err) {
      if (err instanceof FrameTooLarge) { tooLarge(entry); return; }
      if (entry.subscriptions.size === 0) dropConnection(ws);
      throw err;
    }
    for (const frame of frames) if (!send(entry, frame)) return;
    entry.subscriptions.set(subKey, {
      view: msg.view, threadId: msg.threadId, cursor: snapshot.cursor,
      highWaterSeq: Object.assign(Object.create(null), snapshot.highWaterSeq),
    });
    if (wasIdle) cursor = snapshot.cursor;
    if (timer === null) {
      timer = setInterval(pump, POLL_MS);
      timer.unref();
    }
  }
  function handleUnsubscribe(ws: WSContext, msg: ClientInboxUnsubscribe): void {
    const entry = connections.get(key(ws));
    if (!entry) return;
    entry.subscriptions.delete(scope(msg));
    if (entry.subscriptions.size === 0) dropConnection(ws);
  }
  function dropFor(principalId: string): void {
    for (const entry of [...connections.values()]) {
      if (entry.authorization.principalId === principalId) dropConnection(entry.ws);
    }
  }
  function close(): void {
    closed = true;
    for (const entry of [...connections.values()]) dropConnection(entry.ws);
    stopIfIdle();
  }
  return { handleSubscribe, handleUnsubscribe, dropConnection, dropFor, pump, subscriptionCount, close };
}

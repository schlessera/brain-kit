/** Concrete lifecycle commands. No inference or filesystem work joins a write. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { InboxActionItem, InboxOperation, InboxQueueItem } from "@schlessera/brain-ui-sdk/protocol";
import { inboxOptionSchema, validateResolutionEffect } from "@schlessera/brain-ui-sdk/schemas";
import { createInboxStore } from "./store.js";
import { inboxThreadAwaitingSettlement } from "./lifetime.js";

const DAY = 86_400_000;
export const INBOX_ACTION_CAP = 60;
export interface InboxActionContext {
  classKey: string;
  evidenceBoundary: string;
  suppressionUntil: number;
  reraiseCondition: string;
  sourceItemId?: string;
}
export function inboxIdentity(kind: string, ...parts: string[]): string {
  return `${kind}-${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}
export function inboxActionContext(action: InboxActionItem): InboxActionContext {
  return { classKey: inboxIdentity("action", action.dedupKey), evidenceBoundary: action.dedupKey,
    suppressionUntil: action.expiresAt, reraiseCondition: "New evidence or suppression expiry." };
}
export function inboxActionSuppressed(db: Database, context: InboxActionContext, now: number): boolean {
  const row = db.query("SELECT evidence_boundary, expires_at FROM inbox_suppressions WHERE class_key = ?")
    .get(context.classKey) as { evidence_boundary: string; expires_at: number } | null;
  return !!row && row.expires_at > now && row.evidence_boundary === context.evidenceBoundary;
}

/** Caller owns the encompassing transaction, including any blocked transition. */
export function insertInboxAction(db: Database, action: InboxActionItem, allowed: readonly InboxOperation[], context = inboxActionContext(action), now = Date.now(), hygiene = false): void {
  if (!context.classKey || context.classKey.length > 256 || !context.evidenceBoundary ||
      !context.reraiseCondition || !Number.isSafeInteger(context.suppressionUntil) || context.suppressionUntil < 0)
    throw new Error("Invalid Action lifecycle context");
  if (action.type !== "fyi" && action.options.length === 0) throw new Error("A decision requires options");
  for (const option of action.options) {
    inboxOptionSchema.parse(option);
    const result = validateResolutionEffect(option.effect, allowed, { hygiene });
    if (!result.ok) throw new Error(result.error);
  }
  const store = createInboxStore(db, { now: () => now });
  if (action.options.some(option => option.effect.kind === "enqueue") && db.query("SELECT 1 FROM inbox_items WHERE thread_id = ? AND type = 'cleanup_pending' AND status IN ('claimed','done') LIMIT 1").get(action.threadId))
    throw new Error("Thread staging cleanup has started; fresh intake is required");
  if (context.sourceItemId && store.getItem(context.sourceItemId)?.threadId !== action.threadId)
    throw new Error("Action source belongs to another thread");
  store.commit([{ kind: "item", item: action }]);
  db.query("INSERT INTO inbox_action_contexts (item_id, source_item_id, class_key, evidence_boundary, suppression_until, reraise_condition, options_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(action.id, context.sourceItemId ?? null, context.classKey, context.evidenceBoundary,
      context.suppressionUntil, context.reraiseCondition, JSON.stringify((store.getItem(action.id) as InboxActionItem).options));
}

/** Staging belongs to the thread until its last work/decision is terminal. */
export function enqueueInboxCleanup(db: Database, threadId: string, now: number): void {
  if (inboxThreadAwaitingSettlement(db, threadId)) return;
  const active = db.query(`SELECT 1 FROM inbox_items WHERE thread_id = ? AND deleted_at IS NULL AND
    ((queue = 'queue' AND type != 'cleanup_pending' AND status IN ('scheduled','ready','claimed','blocked','failed')) OR
     (queue = 'actions' AND type != 'fyi' AND status IN ('pending','snoozed'))) LIMIT 1`).get(threadId);
  if (active) return;
  const rows = db.query("SELECT data_json FROM inbox_items WHERE thread_id = ? AND queue = 'queue' AND type = 'triage'")
    .all(threadId) as { data_json: string }[];
  const store = createInboxStore(db, { now: () => now });
  for (const row of rows) {
    const { stagingId } = (JSON.parse(row.data_json) as InboxQueueItem & { type: "triage" }).payload;
    const id = inboxIdentity("cleanup", stagingId);
    if (db.query("SELECT 1 FROM inbox_items WHERE dedup_key = ?").get(id)) continue;
    store.commit([{ kind: "item", item: { id, dedupKey: id, threadId, queue: "queue", type: "cleanup_pending",
      status: "ready", attempts: 0, maxAttempts: 3, version: 1, createdAt: now, updatedAt: now,
      expiresAt: Number.MAX_SAFE_INTEGER, payload: { stagingId } } }]);
  }
}

/** Supersede every block BEFORE retiring its Action, in the caller's transaction. */
export function retireInboxAction(db: Database, action: InboxActionItem, status: "dropped" | "expired", now: number, report = true): void {
  const store = createInboxStore(db, { now: () => now });
  const blocks = db.query("SELECT id FROM inbox_items WHERE deleted_at IS NULL AND status = 'blocked' AND blocked_by_item_id = ?")
    .all(action.id) as { id: string }[];
  for (const { id } of blocks) store.commit([{ kind: "transition", itemId: id, expectedVersion: store.getItem(id)!.version, to: "superseded" }]);
  const stored = db.query("SELECT * FROM inbox_action_contexts WHERE item_id = ?").get(action.id) as {
    source_item_id: string | null; class_key: string; evidence_boundary: string; suppression_until: number; reraise_condition: string;
  } | null;
  const source = stored?.source_item_id ? store.getItem(stored.source_item_id) : null;
  if (source?.queue === "queue" && source.status === "failed")
    store.commit([{ kind: "transition", itemId: source.id, expectedVersion: source.version, to: "dropped" }]);
  store.commit([{ kind: "transition", itemId: action.id, expectedVersion: action.version, to: status }]);
  if (report && action.type !== "fyi") {
    const id = inboxIdentity("retired", action.id);
    store.commit([{ kind: "item", item: { id, dedupKey: id, threadId: action.threadId, queue: "actions", type: "fyi",
      status: "pending", version: 1, createdAt: now, updatedAt: now, expiresAt: now + 30 * DAY,
      payload: { title: status === "expired" ? "A decision expired" : "A decision was dropped at the Actions limit",
        detail: `${action.payload.title}\nAssociated work was stopped; staging cleanup is journaled separately.` }, options: [] } },
    { kind: "suppress", classKey: stored?.class_key ?? inboxActionContext(action).classKey,
      evidenceBoundary: stored?.evidence_boundary ?? action.dedupKey,
      expiresAt: Math.max(now + DAY, stored?.suppression_until ?? action.expiresAt),
      reraiseCondition: stored?.reraise_condition ?? "New evidence or suppression expiry." }]);
  }
  enqueueInboxCleanup(db, action.threadId, now);
}

/** Incoming decisions participate. Even an all-blocking set keeps a hard cap
 * and no orphan: the loser, its blocks and compensation commit together. */
export function enforceInboxActionCap(db: Database, cap = INBOX_ACTION_CAP, now = Date.now()): void {
  if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("Invalid Actions cap");
  const store = createInboxStore(db, { now: () => now });
  for (const { item } of store.orderedItems()) {
    if (item.queue === "actions" && item.type !== "fyi" && ["pending", "snoozed"].includes(item.status) && item.expiresAt <= now)
      retireInboxAction(db, item, "expired", now);
  }
  const candidates = store.orderedItems().filter(({ item }) => item.queue === "actions" && item.type !== "fyi" && ["pending", "snoozed"].includes(item.status))
    .sort((a, b) => a.priority - b.priority || a.item.createdAt - b.item.createdAt || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  for (const { item } of candidates.slice(0, Math.max(0, candidates.length - cap)))
    retireInboxAction(db, item as InboxActionItem, "dropped", now);
}

export function createInboxAction(db: Database, action: InboxActionItem, allowed: readonly InboxOperation[], options: { now?: number; cap?: number; context?: InboxActionContext; hygiene?: boolean } = {}): boolean {
  const now = options.now ?? Date.now(), context = options.context ?? inboxActionContext(action);
  return db.transaction(() => {
    if (inboxActionSuppressed(db, context, now)) return false;
    insertInboxAction(db, action, allowed, context, now, options.hygiene);
    enforceInboxActionCap(db, options.cap, now);
    return true;
  }).immediate();
}

export function inboxRetryAt(now: number, attempts: number): number {
  return now + Math.min(60 * 60_000, 60_000 * 2 ** Math.min(6, Math.max(0, attempts - 1)));
}
/** Stable dead-letter identity; subsequent sweeps do not create new Actions. */
function deadLetter(db: Database, item: InboxQueueItem, now: number, cap?: number): void {
  const id = inboxIdentity("dead-letter", item.id);
  if (db.query("SELECT 1 FROM inbox_items WHERE dedup_key = ?").get(id)) return;
  const action: InboxActionItem = { id, dedupKey: id, threadId: item.threadId, queue: "actions",
    type: item.type === "cleanup_pending" ? "fyi" : "choose", status: "pending", version: 1,
    createdAt: now, updatedAt: now, expiresAt: now + 30 * DAY,
    payload: { title: "Queued work exhausted its retries", detail: `Work ${item.id} stopped after ${item.attempts} attempts.` },
    options: item.type === "cleanup_pending" ? [] : [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }] };
  insertInboxAction(db, action, [], { ...inboxActionContext(action), sourceItemId: item.id }, now);
  enforceInboxActionCap(db, cap, now);
}
/** A thrown/expired worker ends this attempt. It never buys another model call. */
export function failInboxWork(db: Database, itemId: string, expectedVersion: number, now = Date.now(), cap?: number): void {
  db.transaction(() => {
    const store = createInboxStore(db, { now: () => now }), item = store.getItem(itemId);
    if (!item || item.queue !== "queue" || item.status !== "claimed" || item.version !== expectedVersion)
      throw new Error("Inbox version conflict");
    store.commit([{ kind: "transition", itemId, expectedVersion, to: "failed" }]);
    if (item.attempts < item.maxAttempts)
      store.commit([{ kind: "transition", itemId, expectedVersion: expectedVersion + 1, to: "ready", waitUntil: inboxRetryAt(now, item.attempts) }]);
    else deadLetter(db, store.getItem(itemId) as InboxQueueItem, now, cap);
  }).immediate();
}

/** Deterministic maintenance, callable at boot/tick without any backend. */
export function sweepInboxLifecycle(db: Database, now = Date.now(), cap?: number): void {
  db.transaction(() => {
    const store = createInboxStore(db, { now: () => now });
    for (const entry of store.snapshot().items) {
      const item = store.getItem(entry.id)!;
      if (item.queue === "actions" && ["pending", "snoozed"].includes(item.status)) {
        if (item.expiresAt <= now) retireInboxAction(db, item, "expired", now);
        else if (!item.hygiene && item.status === "snoozed" && item.waitUntil !== undefined && item.waitUntil <= now)
          store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "pending", waitUntil: null }]);
      } else if (item.queue === "queue" && item.type !== "cleanup_pending") {
        if (item.expiresAt <= now && item.status === "blocked" && item.blockedByItemId) {
          const blocker = store.getItem(item.blockedByItemId);
          if (blocker?.queue === "actions" && ["pending", "snoozed"].includes(blocker.status)) retireInboxAction(db, blocker, "expired", now);
        } else if (item.expiresAt <= now && ["ready", "scheduled", "failed"].includes(item.status)) {
          store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "expired" }]);
          const id = inboxIdentity("expired-work", item.id);
          store.commit([{ kind: "item", item: { id, dedupKey: id, threadId: item.threadId, queue: "actions", type: "fyi",
            status: "pending", version: 1, createdAt: now, updatedAt: now, expiresAt: now + 30 * DAY,
            payload: { title: "Queued work expired", detail: `Work ${item.id} expired before completion; staging cleanup is journaled separately.` }, options: [] } },
          { kind: "suppress", classKey: inboxIdentity("work", item.dedupKey), evidenceBoundary: item.dedupKey,
            expiresAt: now + DAY, reraiseCondition: "New intake evidence or suppression expiry." }]);
          enqueueInboxCleanup(db, item.threadId, now);
        } else if (item.status === "scheduled" && (item.waitUntil ?? 0) <= now)
          store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "ready", waitUntil: null }]);
        else if (item.status === "failed" && item.attempts >= item.maxAttempts) deadLetter(db, item, now, cap);
        else if (["done", "superseded", "expired", "dropped"].includes(item.status)) enqueueInboxCleanup(db, item.threadId, now);
      }
    }
    enforceInboxActionCap(db, cap, now);
  }).immediate();
}

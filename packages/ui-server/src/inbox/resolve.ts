import type { Database } from "bun:sqlite";
import type { InboxOperation, InboxThread, ClientInboxResolve } from "@schlessera/brain-ui-sdk/protocol";
import type { InboxActionItem } from "@schlessera/brain-ui-sdk/protocol";
import { clientInboxResolveSchema, inboxOptionSchema, validateResolutionEffect } from "@schlessera/brain-ui-sdk/schemas";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { createInboxStore } from "./store.js";
import { enqueueInboxCleanup, inboxIdentity } from "./actions.js";

const DAY = 86_400_000;
/** Calendar rule uses one configured timezone; persisted times remain UTC. */
export function inboxSnoozeUntil(at: number, stakes: number, version: number, timeZone = "UTC"): number {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const calendar = (time: number) => {
    const parts = format.formatToParts(time), get = (key: string) => Number(parts.find(p => p.type === key)!.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  };
  // Higher-stakes decisions use bounded backoff rather than an overnight wait.
  if (stakes > 1) return at + Math.min(8, 2 ** Math.min(3, Math.floor(version / 2))) * 60 * 60_000;
  const date = new Date(calendar(at));
  date.setUTCHours(8, 0, 0, 0);
  do { date.setUTCDate(date.getUTCDate() + 1); } while ([0, 6].includes(date.getUTCDay()));
  const target = date.getTime();
  let utc = target;
  for (let i = 0; i < 4; i++) {
    const delta = target - calendar(utc);
    if (delta === 0) return utc;
    utc += delta;
  }
  throw new Error("Cannot resolve the snooze calendar time");
}

/** Internal engine wiring must derive a fresh envelope from server authority.
 * Checkpoint facts, stored effects and client data cannot supply that envelope. */
export function createInboxResolver(db: Database, deps: {
  allowedOperations: (principalId: string, thread: InboxThread) => readonly InboxOperation[];
  now?: () => number;
  timeZone?: string;
  applyHygiene?: (principalId: string, request: ClientInboxResolve) => Promise<{ replay: boolean; followUpId: string | undefined }>;
}) {
  const now = deps.now ?? Date.now, timeZone = deps.timeZone ?? "UTC", store = createInboxStore(db, { now });
  new Intl.DateTimeFormat("en-US", { timeZone }).format(now());
  function authorized(principalId: string, itemId: string) {
    const principal = resolvePrincipal(db, principalId);
    if (!principal || !isUsablePrincipal(principal, now())) throw new Error("Action principal is no longer usable");
    const row = db.query("SELECT data_json FROM inbox_items WHERE id = ? AND deleted_at IS NULL").get(itemId) as { data_json: string } | null;
    const item = store.getItem(itemId), thread = item ? store.getThread(item.threadId) : null;
    if (!row || !item || item.queue !== "actions" || item.type === "fyi" || !thread || thread.status !== "open")
      throw new Error("Action is not resolvable");
    return { action: item, raw: JSON.parse(row.data_json) as InboxActionItem, thread,
      allowed: deps.allowedOperations(principalId, thread) };
  }
  function snooze(action: InboxActionItem, thread: InboxThread, expectedVersion?: number) {
    if (expectedVersion !== undefined && action.version !== expectedVersion) throw new Error("Inbox version conflict");
    if (!["pending", "snoozed"].includes(action.status) || action.expiresAt <= now()) throw new Error("Action is not resolvable");
    if (action.status === "snoozed") return { replay: true, followUpId: undefined };
    const waitUntil = inboxSnoozeUntil(now(), thread.stakes, action.version, timeZone);
    store.commit([{ kind: "transition", itemId: action.id, expectedVersion: action.version, to: "snoozed", waitUntil,
      expiresAt: Math.max(action.expiresAt, waitUntil + DAY) }]);
    const blocks = db.query("SELECT id FROM inbox_items WHERE deleted_at IS NULL AND status = 'blocked' AND blocked_by_item_id = ? AND expires_at < ?")
      .all(action.id, waitUntil + DAY) as { id: string }[];
    for (const { id } of blocks) store.commit([{ kind: "retain_block", itemId: id, expectedVersion: store.getItem(id)!.version, expiresAt: waitUntil + DAY }]);
    return { replay: false, followUpId: undefined };
  }
  function inspect(principalId: string, msg: ClientInboxResolve) {
    clientInboxResolveSchema.parse(msg);
    const { action, raw, thread, allowed } = authorized(principalId, msg.itemId);
    const option = inboxOptionSchema.parse(raw.options.find(option => option.id === msg.optionId));
    const checked = validateResolutionEffect(option.effect, allowed, { hygiene: !!action.hygiene && !!deps.applyHygiene });
    if (!checked.ok) throw new Error(checked.error);
    const context = db.query("SELECT options_json, source_item_id FROM inbox_action_contexts WHERE item_id = ?")
      .get(action.id) as { options_json: string; source_item_id: string | null } | null;
    const revision = action.hygiene ? db.query("SELECT options_json FROM hygiene_action_revisions WHERE item_id = ? ORDER BY version DESC LIMIT 1").get(action.id) as { options_json: string } | null : null;
    if ((action.hygiene && !context) || (context && (revision ?? context).options_json !== JSON.stringify(raw.options))) throw new Error("Stored Action options changed");
    const effect = checked.message;
    if (msg.reason !== undefined && effect.kind !== "dismiss" && !(effect.kind === "hygiene" && effect.operation === "dismiss")) throw new Error("Feedback belongs to dismissal");
    if (msg.input !== undefined && (effect.kind !== "hygiene" || effect.operation !== "resolve" || JSON.stringify(msg.input) !== JSON.stringify(effect.input)))
      throw new Error("Input does not match the confirmed preview");
    return { action, thread, option, context, effect };
  }
  return {
    inspect,
    async resolveAsync(principalId: string, request: ClientInboxResolve, expectedVersion?: number) {
      const msg = clientInboxResolveSchema.parse(request), { effect } = inspect(principalId, msg);
      if (effect.kind !== "hygiene") return this.resolve(principalId, msg, expectedVersion);
      if (!deps.applyHygiene) throw new Error("Hygiene resolution is unavailable");
      return deps.applyHygiene(principalId, msg);
    },
    resolve(principalId: string, request: ClientInboxResolve, expectedVersion?: number): { replay: boolean; followUpId: string | undefined } {
      const msg = clientInboxResolveSchema.parse(request);
      return db.transaction(() => {
        const { action, thread, option, context, effect } = inspect(principalId, msg);
        if (effect.kind === "hygiene") throw new Error("Hygiene requires asynchronous resolution");
        if (effect.kind === "snooze") return snooze(action, thread, expectedVersion);
        const prior = db.query("SELECT option_id, effect_json, reason FROM inbox_resolutions WHERE item_id = ?").get(action.id) as {
          option_id: string; effect_json: string; reason: string | null;
        } | null;
        const reason = msg.reason ?? (effect.kind === "dismiss" ? effect.reason : undefined);
        const followUpId = effect.kind === "enqueue" ? inboxIdentity("follow-up", action.id, option.id) : undefined;
        if (prior) {
          if (prior.option_id !== option.id || prior.effect_json !== JSON.stringify(effect) || prior.reason !== (reason ?? null))
            throw new Error("Action was already resolved differently");
          return { replay: true, followUpId };
        }
        if (expectedVersion !== undefined && action.version !== expectedVersion) throw new Error("Inbox version conflict");
        if (!["pending", "snoozed"].includes(action.status) || action.expiresAt <= now()) throw new Error("Action is not resolvable");
        store.commit([{ kind: "resolution", id: inboxIdentity("resolution", action.id), itemId: action.id, optionId: option.id, principalId, reason }]);
        const blocks = db.query("SELECT id FROM inbox_items WHERE deleted_at IS NULL AND status = 'blocked' AND blocked_by_item_id = ?")
          .all(action.id) as { id: string }[];
        for (const { id } of blocks) store.commit([{ kind: "transition", itemId: id, expectedVersion: store.getItem(id)!.version, to: "superseded" }]);
        const source = context?.source_item_id ? store.getItem(context.source_item_id) : null;
        if (source?.queue === "queue" && source.status === "failed")
          store.commit([{ kind: "transition", itemId: source.id, expectedVersion: source.version, to: "dropped" }]);
        store.commit([{ kind: "transition", itemId: action.id, expectedVersion: action.version, to: effect.kind === "dismiss" ? "dismissed" : "resolved" }]);
        if (effect.kind === "enqueue") store.commit([{ kind: "item", item: {
          id: followUpId!, dedupKey: followUpId!, threadId: action.threadId, queue: "queue", type: "execute", status: "ready",
          version: 1, attempts: 0, maxAttempts: 3, createdAt: now(), updatedAt: now(), expiresAt: action.expiresAt, payload: effect.payload,
        } }]);
        enqueueInboxCleanup(db, action.threadId, now());
        return { replay: false, followUpId };
      }).immediate();
    },
    snooze(principalId: string, itemId: string, expectedVersion?: number) {
      return db.transaction(() => {
        const { action, thread } = authorized(principalId, itemId);
        if (action.hygiene) throw new Error("Use the stored hygiene Later option");
        return snooze(action, thread, expectedVersion);
      }).immediate();
    },
  };
}

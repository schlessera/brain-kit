/** Human-started deterministic review. No backend, model, timer or second queue.
 * SQLite journals dispatch before CLI I/O; interrupted repairs are checked,
 * never reapplied. All Action projections use the shared store/change stream. */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { ClientInboxResolve, HygieneAction, HygieneEffect, HygieneInput, HygieneReviewRead, HygieneReviewState, InboxActionItem, InboxOption } from "@schlessera/brain-ui-sdk/protocol";
import { hygieneDiffSchema, hygieneEffectSchema, hygieneOutcomeSchema, hygieneReviewStateSchema } from "@schlessera/brain-ui-sdk/schemas";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { createInboxAction, insertInboxAction, inboxIdentity } from "./actions.js";
import { createInboxResolver, inboxSnoozeUntil } from "./resolve.js";
import { createInboxStore } from "./store.js";

const id = z.string().min(1).max(256), text = z.string();
const handlerSchema = z.object({ name: id, kind: z.enum(["choice", "field", "manual", "blocker"]), input: z.object({ type: z.enum(["none", "string", "enum", "date", "strings", "path"]), values: z.array(text).optional(), example: text.optional() }), effect: text, explanation: text });
export const findingSchema = z.looseObject({ id, fingerprint: id, path: text, title: text, handlers: z.array(handlerSchema).min(1) });
const countsSchema = hygieneReviewStateSchema.shape.counts.unwrap();
export const nextSchema = z.union([z.object({ blocker: z.record(z.string(), z.unknown()) }), z.object({ finding: findingSchema.nullable(), counts: countsSchema })]);
export const resultSchema = z.looseObject({ status: z.enum(["preview", "fixed", "stale", "refused", "check_failed", "undone", "still_detected", "not_detected", "dismissed", "snoozed"]), id: text, reason: text.nullable().optional(), code: text.optional(), fieldError: z.object({ field: text, message: text }).optional(), diff: hygieneDiffSchema.optional(), previewToken: id.optional(), undoToken: z.string().regex(/^[0-9a-f]{32}$/).optional() });
export type Result = z.infer<typeof resultSchema>;
export interface Attempt { id: string; item_id: string; principal_id: string; request_json: string; effect_json: string; wait_until: number | null }
export class HygieneAuthorityError extends Error {}

import { procedureCaller, type WriteProcedures, type WireError } from "../db/write-worker.js";
import { inboxWriter } from "./write-runtime.js";

export const url = import.meta.url;
export function setup(db: Database, { timeZone }: { timeZone?: string }): WriteProcedures {
  let at = 0;
  const now = () => at, store = createInboxStore(db, { now });
  const resolver = createInboxResolver(db, { now, timeZone, allowedOperations: () => [], applyHygiene: async () => { throw new Error("Effects run on the host"); } });
  function authority(principalId: string) {
    const p = resolvePrincipal(db, principalId);
    if (!p || !isUsablePrincipal(p, now()) || !["owner", "ambient"].includes(p.kind)) throw new HygieneAuthorityError("Human review authority is required");
  }
  function state(): HygieneReviewState {
    const row = db.query("SELECT data_json FROM hygiene_review WHERE singleton = 1").get() as { data_json: string } | null;
    return row ? hygieneReviewStateSchema.parse(JSON.parse(row.data_json)) : { version: 1, status: "idle", position: 0, fixed: 0, dismissed: 0, snoozed: 0 };
  }
  function save(review: HygieneReviewState) {
    db.query("INSERT INTO hygiene_review (singleton, data_json) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET data_json = excluded.data_json").run(JSON.stringify(hygieneReviewStateSchema.parse(review)));
  }
  function action(itemId: string): InboxActionItem {
    const item = store.getItem(itemId);
    if (!item || item.queue !== "actions" || !item.hygiene) throw new Error("Not a hygiene Action");
    return item;
  }
  function read(): HygieneReviewRead {
    return db.transaction(() => {
      const review = state();
      return { review, action: review.pendingActionId ? action(review.pendingActionId) : null };
    })();
  }
  function update(item: InboxActionItem, outcome: HygieneAction["outcome"], options = item.options) {
    store.commit([{ kind: "hygiene_update", itemId: item.id, expectedVersion: item.version, hygiene: { ...item.hygiene!, outcome }, options }]);
  }
  function busy(itemId: string) { return db.query("SELECT 1 FROM hygiene_effect_attempts WHERE item_id = ? AND status = 'started'").get(itemId) !== null; }
  function outcome(result: Result): NonNullable<HygieneAction["outcome"]> {
    const { status, reason, code, undoToken, fieldError } = result;
    if (status === "preview") throw new Error("Preview is not an outcome");
    return hygieneOutcomeSchema.parse({ version: 1, status, reason: reason ?? undefined, code, undoToken, fieldError });
  }
  const missingPreview = (options: InboxOption[]) => options.some(o => o.effect.kind === "hygiene" && o.effect.operation === "resolve" && o.input?.type === "none" && !o.preview);
  return {
    refresh(time: number, principalId: string, old: InboxActionItem, next: z.infer<typeof nextSchema>, finding: z.infer<typeof findingSchema> | null, options: InboxOption[], verified: z.infer<typeof nextSchema>) {
      at = time;
      authority(principalId);
      return db.transaction(() => {
        const review = state(), current = action(old.id);
        if (review.pendingActionId !== old.id || current.status !== "pending" || current.version !== old.version || busy(old.id))
          throw new Error("Inbox version conflict");
        if ("blocker" in next || "blocker" in verified) {
          update(current, { version: 1, status: "refused", reason: "refresh-checks-unavailable" });
          return read();
        }
        if (!finding || !verified.finding || finding.id !== old.hygiene!.findingId || verified.finding.id !== finding.id || verified.finding.fingerprint !== finding.fingerprint || missingPreview(options)) {
          update(current, { version: 1, status: "stale", reason: finding ? "refresh-premise-changed" : "finding-not-detected" });
          return read();
        }
        // Chain identity supports A -> B -> A without ever reviving a terminal card.
        const itemId = inboxIdentity("hygiene-refresh", old.id, finding.fingerprint);
        const threadId = inboxIdentity("hygiene-refresh-thread", itemId);
        update(current, { version: 1, status: "superseded", supersededBy: itemId });
        store.commit([{ kind: "transition", itemId: old.id, expectedVersion: action(old.id).version, to: "dropped" }]);
        store.openReviewThread(threadId);
        const item: InboxActionItem = { id: itemId, dedupKey: itemId, threadId, queue: "actions", type: "choose", status: "pending", version: 1, createdAt: now(), updatedAt: now(), expiresAt: Number.MAX_SAFE_INTEGER,
          payload: { title: finding.title, detail: finding.path }, options, hygiene: { findingId: finding.id, fingerprint: finding.fingerprint, finding } };
        // One pending decision replaces one: normal validation, without running cap retirement.
        insertInboxAction(db, item, [], undefined, now(), true);
        save({ ...review, pendingActionId: itemId, counts: next.counts });
        return read();
      }).immediate();
    },
    select(time: number, principalId: string | undefined, resumeRetired: boolean, paused: HygieneReviewState["pauseReason"], next: z.infer<typeof nextSchema>, finding: z.infer<typeof findingSchema> | null, options: InboxOption[]) {
      at = time;
      if (principalId) authority(principalId);
      return db.transaction(() => {
        const review = state();
        if (review.pendingActionId || (review.status !== "active" && !(resumeRetired && paused && ["paused", "blocked"].includes(review.status)))) return;
        if (review.pauseReason && (!resumeRetired || !principalId || review.pauseReason.retiredActionId !== paused?.retiredActionId)) return;
        if ("blocker" in next) { save({ ...review, status: "blocked", blocker: next.blocker }); return; }
        if (!finding) { save({ ...review, status: "complete", pauseReason: undefined, counts: next.counts }); return; }
        const readmitting = paused && action(paused.retiredActionId).hygiene!.findingId === finding.id && action(paused.retiredActionId).hygiene!.fingerprint === finding.fingerprint;
        const itemId = readmitting ? inboxIdentity("hygiene-readmission", paused.retiredActionId) : inboxIdentity("hygiene", finding.id, finding.fingerprint);
        const existing = store.orderedItems().map(v => v.item).find(i => i.queue === "actions" && i.hygiene?.findingId === finding.id && i.hygiene.fingerprint === finding.fingerprint && ["pending", "snoozed"].includes(i.status)) ?? store.getItem(itemId);
        if (existing) {
          if (existing.queue === "actions" && ["pending", "snoozed"].includes(existing.status)) {
            if (existing.status === "snoozed") store.commit([{ kind: "transition", itemId: existing.id, expectedVersion: existing.version, to: "pending", waitUntil: null }]);
            save({ ...review, status: "active", pauseReason: undefined, pendingActionId: existing.id, position: review.position + 1, counts: next.counts });
            return;
          }
          throw new Error("Finding already has a terminal Action for this fingerprint");
        }
        const threadId = readmitting ? inboxIdentity("hygiene-readmission-thread", itemId) : inboxIdentity("hygiene-thread", finding.id, finding.fingerprint);
        store.openReviewThread(threadId);
        const item: InboxActionItem = { id: itemId, dedupKey: itemId, threadId, queue: "actions", type: "choose", status: "pending", version: 1, createdAt: now(), updatedAt: now(), expiresAt: Number.MAX_SAFE_INTEGER,
          payload: { title: finding.title, detail: finding.path }, options, hygiene: { findingId: finding.id, fingerprint: finding.fingerprint, finding } };
        // Publish the pointer first, in this same transaction, so admission's cap
        // can pause even when the incoming card itself immediately loses.
        save({ ...review, status: "active", pauseReason: undefined, pendingActionId: itemId, position: review.position + 1, counts: next.counts });
        if (!createInboxAction(db, item, [], { now: now(), hygiene: true })) throw new Error("Hygiene Action suppressed");
      }).immediate();
    },
    command(time: number, principalId: string, operation: "start" | "pause" | "resume") {
      at = time;
      authority(principalId);
      return db.transaction(() => {
        const review = state();
        if (operation === "pause") save({ ...review, status: "paused" });
        else save({ ...review, status: review.pauseReason ? "paused" : "active", blocker: undefined });
      }).immediate();
    },
    preview(time: number, principalId: string, item: InboxActionItem, request: { itemId: string; optionId: string; expectedVersion: number; input: HygieneInput }, option: InboxOption, selected: HygieneEffect, result: Result) {
      at = time;
      authority(principalId);
      return db.transaction(() => {
        if (busy(item.id)) throw new Error("Effect in progress");
        const current = action(item.id);
        if (current.version !== request.expectedVersion) throw new Error("Inbox version conflict");
        if (result.status === "preview" && result.diff && result.previewToken) {
          const options = current.options.map(o => o.id === option.id ? { ...o, effect: { ...selected, input: request.input, previewToken: result.previewToken }, preview: result.diff } : o);
          update(current, undefined, options);
        } else update(current, outcome(result));
      }).immediate();
    },
    finish(time: number, attempt: Attempt, result: Result, options: InboxOption[]) {
      at = time;
      const e = hygieneEffectSchema.parse(JSON.parse(attempt.effect_json));
      const request = JSON.parse(attempt.request_json) as ClientInboxResolve;
      return db.transaction(() => {
        if (!db.query("SELECT 1 FROM hygiene_effect_attempts WHERE id = ? AND status = 'started'").get(attempt.id)) return;
        const item = action(attempt.item_id);
        if (item.status === "dropped") {
          // Cap retirement does not revoke an already confirmed CLI operation.
          // Retain its actual receipt without resurrecting the terminal card,
          // adding a review disposition or admitting another finding.
          db.query("UPDATE hygiene_effect_attempts SET status = 'finished', result_json = ? WHERE id = ?").run(JSON.stringify(result), attempt.id);
          return;
        }
        update(item, outcome(result), options);
        const current = action(item.id);
        const confirmed = (e.operation === "resolve" && result.status === "fixed") || (e.operation === "check" && result.status === "not_detected") || (e.operation === "dismiss" && result.status === "dismissed") || (e.operation === "snooze" && result.status === "snoozed");
        if (confirmed) {
          // Snooze is deliberately nonterminal, as in the shared lifecycle.
          if (e.operation !== "snooze") store.commit([{ kind: "resolution", id: inboxIdentity("resolution", item.id), itemId: item.id, optionId: request.optionId, principalId: attempt.principal_id, reason: request.reason }]);
          store.commit([{ kind: "transition", itemId: item.id, expectedVersion: current.version, to: e.operation === "dismiss" ? "dismissed" : e.operation === "snooze" ? "snoozed" : "resolved", ...(attempt.wait_until !== null ? { waitUntil: attempt.wait_until } : {}) }]);
          const review = state();
          if (review.pendingActionId === item.id) save({ ...review, pendingActionId: undefined, fixed: review.fixed + (e.operation === "resolve" || e.operation === "check" ? 1 : 0), dismissed: review.dismissed + (e.operation === "dismiss" ? 1 : 0), snoozed: review.snoozed + (e.operation === "snooze" ? 1 : 0) });
        }
        if (result.status === "undone") {
          // An inverse restores the defect. Require a new preview before another write.
          const fresh = action(item.id);
          update(fresh, outcome(result), fresh.options.filter(o => o.id !== "undo").map(o => o.effect.kind === "hygiene" && o.effect.operation === "resolve" ? { ...o, preview: undefined, effect: { ...o.effect, previewToken: undefined } } : o));
        }
        db.query("UPDATE hygiene_effect_attempts SET status = 'finished', result_json = ? WHERE id = ?").run(JSON.stringify(result), attempt.id);
      }).immediate();
    },
    admit(time: number, principalId: string, request: ClientInboxResolve) {
      at = time;
      return db.transaction(() => {
        authority(principalId);
        const { action: item, option, effect: e, thread } = resolver.inspect(principalId, request);
        if (e.kind !== "hygiene" || !item.hygiene || e.findingId !== item.hygiene.findingId || e.fingerprint !== item.hygiene.fingerprint) throw new Error("Effect does not name this finding");
        const prior = db.query("SELECT request_json FROM hygiene_effect_attempts WHERE item_id = ? ORDER BY rowid DESC LIMIT 1").get(item.id) as { request_json: string } | null;
        if (["resolved", "dismissed", "snoozed"].includes(item.status)) {
          if (prior?.request_json !== JSON.stringify(request)) throw new Error("Action was already resolved differently");
          return null;
        }
        if (busy(item.id)) return null;
        if (item.status !== "pending" || item.expiresAt <= now()) throw new Error("Action is not resolvable");
        if (e.operation === "resolve" && (!e.handler || e.input === undefined || !e.previewToken || !option.preview)) throw new Error("Confirm a valid preview first");
        if (e.operation === "undo" && (!e.undoToken || !option.preview || item.hygiene.outcome?.status !== "check_failed")) throw new Error("No confirmed inverse available");
        const waitUntil = e.operation === "snooze" ? inboxSnoozeUntil(now(), thread.stakes, item.version, timeZone) : null;
        const attempt: Attempt = { id: inboxIdentity("hygiene-attempt", item.id, String(item.version), option.id), item_id: item.id, principal_id: principalId, request_json: JSON.stringify(request), effect_json: JSON.stringify(e), wait_until: waitUntil };
        db.query("INSERT INTO hygiene_effect_attempts (id, item_id, principal_id, request_json, effect_json, wait_until, status) VALUES (?, ?, ?, ?, ?, ?, 'started')").run(attempt.id, item.id, principalId, attempt.request_json, attempt.effect_json, waitUntil);
        update(item, { version: 1, status: "applying" });
        return attempt;
      }).immediate();
    },
    unknown(time: number, itemId: string) {
      at = time;
      db.transaction(() => { const item = action(itemId); if (item.status !== "dropped") update(item, { version: 1, status: "check_failed", code: "receipt-unknown" }); }).immediate();
    },
  };
}
export function hygieneWrites(db: Database, timeZone?: string) {
  return procedureCaller(db, { url, setup }, { timeZone }, inboxWriter(db), (error: WireError) => error.name === "HygieneAuthorityError" ? new HygieneAuthorityError(error.message) : undefined);
}

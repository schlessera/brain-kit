/** Human-started deterministic review. No backend, model, timer or second queue.
 * SQLite journals dispatch before CLI I/O; interrupted repairs are checked,
 * never reapplied. All Action projections use the shared store/change stream. */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { ClientInboxResolve, HygieneAction, HygieneEffect, HygieneInput, HygieneReviewRead, HygieneReviewState, InboxActionItem, InboxOption } from "@schlessera/brain-ui-sdk/protocol";
import { hygieneDiffSchema, hygieneEffectSchema, hygieneInputSchema, hygieneOutcomeSchema, hygieneReviewStateSchema, inboxOptionSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { BrainClient } from "../brain/client.js";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { createInboxAction, insertInboxAction, inboxIdentity } from "./actions.js";
import { createInboxResolver, inboxSnoozeUntil } from "./resolve.js";
import { createInboxStore } from "./store.js";

const id = z.string().min(1).max(256), text = z.string();
const handlerSchema = z.object({ name: id, kind: z.enum(["choice", "field", "manual", "blocker"]), input: z.object({ type: z.enum(["none", "string", "enum", "date", "strings", "path"]), values: z.array(text).optional(), example: text.optional() }), effect: text, explanation: text });
const findingSchema = z.looseObject({ id, fingerprint: id, path: text, title: text, handlers: z.array(handlerSchema).min(1) });
const countsSchema = hygieneReviewStateSchema.shape.counts.unwrap();
const nextSchema = z.union([z.object({ blocker: z.record(z.string(), z.unknown()) }), z.object({ finding: findingSchema.nullable(), counts: countsSchema })]);
const resultSchema = z.looseObject({ status: z.enum(["preview", "fixed", "stale", "refused", "check_failed", "undone", "still_detected", "not_detected", "dismissed", "snoozed"]), id: text, reason: text.nullable().optional(), code: text.optional(), fieldError: z.object({ field: text, message: text }).optional(), diff: hygieneDiffSchema.optional(), previewToken: id.optional(), undoToken: z.string().regex(/^[0-9a-f]{32}$/).optional() });
type Result = z.infer<typeof resultSchema>;
interface Attempt { id: string; item_id: string; principal_id: string; request_json: string; effect_json: string; wait_until: number | null }
export class HygieneAuthorityError extends Error {}

export function createHygieneReview(db: Database, deps: { brain: BrainClient; now?: () => number; timeZone?: string }) {
  const now = deps.now ?? Date.now, store = createInboxStore(db, { now });
  const resolver = createInboxResolver(db, { now, timeZone: deps.timeZone, allowedOperations: () => [], applyHygiene: apply });
  let preparing: Promise<void> | null = null;
  let pauseGeneration = 0;
  const inFlight = new Set<string>();
  function authority(principalId: string) {
    const p = resolvePrincipal(db, principalId);
    if (!p || !isUsablePrincipal(p, now()) || !["owner", "ambient"].includes(p.kind)) throw new HygieneAuthorityError("Human review authority is required");
  }
  async function cli(args: string[]) {
    if (!deps.brain.hygiene) throw new Error("Hygiene CLI is unavailable");
    return deps.brain.hygiene(args);
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
  function effect(f: { id: string; fingerprint: string }, operation: HygieneEffect["operation"]): HygieneEffect {
    return { kind: "hygiene", operation, findingId: f.id, fingerprint: f.fingerprint };
  }
  async function prepareOptions(finding: z.infer<typeof findingSchema> | null) {
    const options: InboxOption[] = [];
    if (finding) {
      for (const h of finding.handlers) {
        if (["manual", "blocker"].includes(h.kind)) continue;
        const option: InboxOption = { id: h.name, label: h.effect, input: h.input, effect: { ...effect(finding, "resolve"), handler: h.name } };
        if (h.input.type === "none") {
          const preview = resultSchema.parse(await cli(["resolve", "--handler", h.name, "--input", "null", "--expect-fingerprint", finding.fingerprint, "--dry-run", "--", finding.id]));
          if (preview.status === "preview" && preview.diff && preview.previewToken) {
            option.effect = { ...option.effect as HygieneEffect, input: null, previewToken: preview.previewToken };
            option.preview = preview.diff;
          }
        }
        options.push(inboxOptionSchema.parse(option));
      }
      options.push({ id: "check", label: "Done, check again", effect: effect(finding, "check") },
        { id: "later", label: "Later", effect: effect(finding, "snooze") },
        { id: "dismiss", label: "Dismiss", effect: effect(finding, "dismiss") });
    }
    return options;
  }
  async function refresh(principalId: string) {
    const initial = read(), old = initial.action;
    // A retired/capped review has no pending card. Only Start/Resume can admit one.
    if (!old || old.status !== "pending") return initial;
    if (busy(old.id)) throw new Error("Effect in progress");
    const args = ["next", "--finding", old.hygiene!.findingId, "--dry-run"];
    const next = nextSchema.parse(await cli(args));
    authority(principalId);
    const finding = "finding" in next ? next.finding : null;
    if (finding?.fingerprint === old.hygiene!.fingerprint) return read();
    const options = await prepareOptions(finding);
    // Re-read after all previews: an intervening edit must not install a stale card.
    const verified = finding ? nextSchema.parse(await cli(args)) : next;
    authority(principalId);
    return db.transaction(() => {
      const review = state(), current = action(old.id);
      if (review.pendingActionId !== old.id || current.status !== "pending" || current.version !== old.version || busy(old.id))
        throw new Error("Inbox version conflict");
      if ("blocker" in next || "blocker" in verified) {
        update(current, { version: 1, status: "refused", reason: "refresh-checks-unavailable" });
        return read();
      }
      const missingPreview = options.some(o => o.effect.kind === "hygiene" && o.effect.operation === "resolve" && o.input?.type === "none" && !o.preview);
      if (!finding || !verified.finding || finding.id !== old.hygiene!.findingId || verified.finding.id !== finding.id || verified.finding.fingerprint !== finding.fingerprint || missingPreview) {
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
  }
  async function select(principalId?: string, resumeRetired = false) {
    const generation = pauseGeneration;
    const paused = state().pauseReason;
    // Recovery/next-item selection cannot authorize re-admission after retirement.
    if (paused && (!principalId || !resumeRetired)) return;
    // CLI selection/reconciliation and previews are outside write transactions.
    const next = nextSchema.parse(await cli(["next"]));
    if (principalId) authority(principalId);
    let finding = "finding" in next ? next.finding : null;
    if (paused && !("blocker" in next)) {
      const retired = action(paused.retiredActionId);
      if (finding?.id !== retired.hygiene!.findingId || finding.fingerprint !== retired.hygiene!.fingerprint) {
        const listed = z.object({ entries: z.array(z.looseObject({ id, state: text, fingerprint: text.nullable() })) }).parse(await cli(["list"]));
        if (listed.entries.some(e => e.id === retired.hygiene!.findingId && e.state === "open" && e.fingerprint === retired.hygiene!.fingerprint))
          finding = findingSchema.parse(retired.hygiene!.finding);
      }
    }
    const options = await prepareOptions(finding);
    if (principalId) authority(principalId);
    db.transaction(() => {
      const review = state();
      if (generation !== pauseGeneration) return;
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
  }
  async function ensureNext(principalId?: string, resumeRetired = false) {
    if (!preparing) preparing = select(principalId, resumeRetired).finally(() => { preparing = null; });
    await preparing;
  }
  async function command(principalId: string, operation: "start" | "pause" | "resume" | "refresh") {
    authority(principalId);
    if (operation === "refresh") return refresh(principalId);
    if (operation === "pause") pauseGeneration++;
    db.transaction(() => {
      const review = state();
      if (operation === "pause") save({ ...review, status: "paused" });
      else save({ ...review, status: review.pauseReason ? "paused" : "active", blocker: undefined });
    }).immediate();
    if (operation !== "pause" && !state().pendingActionId) await ensureNext(principalId, !!state().pauseReason);
    return read();
  }
  async function preview(principalId: string, request: { itemId: string; optionId: string; expectedVersion: number; input: HygieneInput }) {
    authority(principalId); hygieneInputSchema.parse(request.input);
    const item = action(request.itemId), { option, effect: selected } = resolver.inspect(principalId, { type: "inbox_resolve", itemId: item.id, optionId: request.optionId });
    if (item.version !== request.expectedVersion || item.status !== "pending" || busy(item.id)) throw new Error("Inbox version conflict");
    if (selected.kind !== "hygiene" || selected.operation !== "resolve" || !selected.handler) throw new Error("Not a repair option");
    const result = resultSchema.parse(await cli(["resolve", "--handler", selected.handler, "--input", JSON.stringify(request.input), "--expect-fingerprint", selected.fingerprint, "--dry-run", "--", selected.findingId]));
    authority(principalId);
    db.transaction(() => {
      if (busy(item.id)) throw new Error("Effect in progress");
      const current = action(item.id);
      if (current.version !== request.expectedVersion) throw new Error("Inbox version conflict");
      if (result.status === "preview" && result.diff && result.previewToken) {
        const options = current.options.map(o => o.id === option.id ? { ...o, effect: { ...selected, input: request.input, previewToken: result.previewToken }, preview: result.diff } : o);
        update(current, undefined, options);
      } else update(current, outcome(result));
    }).immediate();
    return action(item.id);
  }
  function outcome(result: Result): NonNullable<HygieneAction["outcome"]> {
    const { status, reason, code, undoToken, fieldError } = result;
    if (status === "preview") throw new Error("Preview is not an outcome");
    return hygieneOutcomeSchema.parse({ version: 1, status, reason: reason ?? undefined, code, undoToken, fieldError });
  }
  async function dispatch(e: HygieneEffect, request: ClientInboxResolve, waitUntil: number | null): Promise<Result> {
    const args = e.operation === "resolve" ? ["resolve", "--handler", e.handler!, "--input", JSON.stringify(e.input), "--expect-fingerprint", e.fingerprint, "--expect-preview", e.previewToken!, "--", e.findingId]
      : e.operation === "undo" ? ["undo", "--", e.undoToken!]
      : e.operation === "check" ? ["check", "--", e.findingId]
      : [e.operation, "--expect-fingerprint", e.fingerprint, ...(waitUntil !== null ? ["--until", new Date(waitUntil).toISOString()] : []), ...(request.reason ? ["--reason", request.reason] : []), "--", e.findingId];
    return resultSchema.parse(await cli(args));
  }
  async function finish(attempt: Attempt, result: Result, recovering = false) {
    const e = hygieneEffectSchema.parse(JSON.parse(attempt.effect_json));
    const request = JSON.parse(attempt.request_json) as ClientInboxResolve;
    let options = action(attempt.item_id).options;
    if (result.status === "check_failed" && result.undoToken) {
      const inverse = resultSchema.parse(await cli(["undo", "--dry-run", "--", result.undoToken]));
      if (inverse.status === "preview" && inverse.diff) options = [...options.filter(o => o.id !== "undo"), { id: "undo", label: "Undo change", effect: { ...e, operation: "undo", handler: undefined, input: undefined, previewToken: undefined, undoToken: result.undoToken }, preview: inverse.diff }];
    }
    db.transaction(() => {
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
    if (state().status === "active" && !state().pendingActionId) await ensureNext(recovering ? undefined : attempt.principal_id);
  }
  async function apply(principalId: string, request: ClientInboxResolve) {
    authority(principalId);
    const selected = resolver.inspect(principalId, request).effect;
    if (busy(request.itemId) && !inFlight.has(request.itemId) && selected.kind === "hygiene" && selected.operation === "check") {
      await recover(request.itemId);
      return { replay: false, followUpId: undefined };
    }
    const admitted = db.transaction(() => {
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
      const waitUntil = e.operation === "snooze" ? inboxSnoozeUntil(now(), thread.stakes, item.version, deps.timeZone) : null;
      const attempt: Attempt = { id: inboxIdentity("hygiene-attempt", item.id, String(item.version), option.id), item_id: item.id, principal_id: principalId, request_json: JSON.stringify(request), effect_json: JSON.stringify(e), wait_until: waitUntil };
      db.query("INSERT INTO hygiene_effect_attempts (id, item_id, principal_id, request_json, effect_json, wait_until, status) VALUES (?, ?, ?, ?, ?, ?, 'started')").run(attempt.id, item.id, principalId, attempt.request_json, attempt.effect_json, waitUntil);
      update(item, { version: 1, status: "applying" });
      return attempt;
    }).immediate();
    if (!admitted) return { replay: true, followUpId: undefined };
    inFlight.add(request.itemId);
    let result: Result;
    try { authority(principalId); result = await dispatch(hygieneEffectSchema.parse(JSON.parse(admitted.effect_json)), request, admitted.wait_until); }
    catch {
      // Unknown dispatch receipt stays journaled. Recovery checks; it never retries.
      const item = action(request.itemId);
      if (item.status !== "dropped") update(item, { version: 1, status: "check_failed", code: "receipt-unknown" });
      inFlight.delete(request.itemId);
      return { replay: false, followUpId: undefined };
    }
    try { await finish(admitted, result); } finally { inFlight.delete(request.itemId); }
    return { replay: false, followUpId: undefined };
  }
  async function recover(itemId?: string) {
    const attempts = db.query("SELECT * FROM hygiene_effect_attempts WHERE status = 'started' ORDER BY rowid").all() as Attempt[];
    for (const attempt of attempts) {
      if ((itemId && attempt.item_id !== itemId) || inFlight.has(attempt.item_id)) continue;
      const e = hygieneEffectSchema.parse(JSON.parse(attempt.effect_json));
      let result: Result;
      if (e.operation === "resolve" || e.operation === "check") {
        const listed = z.object({ entries: z.array(z.looseObject({ id, fingerprint: text.nullable() })) }).parse(await cli(["list"]));
        const entry = listed.entries.find(v => v.id === e.findingId);
        if (!entry || entry.fingerprint !== e.fingerprint) {
          await finish(attempt, { id: e.findingId, status: "stale", reason: "recovery-fingerprint-changed" }, true);
          continue;
        }
        result = resultSchema.parse(await cli(["check", "--", e.findingId]));
        if (e.operation === "resolve" && result.status === "not_detected") result = { ...result, status: "fixed" };
      } else if (e.operation === "dismiss" || e.operation === "snooze") {
        const listed = z.object({ entries: z.array(z.looseObject({ id, state: text, fingerprint: text.nullable(), dueAt: text.nullable() })) }).parse(await cli(["list"]));
        const entry = listed.entries.find(v => v.id === e.findingId);
        const matches = entry?.fingerprint === e.fingerprint && entry.state === (e.operation === "dismiss" ? "dismissed" : "snoozed") && (e.operation !== "snooze" || Date.parse(entry.dueAt ?? "") === attempt.wait_until);
        result = { id: e.findingId, status: matches ? e.operation === "dismiss" ? "dismissed" : "snoozed" : "check_failed", code: matches ? undefined : "receipt-unknown" };
      } else result = { id: e.findingId, status: "check_failed", code: "undo-receipt-unknown" };
      await finish(attempt, result, true);
    }
    if (state().status === "active" && !state().pendingActionId) await ensureNext();
  }
  return { read, command, preview, resolver, recover };
}
export type HygieneReview = ReturnType<typeof createHygieneReview>;

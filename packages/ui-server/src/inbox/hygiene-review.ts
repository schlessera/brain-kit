/** Human-started deterministic review. No backend, model, timer or second queue.
 * SQLite journals dispatch before CLI I/O; interrupted repairs are checked,
 * never reapplied. All Action projections use the shared store/change stream. */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { ClientInboxResolve, HygieneAction, HygieneEffect, HygieneInput, HygieneReviewRead, HygieneReviewState, HygieneWorktreeDetailsRead, InboxActionItem, InboxItem, InboxOption } from "@schlessera/brain-ui-sdk/protocol";
import { hygieneEffectSchema, hygieneInputSchema, hygieneReviewStateSchema, inboxOptionSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { BrainClient } from "../brain/client.js";
import type { ReferenceWorktreeHygiene } from "../brain/reference-worktree-hygiene.js";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { createInboxResolver } from "./resolve.js";
import { createInboxStore } from "./store.js";

import { findingSchema, nextSchema, resultSchema, hygieneWrites, HygieneAuthorityError, type Result, type Attempt } from "./hygiene-writes.js";
export { HygieneAuthorityError } from "./hygiene-writes.js";

const id = z.string().min(1).max(256), text = z.string();

export function createHygieneReview(db: Database, deps: { brain: BrainClient; now?: () => number; timeZone?: string;
  /** Host-only managed worktree findings (#2431), joined into the same review queue. */
  worktrees?: ReferenceWorktreeHygiene;
  /** The gated dispatcher's current exact-operation envelope (#689); default empty. */
  allowedOperations?: Parameters<typeof createInboxResolver>[1]["allowedOperations"] }) {
  const now = deps.now ?? Date.now, store = createInboxStore(db, { now });
  const write = hygieneWrites(db, deps.timeZone);
  const resolver = createInboxResolver(db, { now, timeZone: deps.timeZone, allowedOperations: deps.allowedOperations ?? (() => []), applyHygiene: apply });
  let preparing: Promise<void> | null = null;
  let pauseGeneration = 0;
  const inFlight = new Set<string>();
  function authority(principalId: string) {
    const p = resolvePrincipal(db, principalId);
    if (!p || !isUsablePrincipal(p, now()) || !["owner", "ambient"].includes(p.kind)) throw new HygieneAuthorityError("Human review authority is required");
  }
  /**
   * The review's one backlog: the CLI's Markdown findings and the host's
   * managed-worktree findings (#2431). Selection merges both by the same
   * ordinal rules, and an operation that names a host finding is answered by
   * the host, never the CLI.
   */
  async function cli(args: string[]): Promise<unknown> {
    const host = deps.worktrees, [command] = args, target = args.at(-1) ?? "", at = args.indexOf("--finding");
    if (host && ((command === "next" && at >= 0 && host.owns(args[at + 1]!)) || (["check", "dismiss", "snooze", "resolve"].includes(command!) && host.owns(target))))
      return host.run(args);
    const own = host && (command === "list" || (command === "next" && at < 0)) ? host.run(args) : undefined;
    void own?.catch(() => {});
    if (!deps.brain.hygiene) throw new Error("Hygiene CLI is unavailable");
    const listed = await deps.brain.hygiene(args);
    if (!host || !own) return listed;
    if (command === "list") return { ...(listed as object), entries: [...(listed as { entries: unknown[] }).entries, ...(await own as { entries: unknown[] }).entries] };
    if (listed && typeof listed === "object" && "blocker" in listed) return listed;
    return host.merge(listed as never, await own as never);
  }
  function state(): HygieneReviewState {
    const row = db.query("SELECT data_json FROM hygiene_review WHERE singleton = 1").get() as { data_json: string } | null;
    return row ? hygieneReviewStateSchema.parse(JSON.parse(row.data_json)) : { version: 1, status: "idle", position: 0, fixed: 0, dismissed: 0, snoozed: 0 };
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
  /**
   * Only the owner principal reads a private worktree finding's details
   * (#2734). Delegated agents, including the worktree's own, and ambient
   * principals are refused, whatever the client shows.
   */
  function detailReader(principalId: string) {
    const p = resolvePrincipal(db, principalId);
    return !!p && isUsablePrincipal(p, now()) && p.kind === "owner";
  }
  function privateWorktree(item: InboxItem | null | undefined): item is InboxActionItem & { hygiene: HygieneAction } {
    const finding = (item?.queue === "actions" ? item.hygiene?.finding : undefined) as { category?: unknown; worktree?: { domain?: unknown } } | undefined;
    return !!deps.worktrees && item?.queue === "actions" && item.status === "pending" && finding?.category === "managed-worktree" && finding.worktree?.domain === "private";
  }
  /** One caller's review read: the replicated Action unchanged, plus whether this caller may read its private details. */
  function readFor(principalId: string, value = read()): HygieneReviewRead {
    return detailReader(principalId) && privateWorktree(value.action) ? { ...value, privateDetailAccess: { itemId: value.action.id } } : value;
  }
  /** The recorded facts behind the pending card, for the owner only. Nothing is assessed, written or replicated. */
  async function details(principalId: string, itemId: string): Promise<HygieneWorktreeDetailsRead> {
    if (!detailReader(principalId)) throw new HygieneAuthorityError("Owner authority is required");
    const item = store.getItem(itemId);
    const result = privateWorktree(item) ? await deps.worktrees!.details(item.hygiene.findingId, item.hygiene.fingerprint) : { status: "gone" as const };
    // Authority is read again after the await, as for every review operation.
    if (!detailReader(principalId)) throw new HygieneAuthorityError("Owner authority is required");
    return result;
  }
  function busy(itemId: string) { return db.query("SELECT 1 FROM hygiene_effect_attempts WHERE item_id = ? AND status = 'started'").get(itemId) !== null; }
  function effect(f: { id: string; fingerprint: string }, operation: HygieneEffect["operation"]): HygieneEffect {
    return { kind: "hygiene", operation, findingId: f.id, fingerprint: f.fingerprint };
  }
  /** A repair that takes no input but has no confirmed preview cannot be applied. */
  const missingPreview = (options: InboxOption[]) => options.some(o => o.effect.kind === "hygiene" && o.effect.operation === "resolve" && o.input?.type === "none" && !o.preview);
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
    return await write<HygieneReviewRead>("refresh", now(), principalId, old, next, finding, options, verified);
  }
  async function select(principalId?: string, resumeRetired = false) {
    const generation = pauseGeneration;
    const paused = state().pauseReason;
    // Recovery/next-item selection cannot authorize re-admission after retirement.
    if (paused && (!principalId || !resumeRetired)) return;
    // CLI selection/reconciliation and previews are outside write transactions.
    let next = nextSchema.parse(await cli(["next"]));
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
    let options = await prepareOptions(finding);
    // A host worktree finding's preview assesses it afresh: evidence that changed
    // meanwhile is selected again, and a repair left without a preview is not offered.
    for (let attempt = 0; finding && deps.worktrees?.owns(finding.id) && missingPreview(options); attempt++) {
      if (attempt === 2) { options = options.filter(o => !(o.effect.kind === "hygiene" && o.effect.operation === "resolve" && o.input?.type === "none" && !o.preview)); break; }
      next = nextSchema.parse(await cli(["next"]));
      finding = "finding" in next ? next.finding : null;
      options = await prepareOptions(finding);
    }
    if (principalId) authority(principalId);
    if (generation !== pauseGeneration) return;
    await write<void>("select", now(), principalId, resumeRetired, paused, next, finding, options);
  }
  async function ensureNext(principalId?: string, resumeRetired = false) {
    if (!preparing) preparing = select(principalId, resumeRetired).finally(() => { preparing = null; });
    await preparing;
  }
  async function command(principalId: string, operation: "start" | "pause" | "resume" | "refresh") {
    authority(principalId);
    if (operation === "refresh") return refresh(principalId);
    if (operation === "pause") pauseGeneration++;
    await write<void>("command", now(), principalId, operation);
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
    await write<void>("preview", now(), principalId, item, request, option, selected, result);
    return action(item.id);
  }
  async function dispatch(e: HygieneEffect, request: ClientInboxResolve, waitUntil: number | null, principalId: string): Promise<Result> {
    const args = e.operation === "resolve" ? ["resolve", "--handler", e.handler!, "--input", JSON.stringify(e.input), "--expect-fingerprint", e.fingerprint, "--expect-preview", e.previewToken!, "--", e.findingId]
      : e.operation === "undo" ? ["undo", "--", e.undoToken!]
      : e.operation === "check" ? ["check", "--", e.findingId]
      : [e.operation, "--expect-fingerprint", e.fingerprint, ...(waitUntil !== null ? ["--until", new Date(waitUntil).toISOString()] : []), ...(request.reason ? ["--reason", request.reason] : []), "--", e.findingId];
    // A confirmed effect on a host finding carries the reviewer's authority to its executor.
    if (e.operation !== "undo" && deps.worktrees?.owns(e.findingId)) return resultSchema.parse(await deps.worktrees.run(args, { authorize: () => authority(principalId) }));
    return resultSchema.parse(await cli(args));
  }
  async function finish(attempt: Attempt, result: Result, recovering = false) {
    const e = hygieneEffectSchema.parse(JSON.parse(attempt.effect_json));
    let options = action(attempt.item_id).options;
    if (result.status === "check_failed" && result.undoToken) {
      const inverse = resultSchema.parse(await cli(["undo", "--dry-run", "--", result.undoToken]));
      if (inverse.status === "preview" && inverse.diff) options = [...options.filter(o => o.id !== "undo"), { id: "undo", label: "Undo change", effect: { ...e, operation: "undo", handler: undefined, input: undefined, previewToken: undefined, undoToken: result.undoToken }, preview: inverse.diff }];
    }
    await write<void>("finish", now(), attempt, result, options);
    if (state().status === "active" && !state().pendingActionId) await ensureNext(recovering ? undefined : attempt.principal_id);
  }
  async function apply(principalId: string, request: ClientInboxResolve) {
    authority(principalId);
    const selected = resolver.inspect(principalId, request).effect;
    if (busy(request.itemId) && !inFlight.has(request.itemId) && selected.kind === "hygiene" && selected.operation === "check") {
      await recover(request.itemId);
      return { replay: false, followUpId: undefined };
    }
    const admitted = await write<Attempt | null>("admit", now(), principalId, request);
    if (!admitted) return { replay: true, followUpId: undefined };
    inFlight.add(request.itemId);
    let result: Result;
    try { authority(principalId); result = await dispatch(hygieneEffectSchema.parse(JSON.parse(admitted.effect_json)), request, admitted.wait_until, principalId); }
    catch {
      // Unknown dispatch receipt stays journaled. Recovery checks; it never retries.
      await write("unknown", now(), request.itemId);
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
  return { read, readFor, details, command, preview, resolver, recover };
}
export type HygieneReview = ReturnType<typeof createHygieneReview>;

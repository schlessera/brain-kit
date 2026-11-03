/** Human-started deterministic review. No backend, model, timer or second queue.
 * SQLite journals dispatch before CLI I/O; interrupted repairs are checked,
 * never reapplied. All Action projections use the shared store/change stream. */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { ClientInboxResolve, HygieneAction, HygieneEffect, HygieneInput, HygieneMediaPlan, HygieneMediaReceipt, HygieneReviewRead, HygieneReviewState, HygieneWorktreeDetailsRead, InboxActionItem, InboxItem, InboxOption } from "@schlessera/brain-ui-sdk/protocol";
import { hygieneEffectSchema, hygieneInputSchema, hygieneMediaPlanSchema, hygieneReviewStateSchema, inboxOptionSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { MediaEffects } from "./media-effects.js";
import type { BrainClient } from "../brain/client.js";
import type { ReferenceWorktreeHygiene } from "../brain/reference-worktree-hygiene.js";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { createInboxResolver } from "./resolve.js";
import { createInboxStore } from "./store.js";

import { findingSchema, IDLE_REVIEW, nextSchema, resultSchema, hygieneWrites, HygieneAuthorityError, type Result, type Attempt } from "./hygiene-writes.js";
export { HygieneAuthorityError } from "./hygiene-writes.js";

const id = z.string().min(1).max(256), text = z.string();

export function createHygieneReview(db: Database, deps: { brain: BrainClient; now?: () => number; timeZone?: string;
  /** Host-only managed worktree findings (#2431), joined into the same review queue. */
  worktrees?: ReferenceWorktreeHygiene;
  /** The gated dispatcher's current exact-operation envelope (#689); default empty. */
  allowedOperations?: Parameters<typeof createInboxResolver>[1]["allowedOperations"];
  /** The journal-backed media effects (#2781); without them no media effect is offered. */
  media?: MediaEffects }) {
  const now = deps.now ?? Date.now, store = createInboxStore(db, { now });
  const write = hygieneWrites(db, deps.timeZone);
  const resolver = createInboxResolver(db, { now, timeZone: deps.timeZone, allowedOperations: deps.allowedOperations ?? (() => []), applyHygiene: apply });
  let media = deps.media;
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
    return row ? hygieneReviewStateSchema.parse(JSON.parse(row.data_json)) : IDLE_REVIEW;
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
  /** A media effect's CLI plan, or null when the CLI could not plan it (not detected, stale). */
  async function mediaPlan(f: { id: string; fingerprint: string }, operation: HygieneEffect["operation"], destination?: string): Promise<HygieneMediaPlan | null> {
    const parsed = hygieneMediaPlanSchema.safeParse(await cli(["media", operation.slice("media-".length), f.id, "--expect-fingerprint", f.fingerprint, ...(destination !== undefined ? ["--to", destination] : []), "--dry-run"]));
    return parsed.success ? parsed.data : null;
  }
  /** The options' media plan: only a plan without refusals carries the premise that lets it apply. */
  function withPlan(option: InboxOption, plan: HygieneMediaPlan | null, destination?: string): InboxOption {
    const e = option.effect as HygieneEffect;
    return { ...option, effect: { ...e, destination, premiseDigest: plan && plan.refusals.length === 0 ? plan.premiseDigest : undefined }, media: plan ?? undefined };
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
      // Media effects (#2781, rev 4 §4.2), in the card's order. Persist and
      // Delete take no input and are planned now; Move and Keep a copy are
      // planned when a destination is previewed. A plan's refusals stay on
      // the option, so an unavailable action shows why.
      if (finding.category === "media" && media) {
        const scratch = finding.path.startsWith(".brain/scratch/");
        const rows: Array<[HygieneEffect["operation"], string, boolean]> = [["media-persist", "Persist here", false], ["media-move", "Move to a final location…", true],
          ...(scratch ? [["media-keep-copy", "Keep a permanent copy…", true] as [HygieneEffect["operation"], string, boolean]] : []), ["media-delete", "Delete…", false]];
        for (const [operation, label, needsPath] of rows) {
          const option: InboxOption = { id: operation, label, effect: effect(finding, operation), ...(needsPath ? { input: { type: "path" as const } } : {}) };
          options.push(inboxOptionSchema.parse(needsPath ? option : withPlan(option, await mediaPlan(finding, operation))));
        }
      }
      // Media (#2780) can always be left pending for the rest of this pass.
      if (finding.category === "media") options.push({ id: "leave-pending", label: "Leave pending", effect: effect(finding, "defer") });
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
    // Findings left pending this pass are skipped while their fingerprint holds.
    const deferred = state().deferred ?? [];
    const nextArgs = deferred.length > 0 ? ["next", "--defer", deferred.map(d => `${d.findingId}=${d.fingerprint}`).join(",")] : ["next"];
    let next = nextSchema.parse(await cli(nextArgs));
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
      next = nextSchema.parse(await cli(nextArgs));
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
    if (selected.kind === "hygiene" && selected.operation.startsWith("media-")) {
      if (!media) throw new Error("Media effects are unavailable");
      const destination = typeof request.input === "string" ? request.input : undefined;
      const plan = await mediaPlan({ id: selected.findingId, fingerprint: selected.fingerprint }, selected.operation, destination);
      authority(principalId);
      await write<void>("mediaPreview", now(), principalId, item, request, option.id, withPlan(option, plan, destination));
      return action(item.id);
    }
    if (selected.kind !== "hygiene" || selected.operation !== "resolve" || !selected.handler) throw new Error("Not a repair option");
    const result = resultSchema.parse(await cli(["resolve", "--handler", selected.handler, "--input", JSON.stringify(request.input), "--expect-fingerprint", selected.fingerprint, "--dry-run", "--", selected.findingId]));
    authority(principalId);
    await write<void>("preview", now(), principalId, item, request, option, selected, result);
    return action(item.id);
  }
  async function dispatch(e: HygieneEffect, request: ClientInboxResolve, waitUntil: number | null, principalId: string, attemptId: string): Promise<Result> {
    // Leave pending is review state only: nothing is sent to the CLI.
    if (e.operation === "defer") return { id: e.findingId, status: "deferred" };
    if (e.operation.startsWith("media-")) {
      const plan = action(request.itemId).options.find(o => o.id === request.optionId)?.media;
      if (!media || !plan) return { id: e.findingId, status: "refused", reason: "media-effects-unavailable" };
      return mediaResult(e.findingId, await media.apply({ id: mediaOperationId(attemptId), principalId, findingId: e.findingId, fingerprint: e.fingerprint, plan }));
    }
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
    try { authority(principalId); result = await dispatch(hygieneEffectSchema.parse(JSON.parse(admitted.effect_json)), request, admitted.wait_until, principalId, admitted.id); }
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
      } else if (e.operation.startsWith("media-")) {
        // Until the journal-backed effects attach, an interrupted media effect stays started.
        if (!media) continue;
        // Recovery compensates an interrupted effect from its journal row; it never re-applies one.
        await media.recover();
        const receipt = media.receipt(mediaOperationId(attempt.id), attempt.principal_id);
        if (!receipt || receipt.outcome === "pending") result = { id: e.findingId, status: "check_failed", code: "receipt-unknown" };
        else if (e.operation === "media-keep-copy" && receipt.outcome === "kept") {
          // A copy is kept only when its entry, fingerprint and copy SHA-256 all match (rev 6 §1).
          const listed = z.object({ entries: z.array(z.looseObject({ id, state: text, fingerprint: text.nullable(), copySha256: text.nullable().optional() })) }).parse(await cli(["list"]));
          const entry = listed.entries.find(v => v.id === e.findingId);
          result = entry?.state === "kept" && entry.fingerprint === e.fingerprint && entry.copySha256 === receipt.copySha256 ? mediaResult(e.findingId, receipt) : { id: e.findingId, status: "check_failed", code: "receipt-unknown", media: receipt };
        } else result = mediaResult(e.findingId, receipt);
      } else if (e.operation === "defer") {
        // Host-only and idempotent: the deferral is recorded when this attempt finishes.
        result = { id: e.findingId, status: "deferred" };
      } else result = { id: e.findingId, status: "check_failed", code: "undo-receipt-unknown" };
      await finish(attempt, result, true);
    }
    if (state().status === "active" && !state().pendingActionId) await ensureNext();
  }
  return { read, readFor, details, command, preview, resolver, recover,
    /** The app attaches the journal-backed media effects once its journal is ready. */
    attachMedia(effects: MediaEffects) { media = effects; } };
}

/** A media effect's operation identity, derived from the review attempt that admitted it. */
export const mediaOperationId = (attemptId: string) => `media-${createHash("sha256").update(attemptId).digest("hex").slice(0, 40)}`;

/** The review outcome for a media receipt: applied is `fixed`, a kept copy `kept`, anything undone by halves `check_failed`. */
export function mediaResult(findingId: string, receipt: HygieneMediaReceipt): Result {
  const status = receipt.outcome === "applied" ? "fixed" : receipt.outcome === "kept" ? "kept" : receipt.outcome === "stale" ? "stale" : receipt.outcome === "refused" ? "refused" : "check_failed";
  return { id: findingId, status, ...(receipt.reason ? { reason: receipt.reason } : {}), ...(status === "check_failed" ? { code: receipt.outcome === "pending" ? "receipt-unknown" : receipt.outcome } : {}), media: receipt };
}
export type HygieneReview = ReturnType<typeof createHygieneReview>;

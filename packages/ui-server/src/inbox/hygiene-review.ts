/** Human-started deterministic review. No backend, model, timer or second queue.
 * SQLite journals dispatch before CLI I/O; interrupted repairs are checked,
 * never reapplied. All Action projections use the shared store/change stream. */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { ClientInboxResolve, HygieneAction, HygieneEffect, HygieneInput, HygieneMediaPlan, HygieneMediaReceipt, HygieneMediaRefusal, HygienePreviewResponse, HygieneReviewRead, HygieneReviewState, HygieneWorktreeDetailsRead, InboxActionItem, InboxItem, InboxOption } from "@schlessera/brain-ui-sdk/protocol";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { hygieneEffectSchema, hygieneInputSchema, hygieneMediaPlanSchema, hygieneMediaRefusalSchema, hygieneReviewStateSchema, inboxOptionSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { MediaEffects } from "./media-effects.js";
import type { BrainClient } from "../brain/client.js";
import type { ReferenceWorktreeHygiene } from "../brain/reference-worktree-hygiene.js";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { createInboxResolver } from "./resolve.js";
import { createInboxStore } from "./store.js";
import { MAX_WS_MESSAGE_BYTES } from "../ws/shrink.js";

import { findingSchema, IDLE_REVIEW, nextSchema, resultSchema, hygieneWrites, HygieneAuthorityError, type Result, type Attempt } from "./hygiene-writes.js";
export { HygieneAuthorityError } from "./hygiene-writes.js";

const id = z.string().min(1).max(256), text = z.string();

export function createHygieneReview(db: Database, deps: { brain: BrainClient; now?: () => number; timeZone?: string;
  /** Host-only managed worktree findings (#2431), joined into the same review queue. */
  worktrees?: ReferenceWorktreeHygiene;
  /** The gated dispatcher's current exact-operation envelope (#689); default empty. */
  allowedOperations?: Parameters<typeof createInboxResolver>[1]["allowedOperations"];
  /** The journal-backed media effects (#2781); without them no media effect is offered. */
  media?: MediaEffects;
  /** The most a previewed Action may serialize to; default and ceiling {@link PREVIEW_RESPONSE_LIMIT_BYTES}. */
  previewResponseBytes?: number }) {
  const now = deps.now ?? Date.now, store = createInboxStore(db, { now });
  const write = hygieneWrites(db, deps.timeZone);
  const resolver = createInboxResolver(db, { now, timeZone: deps.timeZone, allowedOperations: deps.allowedOperations ?? (() => []), applyHygiene: apply });
  let media = deps.media;
  let preparing: Promise<void> | null = null;
  let pauseGeneration = 0;
  const inFlight = new Set<string>();
  const previewLimit = Math.min(deps.previewResponseBytes ?? PREVIEW_RESPONSE_LIMIT_BYTES, PREVIEW_RESPONSE_LIMIT_BYTES);
  /**
   * The one media preview scan this server runs (#2781, rev 4 §3.3). A newer
   * preview from the same principal aborts it, killing its CLI scan; another
   * principal's preview is refused `preview-busy`. Nothing waits or retries.
   */
  let scanning: { principalId: string; controller: AbortController } | null = null;
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
  async function cli(args: string[], signal?: AbortSignal): Promise<unknown> {
    const host = deps.worktrees, [command] = args, target = args.at(-1) ?? "", at = args.indexOf("--finding");
    if (host && ((command === "next" && at >= 0 && host.owns(args[at + 1]!)) || (["check", "dismiss", "snooze", "resolve"].includes(command!) && host.owns(target))))
      return host.run(args);
    const own = host && (command === "list" || (command === "next" && at < 0)) ? host.run(args) : undefined;
    void own?.catch(() => {});
    if (!deps.brain.hygiene) throw new Error("Hygiene CLI is unavailable");
    const listed = await deps.brain.hygiene(args, signal ? { signal } : undefined);
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
  /**
   * A media effect's CLI plan, or null when the CLI could not plan it (not
   * detected, stale). With `previewed`, a person asked for this preview: the
   * one broader ignore entry that would still win over the track entry is
   * then planned as an adjustment, shown with what stops being ignored and
   * approved with the rest (M1 A). Several such entries stay refused.
   */
  async function mediaPlan(f: { id: string; fingerprint: string }, operation: MediaOperation, input: { destination?: string; pattern?: string; previewed?: boolean; signal?: AbortSignal; unplanned?: HygieneMediaRefusal[] } = {}): Promise<HygieneMediaPlan | null> {
    const to = input.destination !== undefined ? ["--to", input.destination] : [], rule = input.pattern !== undefined ? ["--pattern", input.pattern] : [];
    let last = await cli(["media", MEDIA_ACTIONS[operation], f.id, "--expect-fingerprint", f.fingerprint, ...to, ...rule, "--dry-run"], input.signal);
    let parsed = hygieneMediaPlanSchema.safeParse(last);
    const only = parsed.success && parsed.data.refusals.length === 1 ? parsed.data.refusals[0]! : null;
    if (input.previewed && only?.code === "ignore-adjustment-required" && only.path && !only.path.includes("\n")) {
      input.signal?.throwIfAborted();
      last = await cli(["media", MEDIA_ACTIONS[operation], f.id, "--expect-fingerprint", f.fingerprint, ...to, ...rule, "--ignore-adjust", only.path, "--dry-run"], input.signal);
      parsed = hygieneMediaPlanSchema.safeParse(last);
    }
    if (parsed.success) return parsed.data;
    // Not a plan (not detected now, or stale): its named refusals, when the CLI gave any.
    const refused = z.object({ refusals: z.array(hygieneMediaRefusalSchema).max(64) }).safeParse(last);
    input.unplanned?.push(...(refused.success && refused.data.refusals.length > 0 ? refused.data.refusals : [{ code: "plan-unavailable" }]));
    return null;
  }
  /**
   * The options' media plan: only a plan without refusals carries the premise
   * that lets it apply. A broader change is bound to the principal who
   * previewed it (rev 3 §5.4); no one else can confirm it.
   */
  function withPlan(option: InboxOption, plan: HygieneMediaPlan | null, destination?: string, principalId?: string): InboxOption {
    const e = option.effect as HygieneEffect;
    const ready = plan !== null && plan.refusals.length === 0;
    return { ...option, effect: { ...e, destination, premiseDigest: ready ? plan.premiseDigest : undefined, approvedBy: ready && plan.approvalDigest ? principalId : undefined }, media: plan ?? undefined };
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
        const rows: Array<[MediaOperation, string, boolean]> = [["media-persist", "Persist here", false], ["media-move", "Move to a final location…", true],
          ...(scratch ? [["media-keep-copy", "Keep a permanent copy…", true] as [MediaOperation, string, boolean]] : []), ["media-delete", "Delete…", false]];
        for (const [operation, label, needsPath] of rows) {
          const option: InboxOption = { id: operation, label, effect: effect(finding, operation), ...(needsPath ? { input: { type: "path" as const } } : {}) };
          options.push(inboxOptionSchema.parse(needsPath ? option : withPlan(option, await mediaPlan(finding, operation))));
          // Persist by a broader media.track rule (rev 4 §7): the person enters the
          // rule, and its preview lists every current match before approval.
          if (operation === "media-persist" && !scratch && !isWithin(SHARE_STAGING_DIR, finding.path, { includeRoot: false })) {
            options.push(inboxOptionSchema.parse({ id: PERSIST_RULE, label: "Persist with a broader rule…", input: { type: "string", example: ruleExample(finding.path) }, effect: effect(finding, operation) }));
          }
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
  /** The counts the pass's next selection would store, read with its deferrals, without selecting. */
  async function recount(principalId: string) {
    const deferred = state().deferred ?? [];
    const next = nextSchema.parse(await cli(deferred.length > 0 ? ["next", "--defer", deferred.map(d => `${d.findingId}=${d.fingerprint}`).join(",")] : ["next"]));
    authority(principalId);
    await write<void>("counts", now(), principalId, next);
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
  /**
   * Undo a confirmed media effect from its resolved card (#2781, ruling
   * 2026-11-03), under the same preflights as the CLI Undo: rollback data
   * still retained and no file changed since. A refusal is a result, recorded
   * on the card as its current Undo availability, never a write.
   */
  async function undoMedia(principalId: string, journalId: string): Promise<HygieneReviewRead & { mediaUndo: HygieneMediaReceipt }> {
    authority(principalId);
    if (!media) throw new Error("Media effects are unavailable");
    const attempts = db.query("SELECT * FROM hygiene_effect_attempts WHERE status = 'finished' AND principal_id = ? ORDER BY rowid DESC").all(principalId) as Attempt[];
    const attempt = attempts.find(a => mediaOperationId(a.id) === journalId);
    if (!attempt) throw new Error("Media receipt unavailable");
    const item = action(attempt.item_id), e = hygieneEffectSchema.parse(JSON.parse(attempt.effect_json));
    if (!isMediaOperation(e.operation) || item.status !== "resolved" || busy(item.id)) throw new Error("Not an undoable media card");
    const receipt = await media.undo({ id: `undo-${journalId}`, principalId, sourceId: journalId });
    authority(principalId);
    await write<void>("mediaUndo", now(), principalId, item.id, journalId, receipt, receipt.outcome === "refused" ? media.receipt(journalId, principalId) : null);
    // The finding is pending again; an active review with no card selects it in order.
    if (receipt.outcome === "undone" && state().status === "active" && !state().pendingActionId) await ensureNext(principalId);
    // Otherwise nothing selects now, and the stored count must not keep the effect's (#2783).
    else if (receipt.outcome === "undone") await recount(principalId);
    return { ...read(), mediaUndo: receipt };
  }
  /**
   * A preview's 200 body (rev 5 §9/§11): the pending Action, the echoed
   * `requestId`, and its named refusals, which are results, never errors.
   */
  function previewed(itemId: string, requestId: string | undefined, refusals: HygieneMediaRefusal[], plan?: HygieneMediaPlan | null): HygienePreviewResponse {
    return { ...action(itemId), ...(requestId !== undefined ? { requestId } : {}), refusals, ...(plan?.media !== undefined ? { media: plan.media } : {}) };
  }
  async function preview(principalId: string, request: { itemId: string; optionId: string; expectedVersion: number; input: HygieneInput; requestId?: string }): Promise<HygienePreviewResponse> {
    authority(principalId); hygieneInputSchema.parse(request.input);
    const item = action(request.itemId), { option, effect: selected } = resolver.inspect(principalId, { type: "inbox_resolve", itemId: item.id, optionId: request.optionId });
    if (item.version !== request.expectedVersion || item.status !== "pending" || busy(item.id)) throw new Error("Inbox version conflict");
    if (selected.kind === "hygiene" && isMediaOperation(selected.operation)) {
      if (!media) throw new Error("Media effects are unavailable");
      const text = typeof request.input === "string" ? request.input : undefined;
      const rule = option.id === PERSIST_RULE, destination = rule ? undefined : text;
      if (rule && text === undefined) throw new Error("A broader rule needs its pattern");
      // One scan per server (rev 4 §3.3): another principal's is never aborted, the same principal's older one is.
      if (scanning && scanning.principalId !== principalId) return previewed(item.id, request.requestId, [{ code: "preview-busy" }]);
      scanning?.controller.abort();
      const scan = { principalId, controller: new AbortController() };
      scanning = scan;
      let plan: HygieneMediaPlan | null;
      const unplanned: HygieneMediaRefusal[] = [];
      try { plan = await mediaPlan({ id: selected.findingId, fingerprint: selected.fingerprint }, selected.operation, { destination, pattern: rule ? text : undefined, previewed: true, signal: scan.controller.signal, unplanned }); }
      catch (error) { if (!scan.controller.signal.aborted) throw error; plan = null; }
      finally { if (scanning === scan) scanning = null; }
      // A superseded scan stores nothing; its client renders only the newer request.
      if (scan.controller.signal.aborted) return previewed(item.id, request.requestId, [{ code: "preview-superseded" }]);
      authority(principalId);
      const planned = withPlan(option, plan, destination, principalId);
      // The Action this stores is replicated and returned whole: one past the transport's limit is refused, never truncated.
      const size = Buffer.byteLength(JSON.stringify({ ...item, options: item.options.map(o => o.id === option.id ? planned : o) }), "utf8");
      if (size > previewLimit) return previewed(item.id, request.requestId, [{ code: "inventory-too-large", limit: "preview", effective: previewLimit, observed: size }]);
      await write<void>("mediaPreview", now(), principalId, item, request, option.id, planned);
      return previewed(item.id, request.requestId, plan?.refusals ?? unplanned, plan);
    }
    if (selected.kind !== "hygiene" || selected.operation !== "resolve" || !selected.handler) throw new Error("Not a repair option");
    const result = resultSchema.parse(await cli(["resolve", "--handler", selected.handler, "--input", JSON.stringify(request.input), "--expect-fingerprint", selected.fingerprint, "--dry-run", "--", selected.findingId]));
    authority(principalId);
    await write<void>("preview", now(), principalId, item, request, option, selected, result);
    return previewed(item.id, request.requestId, []);
  }
  async function dispatch(e: HygieneEffect, request: ClientInboxResolve, waitUntil: number | null, principalId: string, attemptId: string): Promise<Result> {
    // Leave pending is review state only: nothing is sent to the CLI.
    if (e.operation === "defer") return { id: e.findingId, status: "deferred" };
    if (isMediaOperation(e.operation)) {
      const plan = action(request.itemId).options.find(o => o.id === request.optionId)?.media;
      if (!media || !plan) return { id: e.findingId, status: "refused", reason: "media-effects-unavailable" };
      // A broader change applies only for the principal who previewed and approved it.
      if (plan.approvalDigest && e.approvedBy !== principalId) return { id: e.findingId, status: "stale", reason: "stale-approval" };
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
      } else if (isMediaOperation(e.operation)) {
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
  return { read, readFor, details, command, undoMedia, preview, resolver, recover,
    /** The app attaches the journal-backed media effects once its journal is ready. */
    attachMedia(effects: MediaEffects) { media = effects; } };
}

/**
 * The most a previewed Action may serialize to (#2781, rev 4 §9): the
 * transport's per-message limit, which the stored Action must fit to
 * replicate. It bounds the CLI's own `preview` limit from above.
 */
export const PREVIEW_RESPONSE_LIMIT_BYTES = MAX_WS_MESSAGE_BYTES;

/** Persist here by a broader `media.track` rule (#2781): the same effect, with the person's pattern. */
const PERSIST_RULE = "media-persist-rule";
/** The rule a person most likely means: every file in the same folder, or the name in any folder at the root. */
const ruleExample = (path: string) => path.includes("/") ? `${path.slice(0, path.lastIndexOf("/"))}/*` : path;

/** The four media review effects (#2781) and the `brain hygiene media` action each one runs. */
const MEDIA_ACTIONS = { "media-delete": "delete", "media-move": "move", "media-persist": "persist", "media-keep-copy": "keep-copy" } as const;
type MediaOperation = keyof typeof MEDIA_ACTIONS;
/** Narrows an effect to a media one, so the generic disposition argv can never carry one. */
const isMediaOperation = (operation: HygieneEffect["operation"]): operation is MediaOperation => Object.hasOwn(MEDIA_ACTIONS, operation);

/** A media effect's operation identity, derived from the review attempt that admitted it. */
export const mediaOperationId = (attemptId: string) => `media-${createHash("sha256").update(attemptId).digest("hex").slice(0, 40)}`;

/** The review outcome for a media receipt: applied is `fixed`, a kept copy `kept`, anything undone by halves `check_failed`. */
export function mediaResult(findingId: string, receipt: HygieneMediaReceipt): Result {
  const status = receipt.outcome === "applied" ? "fixed" : receipt.outcome === "kept" ? "kept" : receipt.outcome === "stale" ? "stale" : receipt.outcome === "refused" ? "refused" : "check_failed";
  return { id: findingId, status, ...(receipt.reason ? { reason: receipt.reason } : {}), ...(status === "check_failed" ? { code: receipt.outcome === "pending" ? "receipt-unknown" : receipt.outcome } : {}), media: receipt };
}
export type HygieneReview = ReturnType<typeof createHygieneReview>;

import { redactCredentials } from "../activity/runtime-status.js";
/** Concrete Google write sequencing. Production has no prepared operations until
 * #4213/#4214; the internal factories exercise the same admission path in tests. */
import { createHash, randomUUID } from "node:crypto";
import { createKeyedLock, type PermissionDecision, type PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { safetyAdmissionRefusal, sameSafetyAdmission, type AdmissionSafetySnapshot } from "@schlessera/brain-ui-sdk/internal";
import { decideGoogleCall, type GoogleCallFacts, type GoogleDecision, type GoogleDecisionFacts, type GoogleError,
  type GooglePolicy } from "@schlessera/brain-common/internal/google-operations";

import { GOOGLE_APPROVAL_CARD_BYTES, GOOGLE_MAIL_APPROVAL_SCHEMA, GOOGLE_WRITE_SUCCESS_SCHEMA, type GoogleMailApproval,
  type GoogleToolCall, type GoogleToolResult, type GoogleWriteSuccess } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { GoogleLedger } from "@schlessera/brain-common/internal/google-ledger";
import type { GogResult } from "@schlessera/brain-common/internal/google-gog";
import type { createGoogleAllowances, GoogleAllowanceContext, GoogleAllowanceRow } from "./allowances.js";
import type { GoogleToolsTurn, GoogleCallAudit } from "./host.js";
import type { createGoogleStateWrites, GoogleDecisionEvent, GoogleInversePrepared, GoogleInverseResult } from "./state-writes.js";

type State = ReturnType<typeof createGoogleStateWrites>;
type Operation = GoogleMailApproval["operation"];
type WriteCall = Extract<GoogleToolCall, { tool: GoogleWriteSuccess["tool"] }>;
export interface GoogleWriteTurn {
  signal: AbortSignal;
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
  toolName(name: string): string;
  isCurrent(): boolean;
  safety(): AdmissionSafetySnapshot;
  /** Synchronous exposure read at the final dispatch boundary. */
  routingNow(): GoogleDecisionFacts["routing"];
  /** Commit-confirmed transaction only: never the optional catalog recorder. */
  record: State["commitGoogleDecision"];
}
/** Internal, test-only until concrete Gmail operations land. Pre-reads happen
 * under the host account lock. Re-preparing must expose changes in payload or
 * preconditions, so an approval cannot silently change targets.
 * execute MUST call finalAdmission synchronously immediately before its SINGLE
 * dispatch, after all transport waits, and MUST NOT dispatch on an error.
 * #4213 threads this callback through the gog transport's final spawn boundary. */
export interface PreparedGoogleWrite {
  operation: Operation;
  input: WriteCall["input"];
  facts: Pick<GoogleDecisionFacts, "items" | "recipients" | "self_addresses" | "target_label_ids">;
  classificationFacts: GoogleCallFacts;
  card: GoogleMailApproval;
  inverse?: Omit<GoogleInversePrepared, "sessionId" | "turnId" | "principalId" | "brainId" | "callId" | "inverseId" | "operation" | "accountIdentity">;
  sendLock?: string;
  execute(finalAdmission: () => GoogleError | null): Promise<
    { ok: true; result: GoogleWriteSuccess["result"]; inverseResult?: GoogleInverseResult } | { ok: false; error: GoogleError }>;
}
export type GoogleWriteFactories = Partial<Record<Operation,
  (turn: GoogleToolsTurn, call: WriteCall) => Promise<PreparedGoogleWrite>>>;
export interface GoogleWriteOptions {
  brainId: string;
  hostEpoch: string;
  ledger(): GoogleLedger;
  allowances: ReturnType<typeof createGoogleAllowances>;
  resolveAccount(alias: string): Promise<GogResult<string>>;
  /** Full governance hash, not merely the Google block. */
  currentPolicyHash(): string;
  state: State;
  ready(): boolean;
  currentPolicy(): GooglePolicy | null | undefined;
  isDraftLocked(account: string, draft: string, epoch: string, now: number): boolean;
  /** @internal Prepared operations for offline tests; never configuration. */
  preparedWrites?: GoogleWriteFactories;
}

/** Sorted JSON, identical echoes compare equal regardless of key order. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const hash = (value: unknown) => createHash("sha256").update(canonical(value ?? null)).digest("hex");
const error = (reason: string, message: string, code: GoogleError["code"] = "policy_denied"): GoogleError => ({ code, reason, message });
const recordingUnavailable = error("recording_unavailable", "The decision could not be recorded, so nothing was sent.", "unavailable");
const stateUnavailable = error("state_unavailable", "Google write state is unavailable; the host will retry initialization.", "unavailable");
const gogError = (code: "draft_locked" | "outcome_unknown", reason: string): GoogleError => ({ code, reason,
  message: code === "draft_locked" ? "This draft is waiting on an open send card." : "The write may or may not have happened at Google; check before trying again." });
const cancelled = error("cancelled", "The turn ended before dispatch; nothing was sent. Call again in a current turn.");
const changed = error("policy_changed", "The Google policy changed during this turn. Nothing was sent; the current policy applies from the next message.");
const stale = error("safety_changed", "Safety changed before dispatch. Nothing was sent; call again for a fresh decision.");

/** One host epoch and one concrete account lock; never the transport semaphore. */
export function createGoogleWriteEngine(options: GoogleWriteOptions, principal: (id: string) => GoogleDecisionFacts["principal"],
  report: (message: string) => void, now: () => number) {
  const hostEpoch = options.hostEpoch, lock = createKeyedLock(), aliasLock = createKeyedLock();
  const counts = new WeakMap<GoogleWriteTurn, number>();
  let closed = false;
  const retries = new Set<ReturnType<typeof setTimeout>>();
  /** Idempotent host-state cleanup only (never a Google call): retried with capped backoff until it lands or the host closes. */
  const retryCleanup = (label: string, work: () => unknown, delay = 1_000) => {
    if (closed) return;
    const timer = setTimeout(async () => {
      retries.delete(timer);
      try { await work(); }
      catch (cause) {
        report(`${label} retry failed: ${String(cause)}`);
        retryCleanup(label, work, Math.min(30_000, delay * 2));
      }
    }, delay);
    timer.unref?.(); retries.add(timer);
  };
  const cleanup = async (label: string, work: () => unknown) => {
    try { await work(); }
    catch (cause) { report(`${label} failed: ${String(cause)}`); retryCleanup(label, work); }
  };
  const write = async (turn: GoogleToolsTurn, call: WriteCall, operation: Operation,
    audit: Partial<GoogleCallAudit>): Promise<GoogleToolResult> => {
    const refuse = (failure: GoogleError): GoogleToolResult => ({ ok: false, tool: call.tool, error: failure });
    if (!options.ready()) return refuse(stateUnavailable);
    const factory = options.preparedWrites?.[operation];
    if (!factory) return refuse(error("writes_unavailable", "Gmail changes are not available on this host yet: only search and read are. Nothing was changed.", "unavailable"));
    const ctx = turn.write;
    if (!ctx) return refuse(error("no_write_surface", "This turn cannot authorize Google writes."));
    const policy = turn.policy(), policyHash = hash(policy), callId = randomUUID(), cardId = `google-${randomUUID()}`;
    const sessionId = turn.sessionId();
    if (!sessionId) return refuse(recordingUnavailable);
    let prepared: PreparedGoogleWrite | undefined, decision: GoogleDecision | undefined;
    let card: GoogleMailApproval | undefined, admission: GoogleWriteSuccess["admission"] = "card";
    let before: AdmissionSafetySnapshot, pinned: AdmissionSafetySnapshot | undefined;
    try { before = ctx.safety(); } catch { return refuse(stale); }
    let held: (() => void) | undefined, sendLocked = false, dispatched = false;
    let inverseId: string | null = null, committedInverse: string | null = null;
    const alias = policy?.account ?? "";
    let account = "", resolved = false, releaseAlias: (() => void) | undefined;
    let grant: "always" | "session" | undefined;
    let reserved: GoogleAllowanceRow[] | undefined;
    const fullPolicyHash = before.policyHash ?? "missing";
    const allowanceContext = (): GoogleAllowanceContext => ({ sessionId, principalId: turn.principalId, brainId: options.brainId,
      accountIdentity: account || "unresolved", hostEpoch, policyHash: options.currentPolicyHash(), now: now(),
      tainted: turn.tainted() || ctx.safety().restricted, authorized: principal(turn.principalId) === "owner" });
    const approvalScope = () => ({ principal_id: turn.principalId, brain_id: options.brainId, account_identity: account });
    const storageFailure = (store: "remembered_approvals" | "session_allowances", site: "read" | "reconcile" | "grant" | "reserve", cause: unknown) => {
      const diagnostic = { store, site, errorClass: (cause instanceof Error ? cause.name : typeof cause).slice(0, 128),
        message: redactCredentials(cause instanceof Error ? cause.message : String(cause)).slice(0, 500) };
      const failures = audit.standingFailures ??= [];
      if (failures.length < 4 && !failures.some(item => item.store === store && item.site === site)) failures.push(diagnostic);
      report(`Google standing storage unavailable: ${JSON.stringify(diagnostic)}`);
    };
    const grants = (tainted: boolean) => {
      if (!resolved) return { remembered_approvals: [], session_allowances: [] };
      try {
        if (tainted) {
          const rows = options.allowances.read(allowanceContext());
          // The reservation already charged this call; only the identical live grant can redeem it.
          const allowances = reserved ? rows.filter(row => reserved!.some(r => r.operation === row.operation && r.entity === row.entity && r.granted_card_id === row.granted_card_id))
            .map(row => ({ ...row, remaining_items: 100 })) : rows;
          return { remembered_approvals: [], session_allowances: allowances };
        }
        return { remembered_approvals: options.ledger().approvals(approvalScope()), session_allowances: [] };
      } catch (cause) {
        // One store failing removes only its standing admission. An exact card can still run.
        storageFailure(tainted ? "session_allowances" : "remembered_approvals", "read", cause);
        return { remembered_approvals: [], session_allowances: [] };
      }
    };
    const live = (): GoogleError | null => {
      try {
        if (ctx.signal.aborted || !ctx.isCurrent()) return cancelled;
        if (principal(turn.principalId) !== "owner") return error("not_owner", "The Google tools serve the brain's owner only.");
        if (hash(options.currentPolicy()) !== policyHash || options.currentPolicyHash() !== fullPolicyHash) return changed;
        if (safetyAdmissionRefusal({ read: ctx.safety, subscribe: () => () => {} }, before)) return stale;
        // An exact card is approved against the safety it was decided and shown under; any later change needs a fresh card.
        if (pinned && (!sameSafetyAdmission(pinned, ctx.safety()) || (turn.tainted() || ctx.safety().restricted) !== card?.tainted)) return stale;
        if (!options.ready()) return stateUnavailable;
        return null;
      } catch { return stale; }
    };
    const facts = (routing: GoogleDecisionFacts["routing"]): GoogleDecisionFacts => ({ ...prepared?.facts,
      principal: principal(turn.principalId), posture: turn.posture,
      tainted: turn.tainted() || ctx.safety().restricted, card_available: turn.posture === "interactive" && !!ctx.requestPermission,
      routing, ...grants(turn.tainted() || ctx.safety().restricted), turn_reversible_items: counts.get(ctx) ?? 0 });
    const decide = (routing: GoogleDecisionFacts["routing"]) => decideGoogleCall(policy,
      { operation, input: prepared?.input ?? call.input, facts: prepared?.classificationFacts }, facts(routing));
    const record = async (verdict: "allowed" | "approved" | "declined" | "refused"): Promise<boolean> => {
      const effect = decision?.effect === "reversible" ? "reversible" : "irreversible";
      const accepted = verdict === "allowed" || verdict === "approved";
      const target = prepared?.card.payload && "draft_id" in prepared.card.payload ? prepared.card.payload.draft_id : operation;
      inverseId = accepted && effect === "reversible" ? randomUUID() : null;
      Object.assign(audit, { callId, effect, target, decisionEventId: null, decision: verdict, admission: verdict === "allowed" ? admission : null });
      const base = { sessionId, turnId: turn.turnId, actor: turn.posture, model: null, profile: null };
      // Explicit metadata projection: no subjects, recipients, body or raw bytes.
      const payload = prepared?.card.payload;
      const metadata = { operation, ...(payload && "message_ids" in payload ? { message_ids: payload.message_ids, items: payload.message_ids.length } : {}),
        ...(payload && "draft_id" in payload ? { draft_id: payload.draft_id } : {}),
        ...(payload && "message" in payload ? { digest: payload.message.digest, bytes: payload.message.bytes } : {}),
        ...(payload && "digest" in payload ? { digest: payload.digest } : {}) };
      const event: GoogleDecisionEvent = effect === "reversible"
        ? { ...base, kind: "google_reversible_action", payload: { callId, tool: ctx.toolName(call.tool), operation, effect, target,
          tainted: decision?.tainted ?? true, decision: verdict, admission: verdict === "allowed" && admission !== "card" ? admission : null, inverseId } }
        : { ...base, kind: "outward_action", payload: { tool: ctx.toolName(call.tool), action: "google_write", input: canonical(metadata),
          inputTruncated: false, target, historyRewrite: false, tainted: decision?.tainted ?? true,
          decision: verdict === "allowed" ? "refused" : verdict, rule: null, google: { callId, operation, effect } } };
      try {
        if (inverseId && !prepared?.inverse) throw new Error("A reversible Google write requires its inverse");
        const inverse = inverseId && prepared?.inverse ? { ...prepared.inverse, inverseId, callId, sessionId,
          turnId: turn.turnId, principalId: turn.principalId, brainId: options.brainId, accountIdentity: account, operation } : null;
        const receipt = await ctx.record(event, inverse);
        if (!receipt || !Number.isSafeInteger(receipt.eventId) || receipt.inverseId !== inverseId) throw new Error("Google decision did not commit");
        audit.decisionEventId = receipt.eventId;
        return true;
      } catch (cause) { report(`Google decision recording failed: ${String(cause)}`); return false; }
    };
    const refused = async (failure: GoogleError, verdict: "declined" | "refused" = "refused") =>
      refuse(await record(verdict) ? failure : recordingUnavailable);
    /** After the admission committed but before any dispatch: record the refusal and drop the inverse nothing can need. */
    const withdraw = async (failure: GoogleError) => {
      if (committedInverse) {
        const id = committedInverse;
        committedInverse = null;
        await cleanup("Google undispatched inverse withdrawal", () => options.state.withdrawInverse(sessionId, id));
      }
      return refused(failure);
    };
    const preparedKey = (p: PreparedGoogleWrite) => canonical({ operation: p.operation, input: p.input, payload: p.card.payload,
      facts: p.facts, classificationFacts: p.classificationFacts, precondition: p.inverse?.precondition, sendLock: p.sendLock });
    const prepare = async () => {
      const p = await factory(turn, call);
      if (p.operation !== operation || canonical(p.input) !== canonical(call.input) || p.card.operation !== operation) throw new Error("Google prepared operation mismatch");
      return p;
    };
    try {
      // Invalidation runs even on a refused call; a later restoration never revives a grant.
      try { await options.allowances.reconcile(allowanceContext()); }
      catch (cause) { storageFailure("session_allowances", "reconcile", cause); }
      // Ownership and policy availability precede every pre-read.
      decision = decide("recipient_unproven");
      if (decision.outcome === "refused" && decision.step <= 2) return await refused(decision.error);
      let failure = live();
      if (failure) return await refused(failure);
      releaseAlias = await aliasLock.acquire(alias, { signal: ctx.signal });
      const identity = await options.resolveAccount(alias);
      if (!identity.ok) return await refused(identity.error);
      account = identity.value; resolved = true;
      held = await lock.acquire(account, { signal: ctx.signal });
      releaseAlias(); releaseAlias = undefined;
      try { await options.allowances.reconcile(allowanceContext()); }
      catch (cause) { storageFailure("session_allowances", "reconcile", cause); }
      failure = live();
      if (failure) return await refused(failure);
      const draft = "draft_id" in call.input ? call.input.draft_id : undefined;
      if (draft && options.isDraftLocked(account, draft, hostEpoch, now())) return await refused(gogError("draft_locked", "draft_locked"));
      prepared = await prepare();
      const routed = await turn.routing("google");
      failure = live();
      if (failure) return await refused(failure);
      const decidedSafety = ctx.safety();
      decision = decide(routed ?? "allowed");
      if (decision.outcome === "refused") return await refused(decision.error);
      card = GOOGLE_MAIL_APPROVAL_SCHEMA.parse({ ...prepared.card, operation, effect: decision.effect, tainted: decision.tainted,
        entities: decision.entities, offers: decision.outcome === "needs_card" ? decision.offers : { allow_always: false, allow_for_session: false } });
      if (decision.outcome === "needs_card") {
        pinned = decidedSafety;
        // The approval frame must reach the owner byte for byte; replication shrinks oversized frames.
        if (new TextEncoder().encode(JSON.stringify(card)).length > GOOGLE_APPROVAL_CARD_BYTES) {
          return await refused(error("card_too_large", "This change is too large to show exactly on one approval card. Nothing was sent.", "draft_not_displayable"));
        }
        if (prepared.sendLock) {
          const at = now();
          let acquired: "acquired" | "draft_locked";
          try {
            acquired = await options.state.acquireSendLock({ sessionId, turnId: turn.turnId, principalId: turn.principalId, brainId: options.brainId,
              account, cardId, draftId: prepared.sendLock, hostEpoch, createdAt: at, expiresAt: at + 24 * 60 * 60_000 });
          } catch (cause) {
            // The lock may have committed with its reply lost: release this card's own row so the draft is not wedged.
            await cleanup("Google card lock release", () => options.state.releaseSendLock(sessionId, cardId));
            throw cause;
          }
          if (acquired !== "acquired") return await refused(gogError("draft_locked", "draft_locked"));
          sendLocked = true;
        }
        held(); held = undefined;
        let answer: PermissionDecision, releaseFailed = false;
        try {
          answer = await ctx.requestPermission({ kind: "google", toolUseId: cardId, toolName: ctx.toolName(call.tool), input: structuredClone(card),
            description: `Approve this ${decision.effect} Google change exactly as shown, once.` });
        } finally {
          if (sendLocked) {
            try { await options.state.releaseSendLock(sessionId, cardId); }
            catch (cause) {
              report(`Google card lock release failed: ${String(cause)}`); releaseFailed = true;
              retryCleanup("Google card lock release", () => options.state.releaseSendLock(sessionId, cardId));
            }
            sendLocked = false;
          }
        }
        if (releaseFailed) return await refused(stateUnavailable);
        const edited = answer.behavior === "allow" && answer.updatedInput !== undefined && canonical(answer.updatedInput) !== canonical(card);
        if (answer.behavior !== "allow" || edited) return await refused(error(edited ? "edited" : "declined", "This Google change was declined; nothing was sent.", "approval_declined"), "declined");
        if ((answer.always && !card.offers.allow_always) || (answer.forSession && !card.offers.allow_for_session) || (answer.always && answer.forSession))
          return await refused(error("standing_choice_unavailable", "This standing choice is not offered by this card; nothing was sent.", "approval_declined"), "declined");
        grant = answer.always ? "always" : answer.forSession ? "session" : undefined;
        held = await lock.acquire(account, { signal: ctx.signal });
        failure = live();
        if (failure) return await refused(failure);
        const refreshed = await prepare();
        if (preparedKey(refreshed) !== preparedKey(prepared)) return await refused(error("prepared_changed", "The prepared change no longer matches the approved card; call again."));
        prepared = refreshed;
      } else admission = decision.admission;
      // Fresh routing and safety under the account lock, immediately before recording.
      const safetyBeforeRouting = ctx.safety();
      const freshRouting = await turn.routing("google");
      failure = live();
      if (failure) return await refused(failure);
      if (!sameSafetyAdmission(safetyBeforeRouting, ctx.safety())) return await refused(stale);
      if (admission !== "card") {
        decision = decide(freshRouting ?? "allowed");
        if (decision.outcome !== "admitted") return await refused(decision.outcome === "refused" ? decision.error : stale);
        admission = decision.admission;
      }
      // The decision function never admits an irreversible write without its card; never record or send one that way.
      if (decision.effect !== "reversible" && admission !== "card") return await refused(error("card_required", "An irreversible Google change needs its exact card; nothing was sent."));
      const dispatchSafety = ctx.safety();
      if (!await record(admission === "card" ? "approved" : "allowed")) {
        // The commit may have landed with its reply lost; nothing will dispatch, so nothing can need its inverse.
        if (inverseId) { const id = inverseId; await cleanup("Google undispatched inverse withdrawal", () => options.state.withdrawInverse(sessionId, id)); }
        // Best effort: if the admission did land, the refusal that follows it lands too. Nothing dispatches either way.
        await record("refused");
        return refuse(recordingUnavailable);
      }
      committedInverse = inverseId;
      // Persist only a checked, unedited screen answer, after the decision committed.
      failure = live();
      if (failure) return await withdraw(failure);
      try {
        if (grant === "always") options.ledger().remember(approvalScope(), operation, decision.entities, now());
        if (grant === "session") await options.allowances.grant(allowanceContext(), operation, decision.entities, cardId);
        if (admission === "session_allowance") reserved = await options.allowances.reserve(allowanceContext(), operation, decision.entities, decision.items!);
      } catch (cause) {
        storageFailure(grant === "always" ? "remembered_approvals" : "session_allowances", grant ? "grant" : "reserve", cause);
        throw cause;
      }
      // Last await before execute. The owner can still repoint the alias between this read and gog's spawn (#4213).
      const latestIdentity = await options.resolveAccount(alias);
      if (!latestIdentity.ok) return await withdraw(latestIdentity.error);
      if (latestIdentity.value !== account) return await withdraw(error("account_changed", "The Google account changed; call again for a fresh decision.", "unavailable"));
      let finalError: GoogleError | null = null, settled = false;
      const finalAdmission = (): GoogleError | null => {
        if (dispatched) return error("already_dispatched", "This Google change already used its admission.");
        // A transport that kept the callback past its own answer can never dispatch late.
        if (settled) return error("admission_closed", "This Google change's admission closed when its call ended; nothing was sent.");
        finalError = live();
        if (!finalError && !sameSafetyAdmission(dispatchSafety, ctx.safety())) finalError = stale;
        if (!finalError && admission !== "card") {
          const current = decide(ctx.routingNow());
          if (current.outcome !== "admitted") finalError = current.outcome === "refused" ? current.error : stale;
        }
        if (finalError) return finalError;
        if (admission !== "card") counts.set(ctx, (counts.get(ctx) ?? 0) + (decision?.items ?? 0));
        dispatched = true;
        return null;
      };
      // No retries. The concrete operation owns the last synchronous spawn check.
      let outcome: Awaited<ReturnType<PreparedGoogleWrite["execute"]>>;
      try { outcome = await prepared.execute(finalAdmission); } finally { settled = true; }
      if (finalError) return await withdraw(finalError);
      if (!dispatched) return await withdraw(error("missing_admission", "The prepared write did not reach final admission."));
      if (!outcome.ok) {
        if (inverseId) { const id = inverseId; await cleanup("Google inverse unknown marking", () => options.state.markInverseUnknown(sessionId, id)); }
        const ambiguous = outcome.error.code === "outcome_unknown" || outcome.error.code === "upstream_error" || ctx.signal.aborted;
        return refuse(ambiguous ? gogError("outcome_unknown", outcome.error.reason ?? "dispatch_failed") : outcome.error);
      }
      const result = GOOGLE_WRITE_SUCCESS_SCHEMA.parse({ ok: true, tool: call.tool, operation, effect: decision.effect, admission, result: outcome.result });
      if (inverseId) await options.state.confirmInverse(sessionId, inverseId, outcome.inverseResult);
      return result;
    } catch (cause) {
      report(`Google write failed: ${String(cause)}`);
      if (dispatched) {
        if (inverseId) { const id = inverseId; await cleanup("Google inverse unknown marking", () => options.state.markInverseUnknown(sessionId, id)); }
        return refuse(gogError("outcome_unknown", "dispatch_failed"));
      }
      return await withdraw(ctx.signal.aborted ? cancelled : error("state_unavailable", "Google write preparation or state failed; nothing was sent.", "unavailable"));
    } finally { releaseAlias?.(); held?.(); }
  };
  return Object.assign(write, { close: () => { closed = true; for (const timer of retries) clearTimeout(timer); retries.clear(); } });
}

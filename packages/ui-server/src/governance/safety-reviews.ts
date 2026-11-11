/** Host-only verdict persistence. The browser service stamps live authority;
 * this module mounts no route and never infers a human from a caller body. */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { safetyReviewBodySchema as bodySchema } from "@schlessera/brain-ui-sdk/schemas";
import { isUsablePrincipal, resolvePrincipal, type Principal } from "../db/principals.js";
import { sameAccount } from "../middleware/account-partition.js";
import { assertLive, ChatRetiredError } from "../ws/chat-lifecycle.js";
import { advance as advanceSafetyRevision, safetyProjection, safetyScopeTurns, SafetyUnavailable, type SafetyProjection } from "./safety-store.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export type SafetyReviewBody = z.infer<typeof bodySchema>;
/** Stamped by the host after authority checks, never read from a browser body. */
export type SafetyReviewAuthority = Pick<Principal, "id" | "kind" | "authMethod" | "credentialId" | "createdAt" | "expiresAt"> & { brainKey: string };
export interface SafetyReviewer {
  principalId: string; channel: "owner_history" | "owner_settings";
  /** Only the password-mode browser service supplies this host-owned epoch.
   * Legacy host-only storage callers do not establish human authority. */
  authority?: SafetyReviewAuthority;
}
export interface SafetyReviewReceipt {
  version: 1; requestId: string | null; operationId: string | null;
  session: SafetyReviewBody["session"]; occurrenceId: string;
  stage: "prepared" | "verdict_committed" | "refused";
  verdict: "unresolved" | "committed"; projection: SafetyProjection | null;
  reason: string | null;
}
interface RequestRow {
  id: string; operation_id: string; session_id: string; history_owner_id: string; generation: string;
  occurrence_id: string; principal_id: string; channel: string; body_hash: string;
  issued_at: number; expires_at: number; terminal_at: number | null; receipt: string;
}
const REQUEST_MS = 900000, RECEIPT_MS = 86400000, RECEIPT_BYTES = 262144;
function clock(now: () => number): number {
  const at = now();
  if (!Number.isSafeInteger(at) || at < 0 || at > Number.MAX_SAFE_INTEGER - RECEIPT_MS) throw new SafetyUnavailable("Invalid safety review clock");
  return at;
}
function reviewer(actor: SafetyReviewer): void {
  if (!id.safeParse(actor.principalId).success || !["owner_history", "owner_settings"].includes(actor.channel)) throw new SafetyUnavailable("Invalid host reviewer");
}
function fingerprint(body: SafetyReviewBody, actor: SafetyReviewer): string {
  // Schema parsing pins object/key order; semantically identical JSON retries
  // do not depend on the caller's property insertion order.
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(actor.authority ? { body, authority: actor.authority } : body)).digest("hex");
}
function authorized(db: Database, actor: SafetyReviewer, at: number): boolean {
  if (!actor.authority) return true;
  const current = resolvePrincipal(db, actor.principalId), epoch = actor.authority;
  return /^[A-Za-z0-9_-]{22}$/.test(epoch.brainKey) && !!current && current.id === epoch.id && current.kind === "owner" && epoch.kind === "owner"
    && ["password", "passkey"].includes(current.authMethod) && current.authMethod === epoch.authMethod
    && current.createdAt === epoch.createdAt && current.expiresAt === epoch.expiresAt
    && current.credentialId === epoch.credentialId && isUsablePrincipal(current, at);
}
function receipt(body: SafetyReviewBody, requestId: string | null, operationId: string | null, reason: string | null,
  projection: SafetyProjection | null, committed = false): SafetyReviewReceipt {
  return { version: 1, requestId, operationId, session: body.session, occurrenceId: body.occurrenceId,
    stage: committed ? "verdict_committed" : reason ? "refused" : "prepared",
    verdict: committed ? "committed" : "unresolved", projection, reason };
}
/** Unknown/foreign identity never creates a session or reveals its projection.
 * A chat belongs to its account: any owner login reviews it (#3952). */
export function safetyReviewTarget(db: Database, body: SafetyReviewBody, principalId: string): "retired" | "unavailable" | null {
  const s = db.query(`SELECT principal_id FROM safety_sessions WHERE session_id=? AND history_owner_id=? AND generation=?`)
    .get(body.session.sessionId, body.session.historyOwnerId, body.session.historyGeneration) as { principal_id: string | null } | null;
  if (!s || !sameAccount(db, s.principal_id, principalId)) return "unavailable";
  const canonical = (db.query("SELECT owner_id FROM dialogue_aliases WHERE id=?").get(body.session.historyOwnerId) as {owner_id:string}|null)?.owner_id ?? body.session.historyOwnerId;
  try { assertLive(db, [["session", body.session.sessionId], ["dialogue_owner", body.session.historyOwnerId], ["dialogue_owner",canonical]]); }
  catch (error) { if (error instanceof ChatRetiredError) return "retired"; throw error; }
  const owner = db.query("SELECT generation,principal_id FROM dialogue_owners WHERE id=?").get(canonical) as { generation: number; principal_id: string } | null;
  if (owner && (String(owner.generation) !== body.session.historyGeneration || !sameAccount(db, owner.principal_id, principalId))) return "unavailable";
  return null;
}
function eligible(db: Database, body: SafetyReviewBody, actor: SafetyReviewer): string | null {
  const r = db.query(`SELECT c.turn_id,c.principal_id,c.generation,r.state,COALESCE((SELECT x.state FROM safety_records x
    WHERE x.occurrence_id=r.id AND x.kind='exposure' ORDER BY length(x.sequence) DESC,x.sequence DESC LIMIT 1),r.state) final_state
    FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id
    WHERE r.id=? AND r.kind='occurrence'`)
    .get(body.occurrenceId) as { turn_id: string; principal_id: string | null; generation: string; final_state: string } | null;
  // The aggregate also includes adopted provisional collections. Use its
  // canonical membership; a direct session_id filter strands those events.
  if (!r || !sameAccount(db, r.principal_id, actor.principalId) || r.generation !== body.session.historyGeneration || !safetyScopeTurns(db, null, body.session.sessionId).has(r.turn_id)
    || db.query("SELECT 1 FROM safety_retired_turns WHERE turn_id=?").get(r.turn_id)) return "unavailable";
  if (db.query("SELECT 1 FROM safety_decisions WHERE occurrence_id=?").get(body.occurrenceId)) return "already_resolved";
  return r.final_state === "finalized" ? null : "not_finalized";
}
/** Pruning cannot turn an expired handle into a fresh mutation: commit never
 * accepts an unknown ID. Retirement uses permanent lifecycle fences instead. */
function prune(db: Database, at: number): void {
  db.query(`DELETE FROM safety_review_requests WHERE
    (terminal_at IS NOT NULL AND terminal_at<=?) OR (terminal_at IS NULL AND expires_at<=?)`).run(at - RECEIPT_MS, at - RECEIPT_MS);
}
export function prepareSafetyReview(db: Database, value: SafetyReviewBody, actor: SafetyReviewer, now: () => number = Date.now): SafetyReviewReceipt {
  const body = bodySchema.parse(value); reviewer(actor);
  return db.transaction(() => {
    // The writer queue and BEGIN IMMEDIATE may both wait. Time belongs to
    // this acquired transaction, never to submission on the app connection.
    const observedAt = clock(now);
    if (!authorized(db, actor, observedAt)) return receipt(body, null, null, "unauthorized", null);
    const reason = safetyReviewTarget(db, body, actor.principalId);
    if (reason) return receipt(body, null, null, reason, null);
    prune(db, observedAt);
    const totals = db.query(`SELECT COUNT(*) n,COALESCE(SUM(reserved_bytes),0) bytes,
      COALESCE(SUM(terminal_at IS NULL AND expires_at>?),0) pending,
      COALESCE(SUM(principal_id=? AND terminal_at IS NULL AND expires_at>?),0) own FROM safety_review_requests`)
      .get(observedAt, actor.principalId, observedAt) as { n: number; bytes: number; pending: number; own: number };
    if (totals.n >= 10000 || totals.bytes + RECEIPT_BYTES > 16777216 || totals.pending >= 256 || totals.own >= 32)
      return receipt(body, null, null, "capacity", null);
    const requestId = crypto.randomUUID(), operationId = crypto.randomUUID();
    const projection = safetyProjection(db, null, body.session.sessionId);
    const problem = eligible(db, body, actor) ?? (projection.evidenceRevision !== body.expectedEvidenceRevision ? "stale_revision" : null);
    const at = clock(now);
    if (!authorized(db, actor, at)) return receipt(body, null, null, "unauthorized", null);
    const result = receipt(body, requestId, operationId, problem, problem ? null : projection);
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) > RECEIPT_BYTES) throw new SafetyUnavailable("Safety review receipt capacity");
    db.query("INSERT INTO safety_review_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(requestId, operationId,
      body.session.sessionId, body.session.historyOwnerId, body.session.historyGeneration, body.occurrenceId,
      actor.principalId, actor.channel, fingerprint(body, actor), at, at + REQUEST_MS, problem ? at : null, json, RECEIPT_BYTES);
    return result;
  }).immediate();
}
export function commitSafetyReview(db: Database, requestId: string, value: SafetyReviewBody, actor: SafetyReviewer,
  locallyPending: boolean, locallyFailed: boolean = false, now: () => number = Date.now): SafetyReviewReceipt {
  const body = bodySchema.parse(value); id.parse(requestId); reviewer(actor);
  return db.transaction(() => {
    if (actor.authority && !authorized(db, actor, clock(now))) return receipt(body, requestId, null, "unauthorized", null);
    // Retirement and exact host ownership precede even successful receipt replay.
    const invalid = safetyReviewTarget(db, body, actor.principalId);
    if (invalid) return receipt(body, requestId, null, invalid, null);
    const row = db.query("SELECT * FROM safety_review_requests WHERE id=?").get(requestId) as RequestRow | null;
    if (!row || row.principal_id !== actor.principalId || row.channel !== actor.channel)
      return receipt(body, requestId, null, "unavailable", null);
    if (row.body_hash !== fingerprint(body, actor)) return receipt(body, requestId, row.operation_id, "request_conflict", null);
    if (row.terminal_at !== null) {
      if (clock(now) >= row.terminal_at + RECEIPT_MS) return receipt(body, requestId, row.operation_id, "request_expired", null);
      return JSON.parse(row.receipt) as SafetyReviewReceipt;
    }
    let projection = safetyProjection(db, null, body.session.sessionId);
    const eligibility = eligible(db, body, actor), at = clock(now);
    const reason = !authorized(db, actor, at) ? "unauthorized" : at < row.issued_at || at >= row.expires_at ? "request_expired" : eligibility
      ?? (locallyFailed || projection.reasons.some(r => r === "recording_failed" || r === "capacity") ? "recording_failed" : null)
      ?? (locallyPending || projection.pendingCount ? "recording_pending" : null)
      ?? (projection.evidenceRevision !== body.expectedEvidenceRevision ? "stale_revision" : null);
    if (!reason) {
      // Each occurrence prepaid this one decision's row/bytes. No capacity
      // check can consume that reserve and prevent reviewing a retained event.
      db.query("INSERT INTO safety_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), body.occurrenceId,
        body.session.sessionId, body.session.historyOwnerId, body.session.historyGeneration, advanceSafetyRevision(db),
        actor.principalId, requestId, at, "safe", actor.channel);
      projection = safetyProjection(db, null, body.session.sessionId);
    }
    const result = receipt(body, requestId, row.operation_id, reason, reason ? null : projection, !reason);
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) > RECEIPT_BYTES) throw new SafetyUnavailable("Safety review receipt capacity");
    // Receipt retention starts when the terminal result is stored, including
    // the projection work after a decision. A clock correction cannot shorten it.
    db.query("UPDATE safety_review_requests SET terminal_at=?,receipt=? WHERE id=?").run(Math.max(at, clock(now)), json, requestId);
    return result;
  }).immediate();
}

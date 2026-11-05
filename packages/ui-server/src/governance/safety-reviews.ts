/** Host-only verdict persistence. The owner-authenticated transport is a later
 * layer: nothing here mounts a route, infers a human, or advertises review. */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { assertLive, ChatRetiredError } from "../ws/chat-lifecycle.js";
import { advance as advanceSafetyRevision, safetyProjection, SafetyUnavailable, type SafetyProjection } from "./safety-store.js";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 18446744073709551615n);
const session = z.object({ sessionId: id, historyOwnerId: id, historyGeneration: revision }).strict();
const bodySchema = z.object({ version: z.literal(1), session, occurrenceId: id,
  expectedEvidenceRevision: revision, verdict: z.literal("safe") }).strict();
export type SafetyReviewBody = z.infer<typeof bodySchema>;
/** Stamped by the host after authority checks, never read from a browser body. */
export interface SafetyReviewer { principalId: string; channel: "owner_history" | "owner_settings" }
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
function fingerprint(body: SafetyReviewBody): string {
  // Schema parsing pins object/key order; semantically identical JSON retries
  // do not depend on the caller's property insertion order.
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(body)).digest("hex");
}
function receipt(body: SafetyReviewBody, requestId: string | null, operationId: string | null, reason: string | null,
  projection: SafetyProjection | null, committed = false): SafetyReviewReceipt {
  return { version: 1, requestId, operationId, session: body.session, occurrenceId: body.occurrenceId,
    stage: committed ? "verdict_committed" : reason ? "refused" : "prepared",
    verdict: committed ? "committed" : "unresolved", projection, reason };
}
/** Unknown/foreign identity never creates a session or reveals its projection. */
function target(db: Database, body: SafetyReviewBody, actor: SafetyReviewer): "retired" | "unavailable" | null {
  const s = db.query(`SELECT principal_id FROM safety_sessions WHERE session_id=? AND history_owner_id=? AND generation=?`)
    .get(body.session.sessionId, body.session.historyOwnerId, body.session.historyGeneration) as { principal_id: string | null } | null;
  if (!s || s.principal_id !== actor.principalId) return "unavailable";
  try { assertLive(db, [["session", body.session.sessionId], ["dialogue_owner", body.session.historyOwnerId]]); }
  catch (error) { if (error instanceof ChatRetiredError) return "retired"; throw error; }
  const owner = db.query("SELECT generation,principal_id FROM dialogue_owners WHERE id=?").get(body.session.historyOwnerId) as { generation: number; principal_id: string } | null;
  if (owner && (String(owner.generation) !== body.session.historyGeneration || owner.principal_id !== actor.principalId)) return "unavailable";
  return null;
}
function eligible(db: Database, body: SafetyReviewBody): string | null {
  const r = db.query(`SELECT r.state,COALESCE((SELECT x.state FROM safety_records x
    WHERE x.occurrence_id=r.id AND x.kind='exposure' ORDER BY length(x.sequence) DESC,x.sequence DESC LIMIT 1),r.state) final_state
    FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id
    WHERE r.id=? AND r.kind='occurrence' AND c.session_id=? AND c.history_owner_id=? AND c.generation=?`)
    .get(body.occurrenceId, body.session.sessionId, body.session.historyOwnerId, body.session.historyGeneration) as { final_state: string } | null;
  if (!r) return "unavailable";
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
    const reason = target(db, body, actor);
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
    const problem = eligible(db, body) ?? (projection.evidenceRevision !== body.expectedEvidenceRevision ? "stale_revision" : null);
    const at = clock(now);
    const result = receipt(body, requestId, operationId, problem, problem ? null : projection);
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json) > RECEIPT_BYTES) throw new SafetyUnavailable("Safety review receipt capacity");
    db.query("INSERT INTO safety_review_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(requestId, operationId,
      body.session.sessionId, body.session.historyOwnerId, body.session.historyGeneration, body.occurrenceId,
      actor.principalId, actor.channel, fingerprint(body), at, at + REQUEST_MS, problem ? at : null, json, RECEIPT_BYTES);
    return result;
  }).immediate();
}
export function commitSafetyReview(db: Database, requestId: string, value: SafetyReviewBody, actor: SafetyReviewer,
  locallyPending: boolean, locallyFailed: boolean = false, now: () => number = Date.now): SafetyReviewReceipt {
  const body = bodySchema.parse(value); id.parse(requestId); reviewer(actor);
  return db.transaction(() => {
    // Retirement and exact host ownership precede even successful receipt replay.
    const invalid = target(db, body, actor);
    if (invalid) return receipt(body, requestId, null, invalid, null);
    const row = db.query("SELECT * FROM safety_review_requests WHERE id=?").get(requestId) as RequestRow | null;
    if (!row || row.principal_id !== actor.principalId || row.channel !== actor.channel)
      return receipt(body, requestId, null, "unavailable", null);
    if (row.body_hash !== fingerprint(body)) return receipt(body, requestId, row.operation_id, "request_conflict", null);
    if (row.terminal_at !== null) {
      if (clock(now) >= row.terminal_at + RECEIPT_MS) return receipt(body, requestId, row.operation_id, "request_expired", null);
      return JSON.parse(row.receipt) as SafetyReviewReceipt;
    }
    let projection = safetyProjection(db, null, body.session.sessionId);
    const eligibility = eligible(db, body), at = clock(now);
    const reason = at < row.issued_at || at >= row.expires_at ? "request_expired" : eligibility
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

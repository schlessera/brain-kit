/** Browser-only authority around the host's existing immutable verdict store. */
import { Database } from "bun:sqlite";
import { SAFETY_READ_CAPABILITIES, type SafetyCapabilities, type SafetyReviewBody, type SafetyReviewResponse } from "@schlessera/brain-ui-sdk/protocol";
import { safetyProjectionSchema, safetyReviewResponseSchema } from "@schlessera/brain-ui-sdk/schemas";
import { isUsablePrincipal, resolvePrincipal, type Principal } from "../db/principals.js";
import type { AuthMode } from "../middleware/auth.js";
import type { GovernanceWrites } from "./event-writes.js";
import { safetyReviewTarget, type SafetyReviewAuthority, type SafetyReviewer } from "./safety-reviews.js";

export class OwnerSafetyUnavailable extends Error {
  constructor(readonly code: "unauthorized" | "unavailable" | "capacity") { super(code); }
}
function epoch(p: Principal, brainKey: string): SafetyReviewAuthority {
  return { id:p.id, kind:p.kind, authMethod:p.authMethod, credentialId:p.credentialId, createdAt:p.createdAt, expiresAt:p.expiresAt, brainKey };
}

export class OwnerSafetyReviews {
  private readonly pending = new Map<string, number>();
  constructor(private readonly db: Database, private readonly writes: GovernanceWrites, private readonly mode: AuthMode, private readonly brainKey: string) {}

  authorized(principal: Principal): boolean {
    if (this.mode !== "password" || principal.kind !== "owner" || !["password","passkey"].includes(principal.authMethod)) return false;
    const current = resolvePrincipal(this.db, principal.id);
    return !!current && JSON.stringify(epoch(current,this.brainKey)) === JSON.stringify(epoch(principal,this.brainKey)) && isUsablePrincipal(current, Date.now());
  }
  capabilities(principal: Principal): SafetyCapabilities {
    const review = this.authorized(principal);
    return { ...SAFETY_READ_CAPABILITIES, review, readOnlyReason:review ? null : "owner_required",
      limits:{ ...SAFETY_READ_CAPABILITIES.limits, reviewBodyBytes:16384, reviewLifetimeMs:900000, receiptLifetimeMs:86400000 } };
  }
  private current(principal: Principal, body: SafetyReviewBody) {
    if (!this.authorized(principal)) throw new OwnerSafetyUnavailable("unauthorized");
    if (safetyReviewTarget(this.db,body,principal.id)) throw new OwnerSafetyUnavailable("unavailable");
    return this.writes.safety(null, body.session.sessionId);
  }
  delivery(principal: Principal, body: SafetyReviewBody) {
    return safetyProjectionSchema.parse(Database.prototype.transaction.call(this.db, ()=>this.current(principal,body)).deferred());
  }
  async review(principal: Principal, body: SafetyReviewBody, requestId: string | null): Promise<SafetyReviewResponse> {
    this.delivery(principal, body);
    const count = this.pending.get(principal.id) ?? 0;
    if (count >= 32 || [...this.pending.values()].reduce((a,b)=>a+b,0) >= 256) throw new OwnerSafetyUnavailable("capacity");
    this.pending.set(principal.id, count + 1);
    try {
      const actor: SafetyReviewer = { principalId:principal.id, channel:"owner_history", authority:epoch(principal,this.brainKey) };
      // The worker checks this epoch against its live principal row inside the
      // acquired transaction, before even a terminal receipt can be replayed.
      const receipt = requestId === null ? await this.writes.safetyPrepareReview(body, actor)
        : await this.writes.safetyCommitReview(requestId, body, actor);
      const currentProjection = this.delivery(principal,body);
      return safetyReviewResponseSchema.parse({version:1,receipt,currentProjection});
    } finally {
      const left = this.pending.get(principal.id)! - 1;
      if (left) this.pending.set(principal.id,left); else this.pending.delete(principal.id);
    }
  }
}

/** Session-owned Google state. These concrete ui.db procedures settle after commit;
 * neither an audit failure nor an inverse failure changes the safety projection. */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { GOOGLE_OPERATIONS, GMAIL_DRAFT_ID_PATTERN } from "@schlessera/brain-common/internal/google-operations";
import { procedureCaller, type SqliteWriter } from "../db/write-worker.js";
import { assertLive } from "../ws/chat-lifecycle.js";
import { governanceEventRow, insertGovernanceEvent, type GovernanceEventInput } from "../governance/events.js";

const id = z.string().min(1).max(2048);
const clock = z.number().int().nonnegative();
const scope = { sessionId: id, turnId: id, principalId: id, brainId: id };
const sendLockSchema = z.strictObject({ ...scope, cardId: id, account: id,
  draftId: z.string().regex(GMAIL_DRAFT_ID_PATTERN), hostEpoch: id, createdAt: clock, expiresAt: clock,
}).refine(value => value.expiresAt > value.createdAt, "lock must expire after creation");
export type GoogleSendLock = z.infer<typeof sendLockSchema>;
/** Storage envelope only. Operation implementations construct and validate concrete
 * inverse/precondition objects; prepared and unknown records must never execute. */
const inverseSchema = z.strictObject({ ...scope, inverseId: z.string().min(1).max(128), callId: z.string().min(1).max(128),
  accountIdentity: id, operation: z.enum(GOOGLE_OPERATIONS),
  inverse: z.record(z.string(), z.unknown()), precondition: z.record(z.string(), z.unknown()),
  snapshot: z.instanceof(Uint8Array).nullable(), createdAt: clock, expiresAt: clock,
}).refine(value => value.expiresAt > value.createdAt && value.expiresAt <= value.createdAt +
  (value.operation === "gmail.trash" ? 2_592_000_000 : 604_800_000), "inverse lifetime exceeded");
export type GoogleInversePrepared = z.infer<typeof inverseSchema>;
const inverseResultSchema = z.strictObject({ id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export type GoogleInverseResult = z.infer<typeof inverseResultSchema>;
export type GoogleDecisionEvent = GovernanceEventInput<"outward_action"> | GovernanceEventInput<"google_reversible_action">;
export const url = import.meta.url;

export function setup(db: Database) {
  const live = (sessionId: string) => {
    id.parse(sessionId);
    assertLive(db, [["session", sessionId]]);
    if (!db.query("SELECT 1 FROM sessions WHERE id=?").get(sessionId)) throw new Error("Google state requires a persisted session");
  };
  return {
    acquireSendLock: (input: GoogleSendLock): "acquired" | "draft_locked" => db.transaction(() => {
      const lock = sendLockSchema.parse(input);
      live(lock.sessionId);
      // Expiry is evaluated on the writer's clock, never on a caller's old card time.
      const now = Date.now();
      if (lock.expiresAt <= now) throw new Error("Google send lock already expired");
      db.query(`DELETE FROM google_send_locks WHERE brain_id=? AND account=? AND draft_id=?
        AND (host_epoch<>? OR expires_at<=?)`).run(lock.brainId, lock.account, lock.draftId, lock.hostEpoch, now);
      const existing = db.query("SELECT session_id,card_id FROM google_send_locks WHERE brain_id=? AND account=? AND draft_id=?")
        .get(lock.brainId, lock.account, lock.draftId) as { session_id: string; card_id: string } | null;
      if (existing) return existing.session_id === lock.sessionId && existing.card_id === lock.cardId ? "acquired" : "draft_locked";
      db.query(`INSERT INTO google_send_locks
        (session_id,card_id,turn_id,principal_id,brain_id,account,draft_id,host_epoch,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(lock.sessionId, lock.cardId, lock.turnId, lock.principalId, lock.brainId, lock.account,
          lock.draftId, lock.hostEpoch, lock.createdAt, lock.expiresAt);
      return "acquired";
    }).immediate(),
    // Owner-matched cleanup also runs for a retired chat, so a card that ends with its chat never leaves a retry loop.
    releaseSendLock: (sessionId: string, cardId: string, requireLive = false): void => db.transaction(() => {
      id.parse(sessionId); id.parse(cardId);
      if (requireLive && !db.query("SELECT 1 FROM google_send_locks WHERE session_id=? AND card_id=? AND expires_at>?").get(sessionId, cardId, Date.now()))
        throw new Error("Google send card lost its live lock");
      db.query("DELETE FROM google_send_locks WHERE session_id=? AND card_id=?").run(sessionId, cardId);
    }).immediate(),
    // Cleanup is intentionally allowed for retired sessions too, like chat cleanup.
    clearSendLocksAtHostStart: (): void => db.transaction(() => { db.query("DELETE FROM google_send_locks").run(); }).immediate(),
    commitGoogleDecision: (event: GoogleDecisionEvent, rawInverse: GoogleInversePrepared | null) => db.transaction(() => {
      if (event.kind !== "google_reversible_action" && !(event.kind === "outward_action" && event.payload.action === "google_write")) {
        throw new Error("Expected a Google decision");
      }
      if (!event.sessionId || !event.turnId) throw new Error("Google decision requires session and turn");
      live(event.sessionId);
      const row = governanceEventRow(event);
      const inverse = rawInverse === null ? null : inverseSchema.parse(rawInverse);
      const required = event.kind === "google_reversible_action" && ["allowed", "approved"].includes(event.payload.decision);
      const draftSnapshot = event.kind === "outward_action" && event.payload.decision === "approved" && event.payload.google?.operation === "gmail.draft.save";
      if ((required && !inverse) || (inverse && !required && !draftSnapshot)) throw new Error("Google decision inverse mismatch");
      if (inverse && (inverse.sessionId !== event.sessionId || inverse.turnId !== event.turnId || (event.kind === "google_reversible_action"
          ? inverse.callId !== event.payload.callId || inverse.inverseId !== event.payload.inverseId || inverse.operation !== event.payload.operation
          : inverse.callId !== event.payload.google?.callId || inverse.operation !== event.payload.google?.operation))) {
        throw new Error("Google inverse attribution mismatch");
      }
      // Even a deduplicated event is not permission to repeat a dispatch.
      const stored = insertGovernanceEvent(db, row);
      if (!stored.recorded) throw new Error("Google decision already committed");
      if (inverse) db.query(`INSERT INTO google_inverses
        (session_id,inverse_id,call_id,turn_id,principal_id,brain_id,account_identity,operation,decision_event_id,state,
         inverse_json,precondition_json,snapshot,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,'prepared',?,?,?,?,?)`)
        .run(inverse.sessionId, inverse.inverseId, inverse.callId, inverse.turnId, inverse.principalId, inverse.brainId, inverse.accountIdentity,
          inverse.operation, stored.id, JSON.stringify(inverse.inverse), JSON.stringify(inverse.precondition), inverse.snapshot, inverse.createdAt, inverse.expiresAt);
      return { eventId: stored.id, inverseId: inverse?.inverseId ?? null };
    }).immediate(),
    confirmInverse: (sessionId: string, inverseId: string, rawResult?: GoogleInverseResult): void => db.transaction(() => {
      live(sessionId); id.parse(inverseId);
      const result = rawResult === undefined ? null : inverseResultSchema.parse(rawResult);
      if (!result && (db.query("SELECT operation FROM google_inverses WHERE session_id=? AND inverse_id=?").get(sessionId, inverseId) as { operation: string } | null)?.operation !== "gmail.modify") {
        throw new Error("Google create/update confirmation requires its returned identity and fingerprint");
      }
      const changed = db.query(`UPDATE google_inverses SET state='confirmed',
        inverse_json=CASE WHEN ? IS NULL THEN inverse_json ELSE json_set(inverse_json,'$.result',json(?)) END WHERE session_id=? AND inverse_id=? AND state='prepared' AND expires_at>?`)
        .run(result === null ? null : JSON.stringify(result), JSON.stringify(result), sessionId, inverseId, Date.now());
      if (changed.changes !== 1) throw new Error("Google inverse is not prepared and live");
    }).immediate(),
    /** A recorded admission whose write never reached dispatch leaves nothing to undo. */
    withdrawInverse: (sessionId: string, inverseId: string): number => db.transaction(() => {
      id.parse(sessionId); id.parse(inverseId);
      return db.query("DELETE FROM google_inverses WHERE session_id=? AND inverse_id=? AND state='prepared'").run(sessionId, inverseId).changes;
    }).immediate(),
    // Downgrade only: it cannot resurrect a retired chat's rows, so its retry never loops on one.
    markInverseUnknown: (sessionId: string, inverseId: string): void => db.transaction(() => {
      id.parse(sessionId); id.parse(inverseId);
      db.query("UPDATE google_inverses SET state='unknown' WHERE session_id=? AND inverse_id=?").run(sessionId, inverseId);
    }).immediate(),
    pruneExpiredInverses: (now: number): number => db.transaction(() => {
      clock.parse(now);
      // Removal cannot resurrect authority or content; it also cleans retired leftovers.
      return db.query("DELETE FROM google_inverses WHERE expires_at<=?").run(now).changes;
    }).immediate(),
  };
}

export function createGoogleStateWrites(db: Database, writer?: SqliteWriter) {
  const call = procedureCaller(db, { url, setup }, undefined, writer);
  const invoke = <K extends keyof ReturnType<typeof setup>>(name: K, ...args: Parameters<ReturnType<typeof setup>[K]>) =>
    call<ReturnType<ReturnType<typeof setup>[K]>>(name, ...args);
  return {
    acquireSendLock: (lock: GoogleSendLock) => invoke("acquireSendLock", lock),
    releaseSendLock: (sessionId: string, cardId: string, requireLive = false) => invoke("releaseSendLock", sessionId, cardId, requireLive),
    clearSendLocksAtHostStart: () => invoke("clearSendLocksAtHostStart"),
    commitGoogleDecision: (event: GoogleDecisionEvent, inverse: GoogleInversePrepared | null) => invoke("commitGoogleDecision", event, inverse),
    confirmInverse: (sessionId: string, inverseId: string, result?: GoogleInverseResult) => invoke("confirmInverse", sessionId, inverseId, result),
    withdrawInverse: (sessionId: string, inverseId: string) => invoke("withdrawInverse", sessionId, inverseId),
    markInverseUnknown: (sessionId: string, inverseId: string) => invoke("markInverseUnknown", sessionId, inverseId),
    pruneExpiredInverses: (now: number) => invoke("pruneExpiredInverses", now),
  };
}

/** Only a current, live card owns a draft; old epochs never confer authority. */
export function isDraftSendLocked(db: Database, brainId: string, account: string, draftId: string, hostEpoch: string, now: number): boolean {
  return !!db.query(`SELECT 1 FROM google_send_locks WHERE brain_id=? AND account=? AND draft_id=? AND host_epoch=? AND expires_at>?`)
    .get(brainId, account, draftId, hostEpoch, now);
}

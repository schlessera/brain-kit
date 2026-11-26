/** Session authority only. Never copied by catalog handoff/fork/import. */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { GOOGLE_OPERATIONS, GOOGLE_SESSION_ALLOWANCE_LIMITS, type GoogleOperation } from "@schlessera/brain-common/internal/google-operations";
import { procedureCaller, type SqliteWriter } from "../db/write-worker.js";
import { assertLive } from "../ws/chat-lifecycle.js";

const id = z.string().min(1).max(2048);
const contextSchema = z.strictObject({ sessionId: id, principalId: id, brainId: id, accountIdentity: id,
  hostEpoch: id, policyHash: id, now: z.number().int().nonnegative(), tainted: z.boolean(), authorized: z.boolean() });
export type GoogleAllowanceContext = z.infer<typeof contextSchema>;
export interface GoogleAllowanceRow {
  session_id: string; principal_id: string; brain_id: string; account_identity: string;
  operation: GoogleOperation; entity: string; host_epoch: string; policy_hash: string;
  granted_card_id: string; granted_at: number; expires_at: number; remaining_items: number;
}
const scope = (c: GoogleAllowanceContext) => [c.sessionId, c.principalId, c.brainId, c.accountIdentity] as const;
const where = "session_id=? AND principal_id=? AND brain_id=? AND account_identity=?";
const liveWhere = `${where} AND host_epoch=? AND policy_hash=? AND expires_at>?`;
function read(db: Database, raw: GoogleAllowanceContext): GoogleAllowanceRow[] {
  const c = contextSchema.parse(raw);
  if (!c.tainted || !c.authorized) return [];
  assertLive(db, [["session", c.sessionId]]);
  return db.query<GoogleAllowanceRow, (string | number)[]>(`SELECT * FROM google_session_allowances WHERE ${liveWhere}`)
    .all(...scope(c), c.hostEpoch, c.policyHash, c.now);
}
function currentPrincipal(db: Database, c: GoogleAllowanceContext): boolean {
  return c.authorized && !!db.query(`SELECT 1 FROM principals WHERE id=? AND kind IN ('owner','ambient')
    AND revoked_at IS NULL AND expires_at>?`).get(c.principalId, Date.now());
}
export const url = import.meta.url;
export function setup(db: Database) {
  const reconcile = (raw: GoogleAllowanceContext) => {
    const c = contextSchema.parse(raw);
    // Remove rather than hide: restoration of a previous policy/taint state cannot revive a grant.
    db.query(`DELETE FROM google_session_allowances WHERE brain_id=? AND (host_epoch<>? OR policy_hash<>? OR expires_at<=?
      OR (principal_id=? AND ?=0) OR (session_id=? AND ?=0))`)
      .run(c.brainId, c.hostEpoch, c.policyHash, c.now, c.principalId, +c.authorized, c.sessionId, +c.tainted);
  };
  return {
    reconcile: (c: GoogleAllowanceContext): void => db.transaction(() => reconcile(c)).immediate(),
    grant: (raw: GoogleAllowanceContext, operation: GoogleOperation, entities: string[], cardId: string): void => db.transaction(() => {
      const c = contextSchema.parse(raw); z.enum(GOOGLE_OPERATIONS).parse(operation); z.array(id).min(1).max(100).parse(entities); id.parse(cardId);
      reconcile(c);
      if (!currentPrincipal(db, c) || !c.tainted) throw new Error("Google allowance requires current tainted owner authority");
      assertLive(db, [["session", c.sessionId]]);
      for (const entity of new Set(entities)) db.query(`INSERT INTO google_session_allowances
        (session_id,principal_id,brain_id,account_identity,operation,entity,host_epoch,policy_hash,granted_card_id,granted_at,expires_at,remaining_items)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,principal_id,brain_id,account_identity,operation,entity)
        DO UPDATE SET host_epoch=excluded.host_epoch,policy_hash=excluded.policy_hash,granted_card_id=excluded.granted_card_id,
          granted_at=excluded.granted_at,expires_at=excluded.expires_at,remaining_items=excluded.remaining_items`)
        .run(...scope(c), operation, entity, c.hostEpoch, c.policyHash, cardId, c.now,
          c.now + GOOGLE_SESSION_ALLOWANCE_LIMITS.lifetimeMs, GOOGLE_SESSION_ALLOWANCE_LIMITS.items);
    }).immediate(),
    reserve: (c: GoogleAllowanceContext, operation: GoogleOperation, entities: string[], items: number): GoogleAllowanceRow[] => db.transaction(() => {
      reconcile(c);
      if (!currentPrincipal(db, c)) throw new Error("Google allowance principal is no longer current");
      z.number().int().min(1).max(GOOGLE_SESSION_ALLOWANCE_LIMITS.items).parse(items);
      z.enum(GOOGLE_OPERATIONS).parse(operation); z.array(id).min(1).max(100).parse(entities);
      const rows = read(db, c).filter(row => row.operation === operation && entities.includes(row.entity));
      if (new Set(rows.map(row => row.entity)).size !== new Set(entities).size || rows.some(row => row.remaining_items < items)) throw new Error("Google session allowance expired, revoked or exhausted");
      for (const cardId of new Set(rows.map(row => row.granted_card_id))) db.query(`UPDATE google_session_allowances SET remaining_items=remaining_items-?
        WHERE session_id=? AND principal_id=? AND brain_id=? AND granted_card_id=?`)
        .run(items, c.sessionId, c.principalId, c.brainId, cardId);
      // Conservative charge: a later refusal or uncertain dispatch never refunds it.
      return rows;
    }).immediate(),
    revoke: (sessionId: string, principalId: string, brainId: string, cardId: string): boolean => {
      for (const value of [sessionId, principalId, brainId, cardId]) id.parse(value);
      return db.query(`DELETE FROM google_session_allowances WHERE session_id=? AND principal_id=? AND brain_id=? AND granted_card_id=?`)
        .run(sessionId, principalId, brainId, cardId).changes > 0;
    },
  };
}
export function createGoogleAllowances(db: Database, writer?: SqliteWriter) {
  const call = procedureCaller(db, { url, setup }, undefined, writer);
  return {
    read: (c: GoogleAllowanceContext) => read(db, c),
    reconcile: (c: GoogleAllowanceContext) => call<void>("reconcile", c),
    grant: (c: GoogleAllowanceContext, operation: GoogleOperation, entities: string[], cardId: string) => call<void>("grant", c, operation, entities, cardId),
    reserve: (c: GoogleAllowanceContext, operation: GoogleOperation, entities: string[], items: number) => call<GoogleAllowanceRow[]>("reserve", c, operation, entities, items),
    revoke: (sessionId: string, principalId: string, brainId: string, cardId: string) => call<boolean>("revoke", sessionId, principalId, brainId, cardId),
    list: (sessionId: string, principalId: string, brainId: string, hostEpoch: string, policyHash: string, now: number) =>
      db.query<GoogleAllowanceRow, (string | number)[]>(`SELECT * FROM google_session_allowances WHERE session_id=? AND principal_id=? AND brain_id=?
        AND host_epoch=? AND policy_hash=? AND expires_at>? ORDER BY granted_at,entity`).all(sessionId, principalId, brainId, hostEpoch, policyHash, now),
  };
}

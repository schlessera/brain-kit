/**
 * Session worker-profile writes off the event loop (#2850). A session's
 * profile row references its catalog row, which commits on the `ui.db` write
 * worker once `session_info` names the session; binding a draft's preference
 * and recording the admitted profile commit there too, after it, at
 * `synchronous=FULL`, and so does a saved preference.
 */
import type { Database } from "bun:sqlite";

import type { WireError, WriteProcedures } from "../db/write-worker.js";
import { SESSION_DRAFT_LIMITS } from "@schlessera/brain-ui-sdk/protocol";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";

export const url = import.meta.url;

type Profile = "governed" | "strict";

export class SessionProfileError extends Error {
  constructor(readonly status: 400 | 401 | 404 | 409 | 507, message: string) { super(message); }
}

export function authorizeProfile(db: Database, principalId: string, now: number) {
  const principal = resolvePrincipal(db, principalId);
  if (!principal || !isUsablePrincipal(principal, now)) throw new SessionProfileError(401, "Authentication required.");
}

export function draftProfile(db: Database, principalId: string, id: string) {
  return db.query("SELECT preference FROM draft_worker_profiles WHERE principal_id = ? AND draft_id = ?").get(principalId, id) as { preference: Profile } | null;
}

/** A new session takes its draft's preference; the draft is consumed. */
export function bindDraftProfile(db: Database, principalId: string, draftId: string, sessionId: string, now: number) {
  db.transaction(() => {
    authorizeProfile(db, principalId, now);
    if (!db.query("SELECT 1 FROM sessions WHERE id = ?").get(sessionId)) throw new SessionProfileError(404, "This chat is not known to the host.");
    const row = draftProfile(db, principalId, draftId);
    if (!row) throw new SessionProfileError(409, "This draft preference is unavailable.");
    // A save during the first turn is for its NEXT admission; the running profile stays frozen.
    db.query("INSERT INTO session_worker_profiles (session_id, preference, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING")
      .run(sessionId, row.preference, now, principalId);
    db.query("DELETE FROM draft_worker_profiles WHERE principal_id = ? AND draft_id = ?").run(principalId, draftId);
  }).immediate();
}

/** The profile a session's latest turn was admitted with. */
export function recordSessionProfile(db: Database, sessionId: string, origin: "interactive" | "voice", actualProfile: Profile, now: number) {
  db.query("INSERT INTO session_worker_profiles (session_id, preference, updated_at, updated_by, origin, actual_profile) VALUES (?, 'governed', ?, 'host', ?, ?) ON CONFLICT(session_id) DO UPDATE SET origin = excluded.origin, actual_profile = excluded.actual_profile")
    .run(sessionId, now, origin, actualProfile);
}

/**
 * A principal's saved preference for a session or a draft, checked and
 * stored in one transaction. `policyProfiles` is the brain's policy profile
 * for each origin, resolved where the request arrived.
 */
export function saveProfile(db: Database, principalId: string, kind: "session" | "draft", id: string, preference: Profile,
  policyProfiles: Record<"interactive" | "voice", Profile>, now: number) {
  db.transaction(() => {
    authorizeProfile(db, principalId, now);
    let origin: "interactive" | "voice" = "interactive";
    if (kind === "session") {
      if (!db.query("SELECT 1 FROM sessions WHERE id = ?").get(id)) throw new SessionProfileError(404, "This chat is not known to the host.");
      const row = db.query("SELECT origin FROM session_worker_profiles WHERE session_id = ?").get(id) as { origin: "interactive" | "voice" } | null;
      origin = row?.origin ?? "interactive";
    }
    if (origin === "voice") throw new SessionProfileError(409, "Voice uses this brain's policy.");
    if (preference === "governed" && policyProfiles[origin] === "strict") throw new SessionProfileError(409, "Set by this brain's policy.");
    if (kind === "session") {
      db.query("INSERT INTO session_worker_profiles (session_id, preference, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET preference = excluded.preference, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
        .run(id, preference, now, principalId);
    } else {
      // Expired principals cannot use their old preferences; bounded cleanup does not evict a live confirmed choice.
      db.query("DELETE FROM draft_worker_profiles WHERE principal_id NOT IN (SELECT id FROM principals WHERE revoked_at IS NULL AND expires_at > ?)").run(now);
      if (!draftProfile(db, principalId, id) && (db.query("SELECT COUNT(*) AS n FROM draft_worker_profiles").get() as { n: number }).n >= SESSION_DRAFT_LIMITS.maxDrafts)
        throw new SessionProfileError(507, "The host cannot keep another draft preference yet.");
      db.query("INSERT INTO draft_worker_profiles (principal_id, draft_id, preference, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(principal_id, draft_id) DO UPDATE SET preference = excluded.preference, updated_at = excluded.updated_at")
        .run(principalId, id, preference, now);
    }
  }).immediate();
}

/** A refusal keeps its class and status across the worker. */
export function reviveProfileError(error: WireError): Error | undefined {
  return error.name === "SessionProfileError" ? new SessionProfileError(error.fields.status as SessionProfileError["status"], error.message) : undefined;
}

export function setup(db: Database): WriteProcedures {
  return {
    save: (principalId: string, kind: "session" | "draft", id: string, preference: Profile, policyProfiles: Record<"interactive" | "voice", Profile>, now: number) =>
      saveProfile(db, principalId, kind, id, preference, policyProfiles, now),
    bind: (principalId: string, draftId: string, sessionId: string, now: number) => bindDraftProfile(db, principalId, draftId, sessionId, now),
    record: (sessionId: string, origin: "interactive" | "voice", actualProfile: Profile, now: number) => recordSessionProfile(db, sessionId, origin, actualProfile, now),
  };
}

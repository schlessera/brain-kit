/**
 * Session worker-profile writes off the event loop (#2850). A session's
 * profile row references its catalog row, which commits on the `ui.db` write
 * worker once `session_info` names the session; binding a draft's preference
 * and recording the admitted profile commit there too, after it, at
 * `synchronous=FULL`. A saved preference stays an app-connection write.
 */
import type { Database } from "bun:sqlite";

import type { WriteProcedures } from "../db/write-worker.js";
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

export function setup(db: Database): WriteProcedures {
  return {
    bind: (principalId: string, draftId: string, sessionId: string, now: number) => bindDraftProfile(db, principalId, draftId, sessionId, now),
    record: (sessionId: string, origin: "interactive" | "voice", actualProfile: Profile, now: number) => recordSessionProfile(db, sessionId, origin, actualProfile, now),
  };
}

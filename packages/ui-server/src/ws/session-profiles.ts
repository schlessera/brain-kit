/** Authenticated preferences only; admission independently enforces its frozen policy. */
import { scopeLimits } from "../brain/turn-scope.js";
import type { Database } from "bun:sqlite";
import { SESSION_DRAFT_LIMITS, type SessionWorkerProfile } from "@schlessera/brain-ui-sdk/protocol";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import type { GovernedTurns } from "../brain/governed-turn.js";

type Profile = "governed" | "strict";
export class SessionProfileError extends Error {
  constructor(readonly status: 400 | 401 | 404 | 409 | 507, message: string) { super(message); }
}
export function createSessionProfiles(db: Database, turns: GovernedTurns, budgets?: import("../brain/turn-budgets.js").TurnBudgets, limits?: { hardTimeoutMs: () => number }) {
  const authorize = (principalId: string) => {
    const principal = resolvePrincipal(db, principalId);
    if (!principal || !isUsablePrincipal(principal, Date.now())) throw new SessionProfileError(401, "Authentication required.");
  };
  const session = (id: string) => {
    if (!db.query("SELECT 1 FROM sessions WHERE id = ?").get(id)) throw new SessionProfileError(404, "This chat is not known to the host.");
    return db.query("SELECT preference, actual_profile AS actualProfile, origin FROM session_worker_profiles WHERE session_id = ?").get(id) as { preference: Profile; actualProfile: Profile | null; origin: "interactive" | "voice" } | null;
  };
  const draft = (principalId: string, id: string) => db.query("SELECT preference FROM draft_worker_profiles WHERE principal_id = ? AND draft_id = ?").get(principalId, id) as { preference: Profile } | null;
  const facts = (preference: Profile, origin: "interactive" | "voice", actualProfile?: Profile): SessionWorkerProfile => {
    const resolved = turns.facts(origin);
    const caps = scopeLimits(resolved.policy.policy);
    return { preference, policyProfile: resolved.policyProfile, policyHash: resolved.policy.hash, origin,
      ...(actualProfile ? { actualProfile } : {}),
      // Only the concrete mounted budget control supplies these enforced next-admission facts.
      limits: [{ name: "Latest admitted worker", value: actualProfile ?? "Unknown" },
        ...(budgets ? (["turn","session","day"] as const).map(scope=>({name:`${scope === "day" ? "UTC day" : scope === "session" ? "Conversation lifetime" : "Turn"} inference budget`,
          value:`Warn $${resolved.policy.policy.budgets[scope].warn_usd}; stop $${resolved.policy.policy.budgets[scope].block_usd}; unpriced token stop ${resolved.policy.policy.budgets[scope].block_tokens.toLocaleString()}`,
          onHit:scope === "session" ? "Review partial work and continue with a reviewed new-conversation handoff; day balance remains." : scope === "day" ? "Stops until the server's next UTC midnight; review partial work." : "Stops this turn; review partial work."})) : [{name:"Inference budgets",value:"Unknown"}]),
        { name: "Per-turn scope", value: `${caps.tool_calls} tool calls · ${caps.minutes} min · ${caps.files_changed} distinct changed paths · ${formatScopeBytes(caps.turn_bytes)} observed bytes` },
        { name: "Independent hard timeout", value: limits ? `${limits.hardTimeoutMs() / 60_000} min` : "Unknown" },
        { name: "Scope authority", value: "One finite grant per dimension; disk floor max(5%, 2 GiB) is Stop only. Independent hard timeout, resource and storage limits also apply." }, { name: "Network recording", value: "Unknown" }] };
  };
  const read = (principalId: string, kind: "session" | "draft", id: string): SessionWorkerProfile => {
    authorize(principalId);
    if (kind === "session") {
      const row = session(id);
      return facts(row?.preference ?? "governed", row?.origin ?? "interactive", row?.actualProfile ?? undefined);
    }
    const row = draft(principalId, id);
    return { ...facts(row?.preference ?? "governed", "interactive"), draftPreferenceStored: Boolean(row) };
  };
  return {
    read,
    save(principalId: string, kind: "session" | "draft", id: string, preference: Profile) {
      return db.transaction(() => {
        const current = read(principalId, kind, id);
        if (current.origin === "voice") throw new SessionProfileError(409, "Voice uses this brain's policy.");
        if (preference === "governed" && current.policyProfile === "strict") throw new SessionProfileError(409, "Set by this brain's policy.");
        if (kind === "session") {
          db.query("INSERT INTO session_worker_profiles (session_id, preference, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET preference = excluded.preference, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
            .run(id, preference, Date.now(), principalId);
        } else {
          // Expired principals cannot use their old preferences; bounded cleanup does not evict a live confirmed choice.
          db.query("DELETE FROM draft_worker_profiles WHERE principal_id NOT IN (SELECT id FROM principals WHERE revoked_at IS NULL AND expires_at > ?)").run(Date.now());
          if (!draft(principalId, id) && (db.query("SELECT COUNT(*) AS n FROM draft_worker_profiles").get() as { n: number }).n >= SESSION_DRAFT_LIMITS.maxDrafts)
            throw new SessionProfileError(507, "The host cannot keep another draft preference yet.");
          db.query("INSERT INTO draft_worker_profiles (principal_id, draft_id, preference, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(principal_id, draft_id) DO UPDATE SET preference = excluded.preference, updated_at = excluded.updated_at")
            .run(principalId, id, preference, Date.now());
        }
        return read(principalId, kind, id);
      }).immediate();
    },
    preference(principalId: string, sessionId?: string, draftId?: string): Profile | undefined {
      authorize(principalId);
      if (sessionId) return session(sessionId)?.preference;
      if (!draftId) return undefined;
      const row = draft(principalId, draftId);
      if (!row) throw new SessionProfileError(409, "This draft preference is unavailable. Refresh before sending.");
      return row.preference;
    },
    bind(principalId: string, draftId: string, sessionId: string) {
      db.transaction(() => {
        authorize(principalId); session(sessionId);
        const row = draft(principalId, draftId);
        if (!row) throw new SessionProfileError(409, "This draft preference is unavailable.");
        // A save during the first turn is for its NEXT admission; the running profile stays frozen.
        db.query("INSERT INTO session_worker_profiles (session_id, preference, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING")
          .run(sessionId, row.preference, Date.now(), principalId);
        db.query("DELETE FROM draft_worker_profiles WHERE principal_id = ? AND draft_id = ?").run(principalId, draftId);
      }).immediate();
    },
    record(sessionId: string, origin: "interactive" | "voice", actualProfile: Profile) {
      db.query("INSERT INTO session_worker_profiles (session_id, preference, updated_at, updated_by, origin, actual_profile) VALUES (?, 'governed', ?, 'host', ?, ?) ON CONFLICT(session_id) DO UPDATE SET origin = excluded.origin, actual_profile = excluded.actual_profile")
        .run(sessionId, Date.now(), origin, actualProfile);
    },
  };
}
export type SessionProfiles = ReturnType<typeof createSessionProfiles>;

function formatScopeBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const unit = bytes < 1024 ? 0 : Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  return `${Number((bytes / 1024 ** unit).toFixed(2))} ${units[unit]}`;
}

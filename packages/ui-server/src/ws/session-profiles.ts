/** Authenticated preferences only; admission independently enforces its frozen policy. */
import { scopeLimits } from "../brain/turn-scope.js";
import type { Database } from "bun:sqlite";
import type { SessionWorkerProfile } from "@schlessera/brain-ui-sdk/protocol";
import type { GovernedTurns } from "../brain/governed-turn.js";
import { procedureCaller, type SqliteWriter } from "../db/write-worker.js";
import * as writes from "./session-profile-writes.js";
import { authorizeProfile, draftProfile, SessionProfileError } from "./session-profile-writes.js";

export { SessionProfileError };

type Profile = "governed" | "strict";
type SessionRow = { preference: Profile; actualProfile: Profile | null; origin: "interactive" | "voice" };
type Effect = { bind: Profile } | { record: { origin: "interactive" | "voice"; actualProfile: Profile } };

export function createSessionProfiles(db: Database, turns: GovernedTurns, budgets?: import("../brain/turn-budgets.js").TurnBudgets, limits?: { hardTimeoutMs: () => number },
  /**
   * Where a session's bind and record commit: the app's write worker
   * (#2850), after the catalog row they reference. `catalog` answers whether
   * a session's row exists, its pending row included, and when the
   * catalog's writes have settled.
   */
  options: { writer?: SqliteWriter; catalog?: { hasSession?(sessionId: string): boolean; settled?(): Promise<void> } } = {}) {
  const authorize = (principalId: string) => authorizeProfile(db, principalId, Date.now());
  const submit = procedureCaller(db, writes, undefined, options.writer, writes.reviveProfileError);
  // Each session's submitted, unsettled bind and record, in order. Both are
  // idempotent over the row they produce, so a read applies them to the
  // committed row whether or not they have landed yet.
  const pending = new Map<string, Effect[]>();
  let tail: Promise<void> = Promise.resolve();
  const write = (sessionId: string, effect: Effect, name: string, ...args: unknown[]) => {
    const effects = pending.get(sessionId) ?? [];
    effects.push(effect);
    pending.set(sessionId, effects);
    const done = submit(name, ...args);
    tail = done.then(() => {}, () => {});
    void tail.then(() => {
      effects.splice(effects.indexOf(effect), 1);
      if (effects.length === 0 && pending.get(sessionId) === effects) pending.delete(sessionId);
    });
    return done;
  };
  const exists = (id: string) => options.catalog?.hasSession?.(id) ?? db.query("SELECT 1 FROM sessions WHERE id = ?").get(id) !== null;
  const session = (id: string) => {
    if (!exists(id)) throw new SessionProfileError(404, "This chat is not known to the host.");
    let row = db.query("SELECT preference, actual_profile AS actualProfile, origin FROM session_worker_profiles WHERE session_id = ?").get(id) as SessionRow | null;
    for (const effect of pending.get(id) ?? []) {
      if ("bind" in effect) row ??= { preference: effect.bind, actualProfile: null, origin: "interactive" };
      else row = row ? { ...row, ...effect.record } : { preference: "governed", ...effect.record };
    }
    return row;
  };
  // A bind consumes its draft: once submitted, the draft reads as gone.
  const consumed = new Set<string>();
  const draft = (principalId: string, id: string) => consumed.has(JSON.stringify([principalId, id])) ? null : draftProfile(db, principalId, id);
  /** Settles once every bind and record submitted before it, and the catalog rows they need, have settled. */
  const settled = async () => {
    await options.catalog?.settled?.();
    let waiting: Promise<void>;
    do { waiting = tail; await waiting; } while (waiting !== tail);
  };
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
    settled,
    // A saved preference commits on the write worker too (#2850), after
    // what it reads has settled; the answer is read once it has.
    async save(principalId: string, kind: "session" | "draft", id: string, preference: Profile) {
      await settled();
      const policyProfiles = { interactive: turns.facts("interactive").policyProfile, voice: turns.facts("voice").policyProfile };
      await submit("save", principalId, kind, id, preference, policyProfiles, Date.now());
      return read(principalId, kind, id);
    },
    preference(principalId: string, sessionId?: string, draftId?: string): Profile | undefined {
      authorize(principalId);
      if (sessionId) return session(sessionId)?.preference;
      if (!draftId) return undefined;
      const row = draft(principalId, draftId);
      if (!row) throw new SessionProfileError(409, "This draft preference is unavailable. Refresh before sending.");
      return row.preference;
    },
    /** Checked now, as the inline write did; it commits after the session's row. */
    bind(principalId: string, draftId: string, sessionId: string): Promise<unknown> {
      authorize(principalId); session(sessionId);
      const row = draft(principalId, draftId);
      if (!row) throw new SessionProfileError(409, "This draft preference is unavailable.");
      const key = JSON.stringify([principalId, draftId]);
      consumed.add(key);
      const done = write(sessionId, { bind: row.preference }, "bind", principalId, draftId, sessionId, Date.now());
      void done.then(() => {}, () => {}).then(() => consumed.delete(key));
      return done;
    },
    record(sessionId: string, origin: "interactive" | "voice", actualProfile: Profile): Promise<unknown> {
      return write(sessionId, { record: { origin, actualProfile } }, "record", sessionId, origin, actualProfile, Date.now());
    },
  };
}
export type SessionProfiles = ReturnType<typeof createSessionProfiles>;

function formatScopeBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const unit = bytes < 1024 ? 0 : Math.min(Math.floor(Math.log2(bytes) / 10), units.length - 1);
  return `${Number((bytes / 1024 ** unit).toFixed(2))} ${units[unit]}`;
}

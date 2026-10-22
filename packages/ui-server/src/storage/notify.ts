import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { noticeTimeZone, localHour } from "../inbox/notify.js";
import { processAlive, SELF } from "../brain/writer-gate.js";
import type { StorageHistory } from "./history-store.js";
import { hashScope, RECENT } from "./history-model.js";
export type StorageNoticeOutcome = "accepted" | "failed" | "unknown" | "gone";
export type StorageNoticeState = "pending" | "sending" | "accepted" | "failed" | "unknown" | "suppressed";
interface Receipt { episode: string; endpoint: string; principal_id: string; state: StorageNoticeState; attempts: number; attempted_at: number | null; next_at: number | null; pid: number | null; process_start: string | null }
export interface StorageNoticeAttempt {
  id: string;
  principalId: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  payload: { title: "Storage needs attention."; body: "Open Storage for details."; tag: string; url: "/#/settings/storage" };
}
/** Storage's fixed policy uses the existing subscriptions, timezone reports and transport. */
export function createStorageNotifier(db: Database, history: StorageHistory) {
  const brain = history.brain;
  let lastClock = 0;
  function owner(id: string, now: number) {
    const principal = resolvePrincipal(db, id);
    return principal && ["owner", "ambient"].includes(principal.kind) && isUsablePrincipal(principal, now);
  }
  function reap(now: number) {
    const rows = db.query("SELECT * FROM storage_notice_receipts WHERE brain = ? AND state = 'sending'").all(brain) as Receipt[];
    for (const row of rows) if (!row.pid || !row.process_start || !processAlive(row.pid, row.process_start) || row.attempted_at !== null && now - row.attempted_at >= 60_000) {
      db.query("UPDATE storage_notice_receipts SET state = 'unknown', next_at = NULL, pid = NULL, process_start = NULL WHERE brain = ? AND episode = ? AND endpoint = ? AND state = 'sending'").run(brain, row.episode, row.endpoint);
    }
  }
  function maintain(now: number) {
    reap(now);
    const state = history.read()?.metadata.state;
    if (!state) return;
    const retained = new Set(state.pressures.flatMap(row => [row.episode, row.resolvedEpisode].filter((id): id is string => id !== null)));
    const active = new Set(state.pressures.filter(row => row.severity === "critical" && row.episode).map(row => row.episode!));
    const rows = db.query("SELECT * FROM storage_notice_receipts WHERE brain = ?").all(brain) as Receipt[];
    for (const row of rows) {
      if (!active.has(row.episode) && ["pending", "failed"].includes(row.state)) db.query("UPDATE storage_notice_receipts SET state = 'suppressed', next_at = NULL WHERE brain = ? AND episode = ? AND endpoint = ?").run(brain, row.episode, row.endpoint);
      if (!retained.has(row.episode) && row.state !== "sending") db.query("DELETE FROM storage_notice_receipts WHERE brain = ? AND episode = ? AND endpoint = ?").run(brain, row.episode, row.endpoint);
    }
  }
  return {
    sweep(now = Date.now()) { db.transaction(() => maintain(now)).immediate(); },
    begin(endpoint: string, now = Date.now()): StorageNoticeAttempt | null {
      if (!Number.isSafeInteger(now) || now < lastClock) return null;
      lastClock = now;
      return db.transaction((): StorageNoticeAttempt | null => {
        if (db.query("SELECT 1 FROM inbox_recovery_state WHERE status = 'pending'").get()) return null;
        maintain(now);
        const status = history.status(), payload = status.history;
        if (!payload) return null;
        const state = payload.metadata.state;
        // Another process may have a newer observation waiting for the bounded
        // history write. Never dispatch using the older durable pressure state.
        const scan = db.query("SELECT result_at FROM storage_scan_leases WHERE brain = ?").get(brain) as { result_at: number | null } | null;
        if (scan?.result_at !== null && scan?.result_at !== undefined && scan.result_at > state.lastObservedAt) return null;
        const lastAttempt = db.query("SELECT MAX(attempted_at) AS at FROM storage_notice_receipts WHERE brain = ?").get(brain) as { at: number | null };
        if (state.lastPersistedAt > now || lastAttempt.at !== null && lastAttempt.at > now) return null;
        const sub = db.query("SELECT principal_id, time_zone, p256dh, auth FROM push_subscriptions WHERE endpoint = ?").get(endpoint) as { principal_id: string | null; time_zone: string | null; p256dh: string; auth: string } | null;
        if (!sub?.principal_id || !owner(sub.principal_id, now)) return null;
        const eligible = state.pressures.filter(row => row.severity === "critical" && row.episode && !row.scopeChanged && row.supportAt !== null && row.supportAt <= now && now - row.supportAt <= RECENT && !state.suppressedEpisodes.includes(row.episode));
        for (const row of eligible) db.query("INSERT OR IGNORE INTO storage_notice_receipts (brain, episode, endpoint, principal_id, state) VALUES (?, ?, ?, ?, 'pending')").run(brain, row.episode!, endpoint, sub.principal_id);
        if (status.pending || status.paused && status.paused !== "collection-unavailable") return null;
        if (status.paused === "collection-unavailable" && !eligible.some(row => row.refusals.some(refusal => refusal.at >= state.lastObservedAt))) return null;
        const zone = noticeTimeZone(sub.time_zone);
        if (!zone) return null;
        const hour = localHour(zone, now);
        if (hour >= 22 || hour < 8) return null;
        const included: Receipt[] = [];
        for (const pressure of eligible) {
          const row = db.query("SELECT * FROM storage_notice_receipts WHERE brain = ? AND episode = ? AND endpoint = ?").get(brain, pressure.episode!, endpoint) as Receipt;
          if (row.principal_id !== sub.principal_id) {
            if (["pending", "failed"].includes(row.state)) db.query("UPDATE storage_notice_receipts SET state = 'suppressed', next_at = NULL WHERE brain = ? AND episode = ? AND endpoint = ?").run(brain, row.episode, endpoint);
            continue;
          }
          if (row.attempts >= 3 || !["pending", "failed"].includes(row.state) || row.attempts > 0 && row.next_at === null || row.next_at !== null && row.next_at > now || row.attempted_at !== null && row.attempted_at > now) continue;
          included.push(row);
        }
        if (!included.length) return null;
        const id = randomUUID();
        for (const row of included) db.query("UPDATE storage_notice_receipts SET state = 'sending', attempts = attempts + 1, attempted_at = ?, next_at = NULL, batch_id = ?, pid = ?, process_start = ? WHERE brain = ? AND episode = ? AND endpoint = ?").run(now, id, SELF.pid, SELF.start, brain, row.episode, endpoint);
        return { id, principalId: sub.principal_id, subscription: { endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload: { title: "Storage needs attention.", body: "Open Storage for details.", tag: `brain-storage:${hashScope(included.map(row => row.episode).sort())}`, url: "/#/settings/storage" } };
      }).immediate();
    },
    finish(id: string, outcome: StorageNoticeOutcome, now = Date.now()) {
      db.transaction(() => {
        const rows = db.query("SELECT * FROM storage_notice_receipts WHERE brain = ? AND batch_id = ? AND state = 'sending'").all(brain, id) as Receipt[];
        for (const row of rows) {
          const next = outcome === "failed" && row.attempts < 3 ? Math.max(now, row.attempted_at ?? now) + (row.attempts === 1 ? 60_000 : 300_000) : null;
          db.query("UPDATE storage_notice_receipts SET state = ?, next_at = ?, pid = NULL, process_start = NULL WHERE brain = ? AND episode = ? AND endpoint = ? AND batch_id = ? AND state = 'sending'").run(outcome === "gone" ? "suppressed" : outcome, next, brain, row.episode, row.endpoint, id);
        }
      }).immediate();
    },
    receipts(principalId: string, now = Date.now()): Array<{ episode: string; state: StorageNoticeState; attempts: number; nextAt: number | null }> {
      if (!owner(principalId, now)) throw Error("Storage requires current human-owner access.");
      return db.query("SELECT r.episode, r.state, r.attempts, r.next_at AS nextAt FROM storage_notice_receipts r JOIN push_subscriptions s ON s.endpoint = r.endpoint WHERE r.brain = ? AND s.principal_id = ? AND r.principal_id = ? ORDER BY r.episode, r.endpoint LIMIT 201").all(brain, principalId, principalId) as Array<{ episode: string; state: StorageNoticeState; attempts: number; nextAt: number | null }>;
    },
  };
}
export type StorageNotifier = ReturnType<typeof createStorageNotifier>;

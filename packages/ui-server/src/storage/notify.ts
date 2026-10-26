import type { Database } from "bun:sqlite";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { SELF } from "../brain/writer-gate.js";
import type { StorageHistory } from "./history-store.js";
import { procedureCaller, type SqliteWriter } from "../db/write-worker.js";
import * as noticeWrites from "./notify-writes.js";
export type StorageNoticeOutcome = "accepted" | "failed" | "unknown" | "gone";
export type StorageNoticeState = "pending" | "sending" | "accepted" | "failed" | "unknown" | "suppressed";
export interface Receipt { episode: string; endpoint: string; principal_id: string; state: StorageNoticeState; attempts: number; attempted_at: number | null; next_at: number | null; pid: number | null; process_start: string | null }
export interface StorageNoticeAttempt {
  id: string;
  principalId: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  payload: { title: "Storage needs attention."; body: "Open Storage for details."; tag: string; url: "/#/settings/storage" };
}
/** Storage's fixed policy uses the existing subscriptions, timezone reports and transport. */
export function createStorageNotifier(db: Database, history: StorageHistory, writer?: SqliteWriter) {
  const brain = history.brain;
  let lastClock = 0;
  function owner(id: string, now: number) {
    const principal = resolvePrincipal(db, id);
    return principal && ["owner", "ambient"].includes(principal.kind) && isUsablePrincipal(principal, now);
  }
  const options = { brain, self: { pid: SELF.pid, start: SELF.start } };
  const procedures = writer ? null : noticeWrites.setup(db, options, history.read);
  const call = writer ? procedureCaller(db, noticeWrites, options, writer) : null;
  return {
    sweep(now = Date.now()) { return call ? call<void>("sweep", now) : procedures!.sweep(now); },
    begin(endpoint: string, now = Date.now()): StorageNoticeAttempt | null | Promise<StorageNoticeAttempt | null> {
      if (!Number.isSafeInteger(now) || now < lastClock) return call ? Promise.resolve(null) : null;
      lastClock = now;
      return call ? call<StorageNoticeAttempt | null>("begin", endpoint, now, history.status()) : procedures!.begin(endpoint, now, history.status);
    },
    finish(id: string, outcome: StorageNoticeOutcome, now = Date.now()) {
      return call ? call<void>("finish", id, outcome, now) : procedures!.finish(id, outcome, now);
    },
    receipts(principalId: string, now = Date.now()): Array<{ episode: string; state: StorageNoticeState; attempts: number; nextAt: number | null }> {
      if (!owner(principalId, now)) throw Error("Storage requires current human-owner access.");
      return db.query("SELECT r.episode, r.state, r.attempts, r.next_at AS nextAt FROM storage_notice_receipts r JOIN push_subscriptions s ON s.endpoint = r.endpoint WHERE r.brain = ? AND s.principal_id = ? AND r.principal_id = ? ORDER BY r.episode, r.endpoint LIMIT 201").all(brain, principalId, principalId) as Array<{ episode: string; state: StorageNoticeState; attempts: number; nextAt: number | null }>;
    },
  };
}
export type StorageNotifier = ReturnType<typeof createStorageNotifier>;

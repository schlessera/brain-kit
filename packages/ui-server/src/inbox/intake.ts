import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import { rm } from "node:fs/promises";
import type { ShareIntakeResult } from "@schlessera/brain-ui-sdk/protocol";
import { SHARE_STAGING_DIR, SHARE_STAGING_TTL_MS } from "@schlessera/brain-ui-sdk/protocol";
import { safeResolve } from "../files/walker.js";
import { isUsablePrincipal, resolvePrincipal, type Principal } from "../db/principals.js";
import { createInboxStore } from "./store.js";
import { shareContentHash, stageShareAt, type ShareInput } from "../share/staging.js";

export class IntakeAuthorizationError extends Error {}
export class IntakeKeyConflictError extends Error {}

interface Receipt {
  staging_id: string;
  source: "share" | "cli";
  principal_id: string;
  dedup_key: string;
  content_hash: string;
  state: "preparing" | "committed" | "cleanup";
  result_json: string | null;
}

/** Concrete intake for this UI store. It stages bytes and never dispatches work. */
export function createInboxIntake(db: Database, brainRoot: string, log?: Logger) {
  const store = createInboxStore(db);
  const active = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;

  function authorize(principal: Principal): void {
    const current = resolvePrincipal(db, principal.id);
    if (!current || !isUsablePrincipal(current, Date.now())) throw new IntakeAuthorizationError("Intake credential is no longer usable");
  }
  function committed(key: string): Receipt | null {
    return db.query("SELECT * FROM inbox_intake_receipts WHERE dedup_key = ? AND state = 'committed'").get(key) as Receipt | null;
  }
  async function clean(id: string): Promise<void> {
    // safeResolve and server-only UUIDs prevent compensation touching other files.
    for (const name of [id, `.${id}.partial`]) {
      const path = await safeResolve(`${SHARE_STAGING_DIR}/${name}`, brainRoot);
      await rm(path, { recursive: true, force: true });
    }
    db.query("DELETE FROM inbox_intake_receipts WHERE staging_id = ? AND state = 'cleanup'").run(id);
  }
  async function reconcile(): Promise<void> {
    const rows = db.query("SELECT staging_id FROM inbox_intake_receipts WHERE state = 'cleanup' OR (state = 'preparing' AND reconcile_after <= ?)").all(Date.now()) as { staging_id: string }[];
    for (const { staging_id: id } of rows) {
      if (active.has(id)) continue;
      db.query("UPDATE inbox_intake_receipts SET state = 'cleanup' WHERE staging_id = ? AND state = 'preparing' AND reconcile_after <= ?").run(id, Date.now());
      // Another process may have committed a later row while this sweep awaited
      // cleanup of an earlier one. Never compensate a newly committed receipt.
      const row = db.query("SELECT state FROM inbox_intake_receipts WHERE staging_id = ?").get(id) as { state: string } | null;
      if (row?.state === "cleanup") await clean(id);
    }
  }
  function replay(row: Receipt, hash: string, principal: Principal) {
    return db.transaction(() => {
      authorize(principal);
      if (row.content_hash !== hash) throw new IntakeKeyConflictError("Intake key was already used for different content");
      const result = JSON.parse(row.result_json!) as ShareIntakeResult;
      const work = store.ingest({ threadId: crypto.randomUUID(), itemId: crypto.randomUUID(), source: row.source,
        dedupKey: row.dedup_key, stagingId: row.staging_id, expiresAt: Date.now() + SHARE_STAGING_TTL_MS, stakes: 1 });
      return { result, created: work.created, threadId: work.thread.id, itemId: work.item.id };
    }).immediate();
  }
  async function ingest(source: "share" | "cli", input: ShareInput, principal: Principal, explicitKey?: string) {
    if (closed) throw new Error("Intake is closed");
    authorize(principal);
    await reconcile();
    const hash = await shareContentHash(input);
    const key = source === "share" ? `share:${hash}` : `cli:${explicitKey}`;
    const existing = committed(key);
    if (existing) return replay(existing, hash, principal);
    const id = crypto.randomUUID();
    // Journal BEFORE any file write. A killed writer leaves bounded compensation,
    // never a Queue claim. Other live writers get an hour before reconciliation.
    db.transaction(() => {
      authorize(principal);
      db.query("INSERT INTO inbox_intake_receipts (staging_id, source, principal_id, dedup_key, content_hash, created_at, reconcile_after, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing')")
        .run(id, source, principal.id, key, hash, Date.now(), Date.now() + 60 * 60 * 1000);
    }).immediate();
    active.add(id);
    let accepted = false;
    try {
      const result = await stageShareAt(brainRoot, input, id, log, source === "cli" ? "cli" : "web-share-target");
      const outcome = db.transaction(() => {
        authorize(principal); // revocation may occur during decoding or staging
        const owned = db.query("SELECT state FROM inbox_intake_receipts WHERE staging_id = ?").get(id) as { state: string } | null;
        if (owned?.state !== "preparing") throw new Error("Intake preparation was reconciled");
        const winner = committed(key);
        if (winner) {
          const replayed = replay(winner, hash, principal);
          db.query("UPDATE inbox_intake_receipts SET state = 'cleanup' WHERE staging_id = ?").run(id);
          return replayed;
        }
        const work = store.ingest({ threadId: crypto.randomUUID(), itemId: crypto.randomUUID(), source,
          dedupKey: key, stagingId: id, expiresAt: Date.now() + SHARE_STAGING_TTL_MS, stakes: 1 });
        if (!work.created) throw new Error("Intake receipt is missing for an existing item");
        db.query("UPDATE inbox_intake_receipts SET state = 'committed', item_id = ?, result_json = ? WHERE staging_id = ?")
          .run(work.item.id, JSON.stringify(result), id);
        return { result, created: true, threadId: work.thread.id, itemId: work.item.id };
      }).immediate();
      accepted = outcome.result.id === id;
      if (!accepted) await clean(id);
      return outcome;
    } catch (error) {
      // A committed receipt is never compensated, even if reporting/cleanup fails.
      if (!accepted && committed(key)?.staging_id !== id) {
        db.query("UPDATE inbox_intake_receipts SET state = 'cleanup' WHERE staging_id = ? AND state = 'preparing'").run(id);
        await clean(id).catch(() => {});
      }
      throw error;
    } finally { active.delete(id); }
  }
  function tracked<T>(operation: () => Promise<T>): Promise<T> {
    const task = operation();
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  }
  return {
    share: (input: ShareInput, principal: Principal) => tracked(() => ingest("share", input, principal)),
    cli: (input: ShareInput, key: string, principal: Principal) => tracked(() => ingest("cli", input, principal, key)),
    reconcile,
    protectedIds: () => new Set((db.query("SELECT staging_id FROM inbox_intake_receipts WHERE state != 'cleanup'").all() as { staging_id: string }[]).map(row => row.staging_id)),
    close: async () => { closed = true; await Promise.allSettled([...pending]); },
  };
}

export type InboxIntake = ReturnType<typeof createInboxIntake>;

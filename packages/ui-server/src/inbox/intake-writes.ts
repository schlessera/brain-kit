/** Intake receipt transactions; staging I/O remains with the caller. */
import type { Database } from "bun:sqlite";
import type { ShareIntakeResult } from "@schlessera/brain-ui-sdk/protocol";
import { SHARE_STAGING_TTL_MS } from "@schlessera/brain-ui-sdk/protocol";
import { isUsablePrincipal, resolvePrincipal, type Principal } from "../db/principals.js";
import { procedureCaller, type WriteProcedures, type WireError } from "../db/write-worker.js";
import { inboxWriter } from "./write-runtime.js";
import { createInboxStore } from "./store.js";
import { recordInboxProvenance } from "./provenance.js";

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


export const url = import.meta.url;
export function setup(db: Database): WriteProcedures {
  const store = createInboxStore(db);
  function authorize(principal: Principal, isCurrent?: () => boolean): void {
    if (isCurrent && !isCurrent()) throw new IntakeAuthorizationError("Intake turn is no longer authorized");
    const current = resolvePrincipal(db, principal.id);
    if (!current || !isUsablePrincipal(current, Date.now())) throw new IntakeAuthorizationError("Intake credential is no longer usable");
  }
  function committed(key: string): Receipt | null {
    return db.query("SELECT * FROM inbox_intake_receipts WHERE dedup_key = ? AND state = 'committed'").get(key) as Receipt | null;
  }
  function replay(row: Receipt, hash: string, principal: Principal) {
    return db.transaction(() => {
      authorize(principal);
      if (row.content_hash !== hash) throw new IntakeKeyConflictError("Intake key was already used for different content");
      const result = JSON.parse(row.result_json!) as ShareIntakeResult;
      // Only the intake owner may recover its durable interactive session.
      // Re-upload after a lost admission reply is a read, never another turn.
      if (row.source === "share" && row.principal_id === principal.id) {
        const binding = db.query("SELECT session_id FROM inbox_interactive_shares WHERE staging_id = ? AND principal_id = ?")
          .get(row.staging_id, principal.id) as { session_id: string | null } | null;
        if (binding?.session_id) result.filingSessionId = binding.session_id;
      }
      const work = store.ingest({ threadId: crypto.randomUUID(), itemId: crypto.randomUUID(), source: row.source,
        dedupKey: row.dedup_key, stagingId: row.staging_id, expiresAt: Date.now() + SHARE_STAGING_TTL_MS, stakes: 1 });
      return { result, created: work.created, threadId: work.thread.id, itemId: work.item.id };
    }).immediate();
  }
  return {
    replay,
    prepare(id: string, source: "share" | "cli", principal: Principal, key: string, hash: string) {
      db.transaction(() => {
        authorize(principal);
        db.query("INSERT INTO inbox_intake_receipts (staging_id, source, principal_id, dedup_key, content_hash, created_at, reconcile_after, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing')")
          .run(id, source, principal.id, key, hash, Date.now(), Date.now() + 60 * 60 * 1000);
      }).immediate();
    },
    accept(id: string, source: "share" | "cli", principal: Principal, key: string, hash: string, result: ShareIntakeResult,
      binaryHashes: { path: string | undefined; sha256: string }[], evidence: string | null, author: "person" | { conversationTurn: string } | null) {
      return db.transaction(() => {
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
        db.query("UPDATE inbox_intake_receipts SET state = 'committed', item_id = ?, result_json = ?, binary_hashes_json = ? WHERE staging_id = ?")
          .run(work.item.id, JSON.stringify(result), JSON.stringify(binaryHashes), id);
        if (evidence) recordInboxProvenance(db, { item: work.item.id }, author === "person" ? { origin: "person", evidence }
          : { origin: "conversation", turnId: author!.conversationTurn, evidence });
        return { result, created: true, threadId: work.thread.id, itemId: work.item.id };
      }).immediate();
    },
    clean(id: string) { db.query("DELETE FROM inbox_intake_receipts WHERE staging_id = ? AND state = 'cleanup'").run(id); },
    compensate(id: string) { db.query("UPDATE inbox_intake_receipts SET state = 'cleanup' WHERE staging_id = ? AND state = 'preparing'").run(id); },
    reconcile(id: string, at: number) { db.query("UPDATE inbox_intake_receipts SET state = 'cleanup' WHERE staging_id = ? AND state = 'preparing' AND reconcile_after <= ?").run(id, at); },
  };
}
function revive(error: WireError): Error | undefined {
  if (error.name === "IntakeAuthorizationError") return new IntakeAuthorizationError(error.message);
  if (error.name === "IntakeKeyConflictError") return new IntakeKeyConflictError(error.message);
}
export function inboxIntakeWrites(db: Database) {
  return procedureCaller(db, { url, setup }, undefined, inboxWriter(db), revive);
}

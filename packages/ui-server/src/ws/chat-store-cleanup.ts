/**
 * Host-owned copies of one retired chat (#3230): canonical dialogue, task
 * receipts and result facts, session projections and positively bound drafts.
 * Each store's owner removes its content under the retirement's own intent and
 * confirms removal only by reading back that nothing selected remains.
 * Minimized identity and replay fences stay: chat, alias, conversation, task,
 * request and native-handle identities live in `chat_retired_identities`, and
 * the content-free ledger rows that refuse replays (`retry_receipts`, draft
 * send records, consumed task keys) are kept without their text.
 *
 * Retained on purpose, as independent owners the policy excludes: Activity,
 * Inbox and governance records, turn journals, policy proposals, turn scope,
 * provider-exposure and masking lineage, usage accounting, worker profiles and
 * handoff lineage identifiers. They are disclosed, never claimed removed.
 * Policy: docs/decisions/chat-history-deletion.md.
 */
import type { Database } from "bun:sqlite";
import { identitiesOf, recordChatCleanup, type ChatRetirementStatus, type ChatStore } from "./chat-lifecycle.js";

/** The stores a host owns itself; `native` belongs to the chat's backend. */
export type HostChatStore = Exclude<ChatStore, "native">;
export const HOST_CHAT_STORES: readonly HostChatStore[] = ["dialogue", "tasks", "projections", "drafts"];

/** A fingerprint no request can produce: an old idempotency key now always refuses. */
const RETIRED_FINGERPRINT = "retired";

const marks = (values: readonly string[]) => values.map(() => "?").join(",");
const count = (db: Database, sql: string, values: readonly string[]) =>
  values.length ? (db.query(sql.replace("(?)", `(${marks(values)})`)).get(...values) as { n: number }).n : 0;
const run = (db: Database, sql: string, values: readonly string[], ...before: (string | number)[]) => {
  if (values.length) db.prepare(sql.replace("(?)", `(${marks(values)})`)).run(...before, ...values);
};

/** Session projections that carry readable text, digests of it, or classified copies. */
const PROJECTION_TABLES = ["message_blocks", "classification_confidence", "message_sources", "local_exchanges",
  "retry_requests", "turn_failures", "turn_boundaries", "session_state_room"] as const;

function scrub(db: Database, lifecycleId: string, store: HostChatStore, at: number): number {
  const ids = identitiesOf(db, lifecycleId);
  switch (store) {
    case "dialogue":
      // Owners, aliases and conversations are identities; the records are the text.
      run(db, "DELETE FROM dialogue_records WHERE owner_id IN (?)", ids.dialogueOwners);
      return count(db, "SELECT COUNT(*) AS n FROM dialogue_records WHERE owner_id IN (?)", ids.dialogueOwners);
    case "tasks":
      // Keys stay consumed; the submitted and recognized text and facts go.
      run(db, "UPDATE conversation_tasks SET receipt=NULL,result_facts=NULL WHERE conversation_id IN (?)", ids.conversations);
      return count(db, "SELECT COUNT(*) AS n FROM conversation_tasks WHERE conversation_id IN (?) AND (receipt IS NOT NULL OR result_facts IS NOT NULL)", ids.conversations);
    case "projections": {
      // Safety display/provenance is chat-owned evidence. Negative turn fences
      // and the existing independently owned governance audit remain.
      for(const [column,values] of [["session_id",ids.sessions],["history_owner_id",ids.dialogueOwners]] as const){
        for(const value of values){
          // Request payload digests and receipt projections are chat-owned too.
          // The permanent lifecycle fence refuses even a formerly successful retry.
          db.query(`DELETE FROM safety_review_requests WHERE ${column}=?`).run(value);
          const totals=db.query(`SELECT COALESCE(SUM(r.reserved_rows),0) rows,COALESCE(SUM(r.reserved_bytes),0) bytes FROM safety_records r
            JOIN safety_collections c ON c.id=r.collection_id WHERE c.${column}=?`).get(value) as {rows:number;bytes:number};
          db.query(`DELETE FROM safety_decisions WHERE occurrence_id IN (SELECT r.id FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id WHERE c.${column}=?)`).run(value);
          db.query(`DELETE FROM safety_legacy_events WHERE record_id IN (SELECT r.id FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id WHERE c.${column}=?)`).run(value);
          for(const table of ["safety_records","safety_pending"])db.query(`DELETE FROM ${table} WHERE collection_id IN (SELECT id FROM safety_collections WHERE ${column}=?)`).run(value);
          db.query(`DELETE FROM safety_collections WHERE ${column}=?`).run(value);
          db.query("UPDATE safety_meta SET used_rows=MAX(0,used_rows-?),used_bytes=MAX(0,used_bytes-?) WHERE singleton=1").run(totals.rows,totals.bytes);
        }
      }
      // The catalog row keeps cost, turns, backend and handoff identities.
      run(db, "UPDATE sessions SET title=NULL,label=NULL,label_source=NULL WHERE id IN (?)", ids.sessions);
      for (const table of PROJECTION_TABLES) run(db, `DELETE FROM ${table} WHERE session_id IN (?)`, ids.sessions);
      return count(db, "SELECT COUNT(*) AS n FROM sessions WHERE id IN (?) AND (title IS NOT NULL OR label IS NOT NULL OR label_source IS NOT NULL)", ids.sessions)
        + PROJECTION_TABLES.reduce((sum, table) => sum + count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE session_id IN (?)`, ids.sessions), 0);
    }
    case "drafts": {
      // Only drafts positively bound to a retired session; unbound and other chats' drafts stay.
      const drafts = ids.sessions.length ? (db.query(`SELECT draft_id FROM session_drafts WHERE session_id IN (${marks(ids.sessions)})`)
        .all(...ids.sessions) as { draft_id: string }[]).map(row => row.draft_id) : [];
      const actor = (db.query("SELECT principal_id FROM chat_lifecycles WHERE id=?").get(lifecycleId) as { principal_id: string }).principal_id;
      // A live draft becomes a tombstone at its next revision, so a stale save conflicts.
      run(db, `UPDATE session_drafts SET revision=revision+1,text='',attachment_ids='[]',size_bytes=0,updated_at=?,updated_by=?,deleted_at=?,deleted_reason='deleted'
        WHERE deleted_at IS NULL AND draft_id IN (?)`, drafts, at, actor, at);
      run(db, "UPDATE session_drafts SET text='',attachment_ids='[]',size_bytes=0 WHERE draft_id IN (?)", drafts);
      run(db, "DELETE FROM session_draft_attachments WHERE draft_id IN (?)", drafts);
      run(db, "UPDATE session_draft_receipts SET fingerprint=?,response_json='null' WHERE draft_id IN (?)", drafts, RETIRED_FINGERPRINT);
      return count(db, "SELECT COUNT(*) AS n FROM session_drafts WHERE draft_id IN (?) AND (text!='' OR attachment_ids!='[]' OR deleted_at IS NULL)", drafts)
        + count(db, "SELECT COUNT(*) AS n FROM session_draft_attachments WHERE draft_id IN (?)", drafts)
        + count(db, `SELECT COUNT(*) AS n FROM session_draft_receipts WHERE draft_id IN (?) AND (fingerprint!='${RETIRED_FINGERPRINT}' OR response_json!='null')`, drafts);
    }
  }
}

/**
 * Remove one host store's copies of a retired chat and record the outcome
 * under its intent: `removed` only when the read-back finds nothing selected.
 * Idempotent, and the retry for an interrupted or partial cleanup. A store
 * that was not selected at retirement is refused.
 */
export function cleanChatStore(db: Database, lifecycleId: string, store: HostChatStore, at: number): ChatRetirementStatus {
  if (!HOST_CHAT_STORES.includes(store)) throw new Error("Not a host chat store");
  const selected = db.query("SELECT outcome FROM chat_retirement_stores WHERE lifecycle_id=? AND store=?").get(lifecycleId, store) as { outcome: string } | null;
  if (!selected) throw new Error("Chat cleanup store was not selected");
  let remaining: number;
  try { remaining = db.transaction(() => scrub(db, lifecycleId, store, at)).immediate(); }
  catch { return recordChatCleanup(db, lifecycleId, store, "partial", at); }
  return recordChatCleanup(db, lifecycleId, store, remaining === 0 ? "removed" : "partial", at);
}

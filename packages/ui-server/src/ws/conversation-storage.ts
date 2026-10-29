/** Durable identities are tombstones, never instructions to replay an effect. */
import type { Database } from "bun:sqlite";
import { CONVERSATION_LIMITS, type ConversationWorkReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { conversationWorkReceiptSchema } from "@schlessera/brain-ui-sdk/schemas";

/** UTF-16 characters of completed result context per conversation; oldest admitted goes first. */
export const MAX_RETAINED_RESULT_CHARS = 16_000;

export interface StoredConversationEpoch {
  id: string;
  principalId: string;
  epoch: number;
  sessionId?: string;
  agentProviderId?: string;
}
export interface StoredConversation extends StoredConversationEpoch {
  receipts: ConversationWorkReceipt[];
  requestIds: string[];
  results: { requestId: string; facts: string }[];
}
export function saveConversationEpoch(db: Database, state: StoredConversationEpoch): void {
  db.transaction(() => {
    const old = db.query("SELECT principal_id FROM conversation_epochs WHERE id=?").get(state.id) as { principal_id: string } | null;
    if (old && old.principal_id !== state.principalId) throw new Error("Conversation ownership mismatch");
    db.prepare(`INSERT INTO conversation_epochs(id,principal_id,epoch,session_id,agent_provider_id,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET epoch=MAX(epoch,excluded.epoch),session_id=COALESCE(excluded.session_id,session_id),updated_at=excluded.updated_at`)
      .run(state.id, state.principalId, state.epoch, state.sessionId ?? null, state.agentProviderId ?? null, Date.now());
    db.exec(`DELETE FROM conversation_epochs WHERE id IN (SELECT id FROM conversation_epochs ORDER BY updated_at DESC LIMIT -1 OFFSET 64)
      AND id NOT IN (SELECT conversation_id FROM conversation_tasks WHERE receipt IS NOT NULL AND
        (json_extract(receipt,'$.state') IN ('queued','running') OR json_extract(receipt,'$.delivery')='pending'))`);
    const count = db.query("SELECT COUNT(*) AS n FROM conversation_epochs").get() as { n: number };
    if (count.n > 64) throw new Error("Durable conversation retention is full; reconcile existing work first");
  }).immediate();
}
export function saveConversationTask(db: Database, principalId: string, receipt: ConversationWorkReceipt, facts?: string): void {
  if (receipt.provenance !== "contextual" || !conversationWorkReceiptSchema.safeParse(receipt).success) throw new Error("Invalid contextual receipt");
  db.transaction(() => {
    const owner = db.query("SELECT principal_id FROM conversation_epochs WHERE id=?").get(receipt.conversationId) as { principal_id: string } | null;
    if (owner?.principal_id !== principalId) throw new Error("Conversation ownership mismatch");
    const old = db.query("SELECT task_id,request_id,receipt,result_facts FROM conversation_tasks WHERE conversation_id=? AND epoch=? AND native_handle=?")
      .get(receipt.conversationId, receipt.epoch, receipt.nativeHandle) as { task_id: string; request_id: string; receipt: string | null; result_facts: string | null } | null;
    if (old && (old.task_id !== receipt.taskId || old.request_id !== receipt.requestId)) throw new Error("Native task identity already consumed");
    const previous = old?.receipt ? conversationWorkReceiptSchema.parse(JSON.parse(old.receipt)) : undefined;
    if (previous?.turnId && previous.turnId !== receipt.turnId) throw new Error("Stored task turn identity cannot change");
    // Capture once on completion. Delivery callbacks cannot replace facts or
    // restore data removed by retention (including an evicted receipt).
    const resultFacts = receipt.state !== "completed" || !receipt.turnId ? null
      : old && (!previous || previous.state === "completed") ? old.result_facts
      : facts ? facts.slice(0, CONVERSATION_LIMITS.maxFactChars) : null;
    const count = db.query("SELECT COUNT(*) AS n FROM conversation_tasks WHERE conversation_id=?").get(receipt.conversationId) as { n: number };
    if (!old && count.n >= 4096) throw new Error("Durable conversation identity capacity exceeded");
    db.prepare(`INSERT INTO conversation_tasks(conversation_id,epoch,native_handle,task_id,request_id,receipt,updated_at,result_facts) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(conversation_id,epoch,native_handle) DO UPDATE SET receipt=excluded.receipt,updated_at=excluded.updated_at,result_facts=excluded.result_facts`)
      .run(receipt.conversationId, receipt.epoch, receipt.nativeHandle, receipt.taskId, receipt.requestId, JSON.stringify(receipt), Date.now(), resultFacts);
    if (receipt.sessionId) db.prepare("UPDATE conversation_epochs SET session_id=? WHERE id=?").run(receipt.sessionId, receipt.conversationId);
    // Keep all identities but only a bounded set of detailed receipts.
    db.prepare(`UPDATE conversation_tasks SET receipt=NULL,result_facts=NULL WHERE conversation_id=? AND rowid NOT IN
      (SELECT rowid FROM conversation_tasks WHERE conversation_id=? ORDER BY
        CASE WHEN json_extract(receipt,'$.state') IN ('queued','running') OR json_extract(receipt,'$.delivery')='pending' THEN 0 ELSE 1 END,
        updated_at DESC,rowid DESC LIMIT 64)`)
      .run(receipt.conversationId, receipt.conversationId);
    // Newer admissions win. Delivery callbacks cannot make an old task newest.
    let retained = 0;
    const rows = db.query("SELECT rowid,result_facts FROM conversation_tasks WHERE conversation_id=? AND result_facts IS NOT NULL ORDER BY rowid DESC")
      .all(receipt.conversationId) as { rowid: number; result_facts: string }[];
    for (const row of rows) {
      retained += row.result_facts.length;
      if (retained > MAX_RETAINED_RESULT_CHARS) db.prepare("UPDATE conversation_tasks SET result_facts=NULL WHERE rowid=?").run(row.rowid);
    }
  }).immediate();
}
export function loadConversation(db: Database, id: string, principalId: string): StoredConversation | null {
  const row = db.query("SELECT epoch,session_id,agent_provider_id FROM conversation_epochs WHERE id=? AND principal_id=?")
    .get(id, principalId) as { epoch: number; session_id: string | null; agent_provider_id: string | null } | null;
  if (!row) return null;
  const tasks = db.query("SELECT request_id,epoch,native_handle,task_id,receipt,result_facts FROM conversation_tasks WHERE conversation_id=? ORDER BY rowid").all(id) as { request_id: string; epoch: number; native_handle: string; task_id: string; receipt: string | null; result_facts: string | null }[];
  const results: StoredConversation["results"] = [];
  let retained = 0;
  const receipts = tasks.flatMap(task => {
    if (!task.receipt) return [];
    const parsed = conversationWorkReceiptSchema.safeParse(JSON.parse(task.receipt));
    if (!parsed.success) throw new Error("Stored conversation receipt is invalid");
    const receipt = parsed.data;
    if (receipt.provenance !== "contextual" || receipt.conversationId !== id || receipt.epoch !== task.epoch ||
      receipt.nativeHandle !== task.native_handle || receipt.taskId !== task.task_id || receipt.requestId !== task.request_id) {
      throw new Error("Stored conversation identity is inconsistent");
    }
    if (task.result_facts !== null && receipt.state === "completed" && receipt.turnId) {
      if (typeof task.result_facts !== "string" || task.result_facts.length > CONVERSATION_LIMITS.maxFactChars ||
        (retained += task.result_facts.length) > MAX_RETAINED_RESULT_CHARS) throw new Error("Stored conversation result exceeds retention bounds");
      results.push({ requestId: receipt.requestId, facts: task.result_facts });
    }
    if (receipt.state === "running" || receipt.state === "queued") return [{ ...receipt, state: "unknown" as const, delivery: "unknown" as const, reason: "The host restarted; the effect outcome is unknown. Work will not be replayed." }];
    if (receipt.delivery === "pending") return [{ ...receipt, delivery: "unknown" as const, reason: "Voice result acceptance is unknown after restart. It will not be replayed." }];
    return [receipt];
  });
  return { id, principalId, epoch: row.epoch, ...(row.session_id ? { sessionId: row.session_id } : {}), ...(row.agent_provider_id ? { agentProviderId: row.agent_provider_id } : {}), receipts, results, requestIds: tasks.map(t => t.request_id) };
}

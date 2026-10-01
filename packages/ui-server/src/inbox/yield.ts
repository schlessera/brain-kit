/** Concrete recovery writes. Receipts restrict replay and never confer authority. */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { CompletedAutonomousToolCall, InboxQueueItem } from "@schlessera/brain-ui-sdk/server";
import { createInboxStore } from "./store.js";

const digest = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
// Named first-party reads may be repeated to inspect current state. Unknown
// tools and every shell call remain conservative: a missing lock key does not
// prove the absence of effects. This is replay restriction, never admission.
const READS = new Set([
  "Read", "Glob", "Grep", "LSP", "WebSearch", "WebFetch", "ToolSearch",
  "read_file", "grep", "brain_search", "brain_context", "brain_read", "brain_list", "brain_graph",
  "web_search", "fetch_content", "jobs_review",
]);

function claimedItems(db: Database, runId: string): InboxQueueItem[] {
  const store = createInboxStore(db);
  return (db.query("SELECT id FROM inbox_items WHERE queue = 'queue' AND status = 'claimed' AND run_id = ? AND deleted_at IS NULL")
    .all(runId) as { id: string }[]).map(({ id }) => store.getItem(id) as InboxQueueItem);
}

export function completedCallsForRun(db: Database, runId: string): CompletedAutonomousToolCall[] {
  const item = db.query("SELECT item_id FROM inbox_budget_reservations WHERE run_id = ?").get(runId) as { item_id: string } | null;
  if (!item) throw new Error("Missing autonomous reservation owner");
  return (db.query("SELECT tool_name, input_json FROM inbox_completed_tool_calls WHERE item_id = ? ORDER BY completed_at, id")
    .all(item.item_id) as { tool_name: string; input_json: string }[])
    .map((row) => ({ toolName: row.tool_name, input: JSON.parse(row.input_json) as Record<string, unknown> }));
}

export function recordCompletedCall(db: Database, runId: string, toolUseId: string, call: CompletedAutonomousToolCall, now = Date.now()): void {
  if (READS.has(call.toolName.replace(/^mcp__brain__/, ""))) return;
  const json = JSON.stringify(call.input);
  db.transaction(() => {
    for (const item of claimedItems(db, runId)) {
      db.query("INSERT OR IGNORE INTO inbox_completed_tool_calls (id, item_id, run_id, tool_name, input_json, completed_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(digest(runId, item.id, toolUseId), item.id, runId, call.toolName, json, now);
    }
  }).immediate();
}

export function checkpointYield(db: Database, runId: string, key: string, stateMd: string, now = Date.now()): void {
  db.transaction(() => {
    const store = createInboxStore(db, { now: () => now });
    const items = claimedItems(db, runId);
    if (items.length === 0) throw new Error("Yield lost its claimed work");
    store.commit(items.map((item) => ({ kind: "checkpoint" as const,
      id: `yield-${digest(runId, item.id)}`, threadId: item.threadId, itemId: item.id, runId,
      stateMd, facts: { decisions: [`Yielded to interactive contention on ${key}.`],
        operations: [], capabilities: [], paths: [], questions: [] },
    })));
  }).immediate();
}

/** Called only after backend unwind and settlement, or expired-lease recovery.
 * Each claim already incremented attempts. Exhaustion is durable and creates
 * one Action per item, so another recovery sweep cannot generate a loop. */
export function recoverAutonomousItem(db: Database, item: InboxQueueItem, now = Date.now()): void {
  db.transaction(() => {
    const store = createInboxStore(db, { now: () => now });
    const current = store.getItem(item.id);
    if (!current || current.queue !== "queue" || current.status !== "claimed" || current.version !== item.version) return;
    const exhausted = current.attempts >= current.maxAttempts;
    store.commit([{ kind: "transition", itemId: current.id, expectedVersion: current.version,
      to: exhausted ? "failed" : "ready" }]);
    if (!exhausted) return;
    const id = `dead-letter-${digest(current.id)}`;
    if (db.query("SELECT 1 FROM inbox_items WHERE id = ?").get(id)) return;
    const thread = store.getThread(current.threadId);
    if (!thread || thread.status !== "open") return;
    store.commit([{ kind: "item", item: { id, dedupKey: id, threadId: current.threadId,
      queue: "actions", type: "choose", status: "pending", version: 1, createdAt: now, updatedAt: now,
      expiresAt: now + 30 * 86_400_000, payload: { title: "Autonomous work reached its attempt limit",
        detail: "Repeated interruption exhausted the bounded attempts. Review the retained checkpoints and completed calls before starting new work." },
      options: [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }],
    } }]);
  }).immediate();
}

export function finishYield(db: Database, runId: string, now = Date.now()): void {
  db.transaction(() => {
    const active = db.query("SELECT 1 FROM inbox_budget_reservations WHERE run_id = ? AND status = 'active'").get(runId);
    if (active) throw new Error("Yield cannot recover work before budget settlement");
    for (const item of claimedItems(db, runId)) recoverAutonomousItem(db, item, now);
  }).immediate();
}

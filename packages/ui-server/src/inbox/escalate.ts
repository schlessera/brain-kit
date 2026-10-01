import type { Database } from "bun:sqlite";
import type { InboxActionItem, InboxOperation } from "@schlessera/brain-ui-sdk/protocol";
import type { AutonomousEscalation } from "./autonomous-turn.js";
import { inboxOperationSchema, validateResolutionEffect } from "@schlessera/brain-ui-sdk/schemas";
import { createInboxStore } from "./store.js";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { enforceInboxActionCap, inboxActionContext, inboxActionSuppressed, inboxIdentity, insertInboxAction, retireInboxAction, type InboxActionContext } from "./actions.js";

export interface InboxEscalationInput {
  itemId: string;
  expectedVersion: number;
  escalation: AutonomousEscalation;
  action: InboxActionItem;
  allowedOperations: readonly InboxOperation[];
  now?: number;
  cap?: number;
  context?: InboxActionContext;
}

/** Synchronous bridge callback: the backend aborts only after this returns. */
export function escalateInbox(db: Database, input: InboxEscalationInput): void {
  const now = input.now ?? Date.now(), store = createInboxStore(db, { now: () => now });
  db.transaction(() => {
    const principal = resolvePrincipal(db, input.escalation.principalId);
    if (!principal || !isUsablePrincipal(principal, now)) throw new Error("Escalation principal is no longer usable");
    const item = store.getItem(input.itemId);
    if (!item || item.queue !== "queue" || item.status !== "claimed" || item.version !== input.expectedVersion ||
        item.runId !== input.escalation.runId || item.leaseUntil! <= now || input.action.threadId !== item.threadId || input.action.type === "fyi")
      throw new Error("Escalation requires the current claimed work and a decision");
    if (!db.query("SELECT 1 FROM inbox_budget_reservations WHERE item_id = ? AND run_id = ? AND principal_id = ? AND attempt = ? AND status = 'active'")
      .get(item.id, input.escalation.runId, input.escalation.principalId, item.attempts))
      throw new Error("Escalation requires its principal-bound active reservation");
    const context = input.context ?? { ...inboxActionContext(input.action), sourceItemId: item.id };
    const suppressed = inboxActionSuppressed(db, context, now);
    // Exact requested operation comes from server-validated options. The
    // checkpoint retains it for audit, not as a grant on replay.
    const operations = input.action.options.flatMap(option => option.effect.kind === "enqueue" && option.effect.payload.operation ? [inboxOperationSchema.parse(option.effect.payload.operation)] : []);
    const escalation = input.escalation;
    if (escalation.kind === "permission" && operations.some(operation => !validateResolutionEffect(
      { kind: "enqueue", payload: { instruction: "Captured permission", operation } },
      [{ toolName: escalation.request.toolName, input: escalation.request.input, targetPath: operation.targetPath }]).ok))
      throw new Error("Permission options must match the captured request");
    store.commit([{ kind: "checkpoint", id: inboxIdentity("escalation", item.id, input.escalation.runId),
      threadId: item.threadId, itemId: item.id, runId: input.escalation.runId, stateMd: input.escalation.stateMd,
      facts: { decisions: [], operations, capabilities: [], paths: operations.map(operation => operation.targetPath),
        questions: input.escalation.kind === "question" ? input.escalation.questions.map(question => question.question) :
          [`Permission for ${input.escalation.request.toolName}: ${JSON.stringify(input.escalation.request.input)}`] } }]);
    insertInboxAction(db, input.action, input.allowedOperations, context, now);
    store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "blocked", blockedByItemId: input.action.id }]);
    if (suppressed) retireInboxAction(db, input.action, "dropped", now, false);
    enforceInboxActionCap(db, input.cap, now);
  }).immediate();
}

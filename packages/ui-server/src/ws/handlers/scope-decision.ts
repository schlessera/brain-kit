import type { ClientMessageHandler } from "./context.js";

export const handleScopeDecision: ClientMessageHandler<"scope_decision"> = async ({ host, ws, connection }, msg) => {
  // Resolves once the decision's own scope writes have committed, so the summary below reads them (#2850).
  const receipt = await host.scope?.decide(msg, connection.authorization.valid && connection.authorization.expiresAt > Date.now())
    ?? { ...msg, type: "scope_decision_receipt" as const, state: "refused" as const, reason: "This host cannot answer scope decisions." };
  if (receipt.state !== "refused" && host.journal) host.sendMessage(ws, { type: "turn_journal", sessionId: msg.sessionId, turnId: msg.turnId, journal: { ...host.journal.summary(msg.turnId), ...(host.budgets?.saved(msg.turnId) ? { budget: host.budgets.saved(msg.turnId) } : {}) } });
  host.sendMessage(ws, receipt);
};

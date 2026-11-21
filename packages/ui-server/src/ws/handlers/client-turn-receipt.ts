import { claimClientTurnReceipt } from "../client-turn-receipts.js";
import type { ClientMessageHandler } from "./context.js";

export const handleClientTurnReceipt: ClientMessageHandler<"client_turn_receipt"> = async ({ host, connection }, msg) => {
  try {
    const persistence = claimClientTurnReceipt(host, msg.turnId, connection.authorization.principalId);
    if (persistence === false) { host.reportDroppedFrame("client_turn_receipt_refused"); return; }
    await persistence;
    if (!connection.authorization.valid || connection.authorization.expiresAt <= Date.now()) {
      host.reportDroppedFrame("client_turn_receipt_refused"); return;
    }
    const accepted = await host.activity?.store.writeClientReceipt?.(msg.turnId, connection.authorization.principalId, msg.timing);
    if (accepted) {
      try { host.activity?.stream.pump(); } catch { /* Fanout loss does not undo acceptance. */ }
      return;
    }
  } catch { /* Losing telemetry never changes the turn or connection. */ }
  // Deliberately identical for an unknown turn, wrong owner and duplicate.
  host.reportDroppedFrame("client_turn_receipt_refused");
};

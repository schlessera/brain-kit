/** The host bridge owns its announced identity's storage settlement. */
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { waitWhile } from "../brain/authority-hold.js";
import { STORAGE_SETTLEMENT_MS } from "../db/settlement.js";
import type { BridgeContext } from "./bridge-capabilities/context.js";

const contexts = new WeakMap<BackendBridge, BridgeContext>();

export function retainTurnSessionBinding(bridge: BackendBridge, context: BridgeContext): void {
  contexts.set(bridge, context);
}

/** Join only this bridge's announced binding, before minting admission authority. */
export async function settleTurnSessionBinding(bridge: BackendBridge, signal: AbortSignal): Promise<boolean> {
  const ctx = contexts.get(bridge);
  if (!ctx) return true;
  const settled = await waitWhile(() => !!ctx.sessionBinding.pending && ctx.current(),
    () => ctx.sessionBinding.pending!, signal, Date.now() + STORAGE_SETTLEMENT_MS);
  if (!settled || signal.aborted || !ctx.current() || ctx.sessionBinding.pending || ctx.sessionBinding.failed) return false;
  const db = ctx.host.activity?.governanceDb, sessionId = ctx.turn.sessionId;
  // Catalog accounting reports failures without rejecting settled(). Check
  // the actual collection binding too; a drained queue is not commit proof.
  if (db && sessionId !== null) {
    return !!db.query(`SELECT 1 FROM safety_collections c JOIN safety_sessions s ON s.session_id=c.session_id
      WHERE c.turn_id=? AND c.session_id=?`).get(ctx.turnId, sessionId);
  }
  return true;
}

/**
 * Composition root for the WebSocket side: one process-wide host instance
 * wired to the default SQLite session catalog and the backend registry. The
 * actual behavior lives in the focused modules next to this file —
 * turns/bridge/run-session/dispatch/connection — which all take the host
 * explicitly. createApp() configures this host from its options before
 * building the upgrade handler.
 */
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { WSContext } from "./clients.js";
import { WsHost, type WsHostOptions } from "./host.js";
import { createWsUpgrade, websocket } from "./connection.js";
import { handleClientMessage as dispatchClientMessage } from "./dispatch.js";

export { websocket };
export { WsHost, type WsHostOptions } from "./host.js";
export { resolveTurnTarget } from "./routing.js";
export { validateAttachments, estimateDecodedBase64Bytes } from "./attachments.js";
export { createSessionCatalog, type SessionCatalog } from "./session-catalog.js";

/** The process-default host. */
export const defaultWsHost = new WsHost();

/** Apply embedder options to the default host (called by createApp). */
export function configureWsHost(options: WsHostOptions): void {
  defaultWsHost.configure(options);
}

/** Hono upgrade handler bound to the default host. */
export const wsUpgrade = createWsUpgrade(defaultWsHost);

/** True while any session has a running turn. */
export function isTurnActive(): boolean {
  return defaultWsHost.coordinator.isTurnActive();
}

/** Cancel every running turn (used on shutdown). */
export function cancelActiveTurn(): boolean {
  return defaultWsHost.coordinator.cancelAll("Server shutting down");
}

/** Drive a client message against the default host (also the test seam). */
export async function handleClientMessage(ws: WSContext, msg: ClientMessage): Promise<void> {
  return dispatchClientMessage(defaultWsHost, ws, msg);
}

/** Test seam: clear all turn/pending state on the default host. */
export function resetForTests(): void {
  defaultWsHost.coordinator.reset();
}

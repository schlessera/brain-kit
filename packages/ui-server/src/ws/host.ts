import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { broadcast, sendTo, type WSContext } from "./clients.js";
import { TurnCoordinator } from "./turns.js";
import { createSessionCatalog, type SessionCatalog } from "./session-catalog.js";

/** Host-side turn timeout. The backend no longer times out — the host owns it. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Cap on host-side follow-up queue depth per session (backends without followUp). */
export const MAX_SESSION_QUEUE = 5;

export interface WsHostOptions {
  /** Session persistence seam; defaults to the package's SQLite catalog. */
  catalog?: SessionCatalog;
  /** Display name used in connection/status copy. */
  appName?: string;
  /** Per-turn timeout in ms (default 10 minutes). */
  turnTimeoutMs?: number;
  /**
   * Deployment-time cap on concurrent RUNNING sessions. Each running turn is
   * roughly one CLI subprocess, so this bounds memory/CPU. Read per request so
   * the deploy-time env is honored without a restart.
   */
  maxConcurrentSessions?: () => number;
}

function envMaxConcurrentSessions(): number {
  return Math.max(1, Number(process.env.MAX_CONCURRENT_SESSIONS) || 3);
}

/**
 * Everything one WebSocket coordinator instance owns: turn state, the session
 * catalog, branding copy, and the frame senders. Handlers receive this host
 * explicitly instead of reaching for module globals.
 */
export class WsHost {
  readonly coordinator = new TurnCoordinator();
  catalog: SessionCatalog;
  appName: string;
  turnTimeoutMs: number;
  maxConcurrentSessions: () => number;

  constructor(options: WsHostOptions = {}) {
    this.catalog = options.catalog ?? createSessionCatalog();
    this.appName = options.appName ?? "Brain UI";
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? envMaxConcurrentSessions;
  }

  /** Re-apply embedder options (createApp configures the default host). */
  configure(options: WsHostOptions): void {
    if (options.catalog) this.catalog = options.catalog;
    if (options.appName) this.appName = options.appName;
    if (options.turnTimeoutMs) this.turnTimeoutMs = options.turnTimeoutMs;
    if (options.maxConcurrentSessions) {
      this.maxConcurrentSessions = options.maxConcurrentSessions;
    }
  }

  /** Fan a frame out to every attached client (size-bounded per frame). */
  sendToClients(msg: ServerMessage): void {
    broadcast(msg);
  }

  /** Send a frame to one specific socket (size-bounded). */
  sendMessage(ws: WSContext, msg: ServerMessage): void {
    sendTo(ws, msg);
  }
}

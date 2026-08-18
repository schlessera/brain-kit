/**
 * @schlessera/brain-ui-server — the chat-UI backend as a library.
 *
 * The deployment shell owns the process: it builds the Bun.serve() object,
 * decides the port/idleTimeout, wires SIGTERM, and injects deployment-only
 * pieces (static client build, PNG/PDF renderer). Everything else — routes,
 * auth, passkeys, the WebSocket turn coordinator, the session catalog — lives
 * behind createApp().
 */
export { createApp, type CreateAppOptions, type AppRenderer } from "./app.js";

// Process lifecycle helpers for the bin entry.
export { websocket, cancelActiveTurn, isTurnActive } from "./ws/handler.js";
export { getDb, closeDb, configureDb } from "./db/client.js";

// Boot-time diagnostics (fail fast on a bad AGENT_BACKEND / profile config,
// log the resolved auth mode).
export { getBackends, getBackendsInfo } from "./agent/backend.js";
export { resolveAuthMode, type AuthMode } from "./middleware/auth.js";

// WebSocket internals for embedders and tests.
export {
  WsHost,
  type WsHostOptions,
  defaultWsHost,
  configureWsHost,
  handleClientMessage,
  resetForTests,
  resolveTurnTarget,
  createSessionCatalog,
  type SessionCatalog,
} from "./ws/handler.js";

// Brain repo access (spawned CLI wrapper) — useful for embedders that add
// their own routes on top.
export * as brainClient from "./brain/client.js";

// Share staging: a deployment can sweep expired staging dirs at boot; the
// intake route also sweeps opportunistically on every share.
export { pruneShareStaging, shareStagingRoot } from "./share/staging.js";

// Voice keyterm cache rebuild (used by deployments after `brain sync`).
export { buildKeyterms, writeCache } from "./voice/keyterm-builder.js";

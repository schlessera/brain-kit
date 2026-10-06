/**
 * First-party sharing: the app database and keyterm builder the packed-package
 * probes (scripts/check-inbox-package.ts, scripts/check-ui-server-query-package.ts)
 * run, and the session catalog `WsHost` is wired with (#1053). Not a supported
 * API: no compatibility guarantee, and consumers must use the same lockstep
 * version. See docs/decisions/public-export-boundary.md.
 */
export { createUiDb } from "./db/client.js";
export { buildKeyterms } from "./voice/keyterm-builder.js";
export { createSessionCatalog, type SessionCatalog } from "./ws/session-catalog.js";

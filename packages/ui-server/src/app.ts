import { Hono } from "hono";
import type { Context } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { join } from "path";
import { healthRoutes, statusRoutes } from "./routes/health.js";
import { brainRoutes } from "./routes/brain.js";
import { sessionRoutes } from "./routes/sessions.js";
import { voiceRoutes } from "./routes/voice.js";
import { filesRoutes } from "./routes/files.js";
import { createRenderRoutes, type AppRenderer } from "./routes/render.js";
import { providerRoutes } from "./routes/providers.js";
import { modelRoutes } from "./routes/models.js";
import {
  resolveAuthMode,
  assertAuthConfig,
  authGuard,
  authRoutes,
  isWsAuthorized,
} from "./middleware/auth.js";
import {
  passkeyPublicRoutes,
  passkeyManagementRoutes,
  passwordLoginDisabled,
  assertPasskeyConfig,
} from "./middleware/passkeys.js";
import { configureDb } from "./db/client.js";
import { configureWsHost, wsUpgrade, websocket } from "./ws/handler.js";

export type { AppRenderer };

export interface CreateAppOptions {
  /**
   * Directory of a built SPA to serve at `/*` with an index.html fallback.
   * The deployment shell decides whether (and what) to serve — the package
   * has no client build of its own and no NODE_ENV heuristics.
   */
  staticRoot?: string;
  /** Display name used in connection/status copy. Default "Brain UI". */
  appName?: string;
  /** SQLite path override; falls back to DB_PATH, then ./brain-ui.db. */
  dbPath?: string;
  /**
   * PNG/PDF renderer for `POST /api/render`. The deployment owns the actual
   * renderer instance (e.g. @schlessera/brain-render-puppeteer) — without one
   * the route answers 501.
   */
  renderer?: AppRenderer;
  /** Per-turn timeout in ms (default 10 minutes). */
  turnTimeoutMs?: number;
}

// Cross-site WebSocket hijacking (CSWSH) defense. CORS does not apply to the WS
// handshake and browsers do not enforce same-origin on `new WebSocket()`, so
// rejecting a cross-site upgrade is entirely the server's job. A browser always
// sends `Origin` on a WS handshake; a non-browser client (no Origin) is allowed
// through here and still gated by isWsAuthorized. When ALLOWED_ORIGINS is set we
// use it; otherwise we require the Origin's host to match the request host
// (same-origin). Applied in every auth mode.
function isAllowedWsOrigin(c: Context, allowedOrigins: string[]): boolean {
  const origin = c.req.header("origin");
  if (!origin) return true;
  if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  try {
    const host = c.req.header("host");
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createApp(options: CreateAppOptions = {}) {
  const app = new Hono();
  const authMode = resolveAuthMode();
  // Validate inside the factory, not the bin entry: every consumer of the app
  // (a deployment bin, tests, another embedder) gets the same refuse-to-boot
  // guarantee on an unsafe auth configuration.
  assertAuthConfig(authMode);
  assertPasskeyConfig();

  if (options.dbPath) configureDb(options.dbPath);
  configureWsHost({
    ...(options.appName ? { appName: options.appName } : {}),
    ...(options.turnTimeoutMs ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
  });

  // Middleware
  app.use("*", logger());

  // CORS is only needed for a SPLIT topology where the client is served from a
  // different origin than the API. ALLOWED_ORIGINS is a comma-separated
  // allowlist; empty/unset means same-origin (the default), so the CORS
  // middleware is skipped entirely.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (allowedOrigins.length > 0) {
    app.use(
      "/api/*",
      cors({
        origin: allowedOrigins,
        allowMethods: ["GET", "POST", "PUT", "DELETE"],
        allowHeaders: ["Content-Type"],
        credentials: true,
      })
    );
  }

  // Public routes, registered BEFORE the auth guard: only the minimal liveness
  // probe and the login/logout routes are reachable without a session.
  // /api/status is intentionally NOT here — it leaks the git SHA, cron errors,
  // and a session oracle, so it lives behind the guard below.
  app.route("/api", healthRoutes);
  app.route("/api", authRoutes(authMode, { passwordDisabled: passwordLoginDisabled }));
  app.route("/api", passkeyPublicRoutes(authMode));

  // Auth guard for every other /api/* route. The probe below is intentionally
  // behind it: an unauthenticated client gets 401 (password/proxy) or 403
  // (tailscale) from /api/vpn-check and shows the login / VPN screen.
  app.use("/api/*", authGuard(authMode));
  app.get("/api/vpn-check", (c) => c.json({ vpn: true }));
  // Passkey registration/management: after the guard, so a session is required
  // by mount position (the public assertion routes are registered above).
  app.route("/api", passkeyManagementRoutes(authMode));
  app.route("/api", statusRoutes);
  app.route("/api", brainRoutes);
  app.route("/api", sessionRoutes);
  app.route("/api", voiceRoutes);
  app.route("/api", filesRoutes);
  app.route("/api", createRenderRoutes(options.renderer));
  app.route("/api", providerRoutes);
  app.route("/api", modelRoutes);

  // WebSocket endpoint. Browsers can't set headers on the WS handshake, so the
  // upgrade authenticates via the session cookie (or IP/proxy header) INSIDE
  // the handler — no header-modifying middleware may sit on this route.
  app.get("/ws", async (c, next) => {
    if (!isAllowedWsOrigin(c, allowedOrigins)) {
      return c.json({ error: "Cross-origin WebSocket rejected" }, 403);
    }
    if (!(await isWsAuthorized(c, authMode))) {
      return c.json({ error: "Authentication required" }, 401);
    }
    return wsUpgrade(c, next);
  });

  // Static files: the deployment shell passes its built client explicitly.
  if (options.staticRoot) {
    const staticRoot = options.staticRoot;
    app.use("/*", serveStatic({ root: staticRoot }));
    // SPA fallback
    app.get("*", serveStatic({ path: join(staticRoot, "index.html") }));
  }

  return {
    fetch: app.fetch,
    websocket,
  };
}

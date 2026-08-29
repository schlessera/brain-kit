import { Hono } from "hono";
import type { Context } from "hono";
import type { Database } from "bun:sqlite";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { join } from "path";
import { resolveServerConfig, type ServerConfig } from "./config/env.js";
import { createHealthRoutes, createStatusRoutes } from "./routes/health.js";
import { createBrainRoutes } from "./routes/brain.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createActivityRoutes } from "./routes/activity.js";
import { createVoiceRoutes } from "./routes/voice.js";
import { createFilesRoutes } from "./routes/files.js";
import { createShareRoutes, shareTargetFallbackRoutes } from "./routes/share.js";
import { createRenderRoutes, type AppRenderer } from "./routes/render.js";
import { createProviderRoutes } from "./routes/providers.js";
import { createModelRoutes } from "./routes/models.js";
import { createPiAuthRoutes } from "./routes/pi-auth.js";
import { createWebSearchRoutes } from "./routes/web-search.js";
import { createGraphRoutes } from "./routes/graph.js";
import {
  resolveAuthMode,
  assertAuthConfig,
  authGuard,
  authRoutes,
  isWsAuthorized,
  type AuthMode,
  type AuthRuntime,
} from "./middleware/auth.js";
import {
  passkeyPublicRoutes,
  passkeyManagementRoutes,
  passwordLoginDisabled,
  assertPasskeyConfig,
  type PasskeyContext,
} from "./middleware/passkeys.js";
import { createUiDb } from "./db/client.js";
import {
  getBillingOverrides,
  getCustomOpenRouterModels,
  getDefaultModelId,
  getHiddenModelIds,
  getThinkingOverrides,
} from "./db/settings.js";
import { createActivityRuntime } from "./activity/runtime.js";
import { createModelPricing } from "./pricing/model-pricing.js";
import { createPushRoutes } from "./routes/push.js";
import {
  assertBackendResolvable,
  createBackendRegistry,
  type BackendRegistry,
} from "./agent/backend.js";
import { createBrainClient } from "./brain/client.js";
import { createCronScheduler } from "./cron/scheduler.js";
import { WsHost } from "./ws/host.js";
import { createWsUpgrade, websocket } from "./ws/connection.js";
import { createSessionCatalog } from "./ws/session-catalog.js";
import type { KeytermSettings } from "./voice/keyterm-builder.js";
import { createObservability, type Observability } from "./observability/index.js";

export type { AppRenderer };

export interface CreateAppOptions {
  /**
   * Fully-resolved configuration. When omitted, `createApp` resolves it from
   * the process environment ONCE, here at the edge — nothing deeper in the
   * package touches the ambient environment. Pass an explicit object (e.g. from
   * `resolveServerConfig(customEnv)`) to run two differently-configured apps
   * in one process or to vary configuration in tests without env mutation.
   */
  config?: ServerConfig;
  /**
   * Directory of a built SPA to serve at `/*` with an index.html fallback.
   * The deployment shell decides whether (and what) to serve — the package
   * has no client build of its own and no NODE_ENV heuristics.
   */
  staticRoot?: string;
  /** Display name used in connection/status copy. Default "Brain UI". */
  appName?: string;
  /**
   * SQLite path override; folded into the effective config, so `app.config.dbPath`
   * always names the database actually opened. Falls back to config.dbPath
   * (DB_PATH, ./brain-ui.db).
   */
  dbPath?: string;
  /**
   * PNG/PDF renderer for `POST /api/render`. The deployment owns the actual
   * renderer instance (e.g. @schlessera/brain-render-puppeteer) — without one
   * the route answers 501.
   */
  renderer?: AppRenderer;
  /** Per-turn timeout in ms (default 10 minutes). */
  turnTimeoutMs?: number;
  /** Backend registry override (tests/embedders); default is built from config. */
  registry?: BackendRegistry;
  /**
   * Where this app reports. Defaults to the console consumer; a test passes
   * `createRecordingObservability()` and then asserts on what the server
   * actually said, through the same emission path production uses.
   */
  observability?: Observability;
}

/** What `createApp` hands back to the deployment shell. */
export interface BrainUiApp {
  fetch: Hono["fetch"];
  websocket: typeof websocket;
  /** The configuration this instance runs on (resolved or injected). */
  config: ServerConfig;
  /**
   * The auth mode this instance resolved and validated at boot — so the
   * deployment shell can log it without re-deriving the AuthRuntime that
   * resolveAuthMode needs.
   */
  authMode: AuthMode;
  /** The app's own SQLite handle (sessions, passkeys, settings). */
  db: Database;
  /** The WebSocket coordinator (turn state, clients, catalog, registry). */
  wsHost: WsHost;
  /** Where this app reports — resolved or injected. */
  observability: Observability;
  /** True while any session has a running turn. */
  isTurnActive(): boolean;
  /** Cancel every running turn (used on shutdown). Returns true if any was. */
  cancelActiveTurns(): boolean;
  /** Release process-held resources (the SQLite handle). */
  close(): void;
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

export function createApp(options: CreateAppOptions = {}): BrainUiApp {
  // The edge: ambient environment becomes explicit configuration exactly once.
  // options.dbPath folds into the config here, so the handle's `config` and
  // the database actually opened can never disagree.
  const resolved = options.config ?? resolveServerConfig();
  // Checked against undefined, not truthiness: SQLite treats "" as a valid
  // anonymous temporary database, and an explicit empty override must not
  // silently fall back to the resolved path.
  const config: ServerConfig =
    options.dbPath !== undefined ? { ...resolved, dbPath: options.dbPath } : resolved;
  // First thing built, because everything below may want to report — including
  // the auth validation that can refuse to boot and the migration runner.
  const observability =
    options.observability ?? createObservability({ minSeverity: config.logLevel });
  const auth: AuthRuntime = { ...config.auth, host: config.host };

  const app = new Hono();
  const authLog = observability.logger("auth");
  const authMode = resolveAuthMode(auth, authLog);
  // Validate inside the factory, not the bin entry: every consumer of the app
  // (a deployment bin, tests, another embedder) gets the same refuse-to-boot
  // guarantee on an unsafe auth configuration.
  assertAuthConfig(authMode, auth, authLog);
  assertPasskeyConfig(config.webauthn);
  // A missing (or unrecognized) agent backend refuses to boot HERE, not on the
  // first turn — otherwise /api/health reports healthy while every turn is
  // guaranteed to fail. Resolution only; the module still loads lazily.
  // Skipped when the embedder injects its own registry.
  if (!options.registry) assertBackendResolvable(config.agent);

  // Per-instance state: the app's own database, the brain CLI wrapper, the
  // backend registry, and the WebSocket host. No module-level singletons —
  // two apps with different configuration coexist in one process.
  const dbLog = observability.logger("db");
  const db = createUiDb(config.dbPath, { log: dbLog });
  const brain = createBrainClient({ brainPath: config.brainPath });
  const cron = createCronScheduler({ db, brain, log: observability.logger("cron") });

  // Model pricing for rollup-time effective cost: constructed here because
  // the config owns enabled/TTL/brainPath, shared through the activity
  // runtime. The first refresh warms in the background — ensureFresh never
  // rejects and no rollup ever waits on the network (resolve() is sync).
  const pricing = createModelPricing({
    brainPath: config.brainPath,
    enabled: config.pricing.enabled,
    ttlMs: config.pricing.ttlMs,
  });
  void pricing.ensureFresh();

  // Activity record: span store + live stream + notifications + lifecycle
  // sweeps, owned by the runtime (see activity/runtime.ts).
  const activity = createActivityRuntime(db, {
    log: observability.logger("activity"),
    pricing,
  });
  const registry =
    options.registry ??
    createBackendRegistry({
      brainPath: config.brainPath,
      agent: config.agent,
      getHiddenModelIds: () => getHiddenModelIds(db, dbLog),
      getDefaultModelId: () => getDefaultModelId(db, dbLog),
      getCustomOpenRouterModels: () => getCustomOpenRouterModels(db, dbLog),
      getThinkingOverrides: () => getThinkingOverrides(db, dbLog),
      getBillingOverrides: () => getBillingOverrides(db, dbLog),
      log: observability.logger("agent"),
    });
  const host = new WsHost({
    registry,
    observability,
    catalog: createSessionCatalog(() => db, dbLog),
    ...(options.appName ? { appName: options.appName } : {}),
    // Explicit option wins; then the env-resolved config; then the host default.
    ...(options.turnTimeoutMs ?? config.turnTimeoutMs
      ? { turnTimeoutMs: (options.turnTimeoutMs ?? config.turnTimeoutMs)! }
      : {}),
    maxConcurrentSessions: () => config.maxConcurrentSessions,
    wsRate: config.wsRate,
    activity: {
      store: activity.store,
      stream: activity.stream,
      query: activity.query,
    },
  });
  const wsUpgrade = createWsUpgrade(host);
  // One instrument for every way a login can fail — passkey ceremonies and
  // password logins land in the same series, split by attributes.
  const authFailures = observability.meter("auth").createCounter("auth.failures", {
    description: "Failed authentication ceremonies, by reason",
  });
  const passkeyCtx: PasskeyContext = {
    db,
    webauthn: config.webauthn,
    auth,
    allowedOrigins: config.allowedOrigins,
    log: observability.logger("passkeys"),
    failures: authFailures,
  };
  const keyterms: KeytermSettings = {
    brainPath: config.brainPath,
    cacheDir: config.voice.cacheDir,
    limit: config.voice.keytermLimit,
    log: observability.logger("voice"),
  };

  // Request logging through the observability layer, so BRAIN_UI_LOG_LEVEL
  // governs it like every other emission (hono's logger() wrote raw console
  // lines no threshold or consumer swap could touch). Path only — never the
  // query string or body. /api/health is skipped: the Docker healthcheck
  // polls it and would drown everything else out.
  const httpLog = observability.logger("http");
  app.use("*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    const startedAt = Date.now();
    await next();
    httpLog.emit({
      severityText: "INFO",
      body: "request",
      attributes: {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        "duration.ms": Date.now() - startedAt,
      },
    });
  });

  // CORS is only needed for a SPLIT topology where the client is served from a
  // different origin than the API. ALLOWED_ORIGINS is a comma-separated
  // allowlist; empty/unset means same-origin (the default), so the CORS
  // middleware is skipped entirely.
  const allowedOrigins = config.allowedOrigins;
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
  app.route("/api", createHealthRoutes({ db }));
  // Not under /api, and not behind the guard: this is where a system share
  // lands when no service worker was around to intercept it. See the route.
  app.route("/", shareTargetFallbackRoutes);
  app.route(
    "/api",
    authRoutes(authMode, auth, {
      passwordDisabled: (c) => passwordLoginDisabled(c, passkeyCtx),
      log: authLog,
      failures: authFailures,
    })
  );
  app.route("/api", passkeyPublicRoutes(authMode, passkeyCtx));

  // Auth guard for every other /api/* route. The probe below is intentionally
  // behind it: an unauthenticated client gets 401 (password/proxy) or 403
  // (tailscale) from /api/vpn-check and shows the login / VPN screen.
  app.use("/api/*", authGuard(authMode, auth));
  app.get("/api/vpn-check", (c) => c.json({ vpn: true }));
  // Passkey registration/management: after the guard, so a session is required
  // by mount position (the public assertion routes are registered above).
  app.route("/api", passkeyManagementRoutes(authMode, passkeyCtx));
  app.route(
    "/api",
    createStatusRoutes({
      sourceCommit: config.sourceCommit,
      getCronStatus: () => cron.getCronStatus(),
      isTurnActive: () => host.coordinator.isTurnActive(),
      // Undefined when the injected consumer cannot be read back (a real OTel
      // SDK exports elsewhere), in which case the field is simply absent.
      getMetrics: () => observability.metrics?.snapshot(),
    })
  );
  app.route(
    "/api",
    createBrainRoutes({ brain, brainPath: config.brainPath, keyterms })
  );
  app.route("/api", createSessionRoutes({ registry, db }));
  // Behind the guard by mount position, like /api/status: the activity
  // record leaks strictly more (session activity, errors, spend).
  app.route("/api", createActivityRoutes({ db, store: activity.store, notifier: activity.notifier }));
  app.route("/api", createPushRoutes({ sender: activity.pushSender }));
  app.route("/api", createVoiceRoutes({ voice: config.voice, keyterms }));
  app.route(
    "/api",
    createFilesRoutes({ brainRoot: config.brainPath, log: observability.logger("files") })
  );
  app.route(
    "/api",
    createShareRoutes({
      brainRoot: config.brainPath,
      allowedOrigins,
      log: observability.logger("share"),
    })
  );
  app.route("/api", createRenderRoutes(options.renderer, observability.logger("render")));
  app.route("/api", createProviderRoutes({ registry }));
  app.route(
    "/api",
    createModelRoutes({ registry, db, pricing, log: observability.logger("models") })
  );
  app.route("/api", createPiAuthRoutes({ agent: config.agent }));
  app.route("/api", createWebSearchRoutes({ agent: config.agent }));
  app.route(
    "/api",
    createGraphRoutes({ brainRoot: config.brainPath, log: observability.logger("graph") })
  );

  // WebSocket endpoint. Browsers can't set headers on the WS handshake, so the
  // upgrade authenticates via the session cookie (or IP/proxy header) INSIDE
  // the handler — no header-modifying middleware may sit on this route.
  app.get("/ws", async (c, next) => {
    if (!isAllowedWsOrigin(c, allowedOrigins)) {
      return c.json({ error: "Cross-origin WebSocket rejected" }, 403);
    }
    if (!(await isWsAuthorized(c, authMode, auth))) {
      return c.json({ error: "Authentication required" }, 401);
    }
    return wsUpgrade(c, next);
  });

  // Static files: the deployment shell passes its built client explicitly.
  if (options.staticRoot) {
    const staticRoot = options.staticRoot;
    app.use("/*", serveStatic({ root: staticRoot }));

    // SPA fallback, served directly rather than through serveStatic({ path }).
    //
    // That helper resolves its path the same way it resolves `root` — against
    // the process working directory — so `join(staticRoot, "index.html")`
    // only lands correctly when `staticRoot` is itself cwd-relative. It is in
    // the shipped layout, which is why this went unnoticed; an embedder
    // passing an absolute directory, or a process that changed cwd, got a
    // fallback that silently 404ed every deep link. Reading the file
    // ourselves removes the ambiguity for both cases.
    const indexPath = join(staticRoot, "index.html");
    app.get("*", async (c) => {
      const file = Bun.file(indexPath);
      if (!(await file.exists())) return c.notFound();
      return new Response(file, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });
  }

  return {
    fetch: app.fetch,
    websocket,
    config,
    authMode,
    db,
    wsHost: host,
    observability,
    isTurnActive: () => host.coordinator.isTurnActive(),
    cancelActiveTurns: () => host.coordinator.cancelAll("Server shutting down"),
    close: () => {
      activity.close();
      db.close();
    },
  };
}

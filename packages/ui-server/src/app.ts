import { createTrackRoutes } from "./routes/tracks.js";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { join } from "path";
import { resolveServerConfig, type ServerConfig } from "./config/env.js";
import { createHealthRoutes, createStatusRoutes } from "./routes/health.js";
import { createSubscriptionMonitor, parseMintedAt } from "./agent/subscription.js";
import { createBrainRoutes } from "./routes/brain.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createActivityRoutes } from "./routes/activity.js";
import { createVoiceRoutes } from "./routes/voice.js";
import { createFilesRoutes } from "./routes/files.js";
import { createInboxIntake } from "./inbox/intake.js";
import { createQueueRoutes } from "./routes/queue.js";
import { createShareRoutes, shareTargetFallbackRoutes } from "./routes/share.js";
import { createRenderRoutes, type AppRenderer } from "./routes/render.js";
import { createProviderRoutes } from "./routes/providers.js";
import { createModelRoutes } from "./routes/models.js";
import { createPiAuthRoutes } from "./routes/pi-auth.js";
import { createWebSearchRoutes } from "./routes/web-search.js";
import { createToolPermissionRoutes } from "./routes/tool-permissions.js";
import { createSkillRoutes } from "./routes/skills.js";
import { createGeoRoutes } from "./routes/geo.js";
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
import { principalManagementRoutes } from "./middleware/principals.js";
import { createUiDb } from "./db/client.js";
import { createInboxStore } from "./inbox/store.js";
import { createInboxResolver } from "./inbox/resolve.js";
import { createInboxStream } from "./inbox/stream.js";
import { isUsablePrincipal, prunePrincipals, resolvePrincipal } from "./db/principals.js";
import {
  getAutoAllowedTools,
  getBillingOverrides,
  getCustomOpenRouterModels,
  getDefaultModelId,
  getHiddenModelIds,
  getThinkingOverrides,
  setAutoAllowedTools,
} from "./db/settings.js";
import { createActivityRuntime } from "./activity/runtime.js";
import { createInboxRuntime } from "./inbox/runtime.js";
import { assertInboxRecoveryReady } from "./inbox/recovery-gate.js";
import { createInboxPokeAuth, createInternalRoutes } from "./routes/internal.js";
import { readSyncRuntime } from "./activity/sync-runtime.js";
import { createModelPricing } from "./pricing/model-pricing.js";
import { createPushRoutes } from "./routes/push.js";
import {
  assertBackendResolvable,
  probeBackendRuntimes,
  createBackendRegistry,
  validateBackendVersionRequirements,
  type BackendRegistry,
} from "./agent/backend.js";
import { createBrainClient, probeBrainCliVersion } from "./brain/client.js";
import type { BackendVersionRequirements } from "@schlessera/brain-ui-sdk/server";
import { validateVersionMinimum } from "@schlessera/brain-ui-sdk/server";
import { createCronScheduler } from "./cron/scheduler.js";
import { startScratchPrune } from "./cron/scratch-prune.js";
import { WsHost } from "./ws/host.js";
import { createWsUpgrade, websocket } from "./ws/connection.js";
import { createSessionCatalog } from "./ws/session-catalog.js";
import { createJevClient, createTurnClassifier } from "./classification/index.js";
import type { KeytermSettings } from "./voice/keyterm-builder.js";
import { createObservability, type Observability } from "./observability/index.js";
import { isSameOriginRequest, originPolicy } from "./middleware/origin.js";
import type { AppEnv } from "./app-env.js";

export type { AppRenderer };

/** Explicit host minima for independently resolved content and backend runtimes. */
export interface HostVersionRequirements {
  brainCli?: string;
  backends?: Readonly<Record<string, BackendVersionRequirements>>;
}

export interface CreateAppOptions {
  /** Full SemVer minima composed with package requirements; unknown explicit identities refuse startup. */
  versionRequirements?: HostVersionRequirements;
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
  /**
   * Release process-held resources (the SQLite handle). Resolves once the
   * scratch prune pass in flight, if any, has been killed and has exited.
   */
  close(): Promise<void>;
}

function isWebSocketUpgradeAttempt(request: Request): boolean {
  const connectionHasUpgrade = request.headers
    .get("connection")
    ?.split(",")
    .some((token) => token.trim().toLowerCase() === "upgrade");
  return (
    request.method === "GET" &&
    connectionHasUpgrade === true &&
    request.headers.get("upgrade")?.trim().toLowerCase() === "websocket" &&
    Boolean(request.headers.get("sec-websocket-key")?.trim())
  );
}

export async function createApp(options: CreateAppOptions = {}): Promise<BrainUiApp> {
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

  const app = new Hono<AppEnv>();
  const authLog = observability.logger("auth");
  const authMode = resolveAuthMode(auth, authLog);
  // Validate inside the factory, not the bin entry: every consumer of the app
  // (a deployment bin, tests, another embedder) gets the same refuse-to-boot
  // guarantee on an unsafe auth configuration.
  assertAuthConfig(authMode, auth, authLog);
  assertPasskeyConfig(config.webauthn);
  const suppliedRequirements = options.versionRequirements;
  if (suppliedRequirements !== undefined && (!suppliedRequirements || typeof suppliedRequirements !== "object" || Array.isArray(suppliedRequirements))) {
    throw new Error("Invalid host versionRequirements during startup: supply a brainCli/backends object.");
  }
  for (const key of Object.keys(suppliedRequirements ?? {})) {
    if (key !== "brainCli" && key !== "backends") throw new Error(`Invalid host versionRequirements.${key} during startup: use brainCli or backends minima.`);
  }
  const brainCliMinimum = suppliedRequirements && Object.hasOwn(suppliedRequirements, "brainCli")
    ? validateVersionMinimum(suppliedRequirements.brainCli, "host versionRequirements.brainCli", "brain CLI during startup")
    : undefined;
  const backendRequirements = validateBackendVersionRequirements(config.agent, suppliedRequirements?.backends);
  if (options.registry && Object.keys(backendRequirements ?? {}).length > 0) {
    throw new Error(`Cannot verify host versionRequirements.backends during startup through an injected registry: detected identities unknown; declarations ${JSON.stringify(backendRequirements)}. Use the descriptor-backed default registry, or omit explicit backend requirements.`);
  }
  // A missing (or unrecognized) agent backend refuses to boot HERE, not on the
  // first turn — otherwise /api/health reports healthy while every turn is
  // guaranteed to fail. Descriptor loading and profile validation happen here;
  // backend construction and model discovery remain lazy.
  // Skipped when the embedder injects its own registry.
  if (!options.registry) assertBackendResolvable(config.agent);
  // An unparseable token mint date refuses here, before anything is opened
  // (#254): ignoring it would silently switch the expiry warning off.
  parseMintedAt(config.subscription.mintedAt);
  // The runtime every active backend would spawn, probed now (#211): a
  // missing or unstartable binary refuses the boot here instead of failing
  // the first turn — and before anything is opened, so a refused boot leaves
  // nothing behind. Skipped with an injected registry, like the check above.
  const runtimeProbes = options.registry
    ? []
    : await probeBackendRuntimes(config.agent, config.brainPath, observability.logger("agent"), undefined, backendRequirements);

  // Per-instance state: the app's own database, the brain CLI wrapper, the
  // backend registry, and the WebSocket host. No module-level singletons —
  // two apps with different configuration coexist in one process.
  await probeBrainCliVersion(config.brainPath, observability.logger("brain"), { minimumVersion: brainCliMinimum });
  // Provision the independently authorized runtime file before opening handles.
  const inboxPokeAuth = createInboxPokeAuth(config.inbox?.pokeTokenFile ?? null);
  const dbLog = observability.logger("db");
  const db = createUiDb(config.dbPath, { log: dbLog });
  try { assertInboxRecoveryReady(db); } catch (error) { db.close(); throw error; }
  // One package-local pricing instance, shared by admission and Activity.
  // Refresh warms in the background; resolve() is synchronous and rollups
  // never wait on the network.
  const pricing = createModelPricing({
    brainPath: config.brainPath,
    enabled: config.pricing.enabled,
    ttlMs: config.pricing.ttlMs,
  });
  void pricing.ensureFresh();
  // Recovery/heartbeat only. Production dispatch is gated by the full-v1
  // containment, budgets, admission and system proof; no backend is wired here.
  const inbox = createInboxRuntime(db, { log: observability.logger("inbox"),
    brainRoot: config.brainPath,
    budget: config.inbox?.budget ? { config: config.inbox.budget, pricing,
      maxAutonomousRuns: config.inbox.maxAutonomousRuns } : undefined });
  prunePrincipals(db, Date.now());
  const intake = createInboxIntake(db, config.brainPath, observability.logger("inbox"));
  try { await inbox.ready; await intake.reconcile(); } catch (error) { await inbox.close(); db.close(); throw error; }
  const brain = createBrainClient({ brainPath: config.brainPath, minimumVersion: brainCliMinimum, log: observability.logger("brain") });
  const scratchPrune = startScratchPrune({ brain, log: observability.logger("cron") });

  // Activity record: span store + live stream + notifications + lifecycle
  // sweeps, owned by the runtime (see activity/runtime.ts).
  const activity = createActivityRuntime(db, {
    log: observability.logger("activity"),
    pricing,
  });
  activity.runtime.setBoot(runtimeProbes);
  const cron = createCronScheduler({
    db,
    brain,
    log: observability.logger("cron"),
    activity: activity.store,
  });
  const registry =
    options.registry ??
    createBackendRegistry({
      versionRequirements: backendRequirements,
      brainPath: config.brainPath,
      agent: config.agent,
      getHiddenModelIds: () => getHiddenModelIds(db, dbLog),
      getDefaultModelId: () => getDefaultModelId(db, dbLog),
      getCustomOpenRouterModels: () => getCustomOpenRouterModels(db, dbLog),
      getThinkingOverrides: () => getThinkingOverrides(db, dbLog),
      getBillingOverrides: () => getBillingOverrides(db, dbLog),
      log: observability.logger("agent"),
    });
  // The subscription token (#254): boot warnings now, the expiry check daily,
  // and what /api/status says about it.
  const subscription = createSubscriptionMonitor({
    config: config.subscription,
    log: observability.logger("agent"),
    db,
    lastTurnFailure: () => activity.runtime.subscriptionAuthFailure(),
    modelSource: () => registry.getModelSource(),
  });
  // The classification pass (D42): always constructed so persisted blocks
  // replay, calling out only when a key is configured.
  const classifier = createTurnClassifier({
    jev: createJevClient({
      apiKey: config.classification.apiKey,
      log: observability.logger("classification"),
    }),
    db: () => db,
    log: observability.logger("classification"),
    meter: observability.meter("classification"),
  });
  const host = new WsHost({
    brainPath: config.brainPath,
    registry,
    observability,
    catalog: createSessionCatalog(() => db, dbLog),
    // Exact-operation approvals remain fail-closed until the full-v1 engine
    // wires current server authority. Dismiss/cancel/snooze need no grant.
    inbox: createInboxStream(createInboxStore(db), db, observability.logger("inbox"),
      createInboxResolver(db, { allowedOperations: () => [], timeZone: config.inbox?.budget?.timeZone })),
    classifier,
    scratchPrune: () => scratchPrune.tick(),
    ...(options.appName ? { appName: options.appName } : {}),
    // Explicit option wins; then the env-resolved config; then the host default.
    ...(options.turnTimeoutMs ?? config.turnTimeoutMs
      ? { turnTimeoutMs: (options.turnTimeoutMs ?? config.turnTimeoutMs)! }
      : {}),
    maxConcurrentSessions: () => config.maxConcurrentSessions,
    askUserFormLimits: config.askUserFormLimits,
    wsRate: config.wsRate,
    wsMaxConnections: config.wsMaxConnections,
    isPrincipalValid: (principal) => {
      const current = resolvePrincipal(db, principal.id);
      return current !== null && isUsablePrincipal(current, Date.now());
    },
    toolPermissions: {
      isAutoAllowed: (toolName) => getAutoAllowedTools(db, dbLog).includes(toolName),
      add: (toolName) =>
        setAutoAllowedTools(db, [...getAutoAllowedTools(db, dbLog), toolName]),
    },
    activity: {
      store: activity.store,
      stream: activity.stream,
      pushSender: activity.pushSender,
      query: activity.query,
      runtime: activity.runtime,
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
    revoker: host,
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
    const principal = c.get("principal");
    httpLog.emit({
      severityText: "INFO",
      body: "request",
      attributes: {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        "duration.ms": Date.now() - startedAt,
        ...(principal
          ? {
              "auth.principal.id": principal.id,
              "auth.principal.label": principal.label,
            }
          : {}),
      },
    });
  });

  // A genuine WebSocket upgrade must remain free of response-header middleware:
  // its browser authentication happens inside the route handler below. A plain
  // HTTP request to /ws is not exempt. Every HTTP response is denied framing,
  // while a route-specific CSP (the raw file response) is preserved and
  // supplies its own frame-ancestors directive.
  app.use("*", async (c, next) => {
    if (c.req.path === "/ws" && isWebSocketUpgradeAttempt(c.req.raw)) return next();
    await next();
    c.header("X-Frame-Options", "DENY");
    if (!c.res.headers.has("Content-Security-Policy")) {
      c.header("Content-Security-Policy", "frame-ancestors 'none'");
    }
  });

  // The origin boundary precedes every API route, including the public login
  // and passkey POSTs registered below. Hono composes middleware in registration
  // order, so moving this next to the auth guard would leave those routes out.
  // WEBAUTHN_ORIGINS stays ceremony-scoped rather than widening every API.
  const allowedOrigins = config.allowedOrigins;
  app.use(
    "/api/*",
    originPolicy(allowedOrigins, auth.trustProxy, {
      pathPrefix: "/api/auth/passkey/",
      origins: config.webauthn.origins,
    })
  );

  // CORS is only needed for a SPLIT topology where the client is served from a
  // different origin than the API. ALLOWED_ORIGINS is a comma-separated
  // allowlist; empty/unset means same-origin (the default), so the CORS
  // middleware is skipped entirely.
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
      db,
      revoker: host,
      passwordDisabled: (c) => passwordLoginDisabled(c, passkeyCtx),
      log: authLog,
      failures: authFailures,
    })
  );
  app.route("/api", passkeyPublicRoutes(authMode, passkeyCtx));
  app.route("/api", createInternalRoutes({ auth: inboxPokeAuth, runtime: inbox }));

  // Auth guard for every other /api/* route. The probe below is intentionally
  // behind it: an unauthenticated client gets 401 (password/proxy) or 403
  // (tailscale) from /api/vpn-check and shows the login / VPN screen.
  app.use("/api/*", authGuard(authMode, auth, db));
  app.get("/api/vpn-check", (c) => c.json({ vpn: true }));
  // Passkey registration/management: after the guard, so a session is required
  // by mount position (the public assertion routes are registered above).
  app.route("/api", passkeyManagementRoutes(authMode, passkeyCtx));
  // Principal management: also after the guard. Its router adds the narrower
  // owner-only check after authentication has resolved the caller principal.
  app.route(
    "/api",
    principalManagementRoutes(authMode, auth, {
      db,
      revoker: host,
      log: authLog,
    })
  );
  app.route(
    "/api",
    createStatusRoutes({
      sourceCommit: config.sourceCommit,
      getCronStatus: () => cron.getCronStatus(),
      isTurnActive: () => host.coordinator.isTurnActive(),
      // Undefined when the injected consumer cannot be read back (a real OTel
      // SDK exports elsewhere), in which case the field is simply absent.
      getMetrics: () => observability.metrics?.snapshot(),
      // Chat's runtime beside what scheduled syncs ran (#290). A failed read
      // leaves the sync half out rather than failing the status.
      getRuntime: () => {
        const snapshot = activity.runtime.snapshot();
        try {
          return { ...snapshot, sync: readSyncRuntime(db) };
        } catch {
          return snapshot;
        }
      },
      getSubscription: () => subscription.status(),
    })
  );
  app.route(
    "/api",
    createBrainRoutes({ brain, brainPath: config.brainPath, keyterms, brainCliMinimum, log: observability.logger("brain") })
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
  app.route("/api", createQueueRoutes(intake));
  app.route("/api", createTrackRoutes(config.brainPath));
  app.route(
    "/api",
    createShareRoutes({
      brainRoot: config.brainPath,
      intake,
      allowedOrigins,
      trustProxy: auth.trustProxy,
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
  app.route("/api", createToolPermissionRoutes({ db, log: dbLog }));
  app.route(
    "/api",
    createSkillRoutes({
      brainPath: config.brainPath,
      syncSkills: () => brain.skillsSync(),
      log: observability.logger("skills"),
    })
  );
  app.route(
    "/api",
    createGraphRoutes({ brainRoot: config.brainPath, log: observability.logger("graph") })
  );

  app.route(
    "/api",
    createGeoRoutes({ config: config.coastline, log: observability.logger("geo") })
  );

  // WebSocket endpoint. Browsers can't set headers on the WS handshake, so the
  // upgrade authenticates via the session cookie (or IP/proxy header) INSIDE
  // the handler — no header-modifying middleware may sit on a genuine upgrade.
  app.get("/ws", async (c, next) => {
    if (!isSameOriginRequest(c, allowedOrigins, auth.trustProxy)) {
      return c.json({ error: "Cross-origin WebSocket rejected" }, 403);
    }
    const principal = await isWsAuthorized(c, authMode, auth, db);
    if (!principal) {
      return c.json({ error: "Authentication required" }, 401);
    }
    c.set("principal", principal);
    if (!host.clients.hasCapacity()) {
      host.reportRefusedConnection();
      return c.text("WebSocket connection limit reached", 503);
    }
    if (!isWebSocketUpgradeAttempt(c.req.raw)) {
      return c.json({ error: "WebSocket upgrade required" }, 400);
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
    close: async () => {
      await inbox.close();
      host.close();
      subscription.close();
      await intake.close();
      await scratchPrune.close();
      activity.close();
      db.close();
    },
  };
}

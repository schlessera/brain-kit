import { recordGovernanceEvent } from "./governance/events.js";
import { createPolicyProposals } from "./brain/policy-proposal.js";
import { createAgentPolicyRoutes } from "./routes/agent-policy.js";
import { createPolicyProposalRoutes } from "./routes/policy-proposals.js";
import { createTurnBudgets } from "./brain/turn-budgets.js";
import { createTrackRoutes } from "./routes/tracks.js";
import { createAccountPartitionKeys } from "./middleware/account-partition.js";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { basename, dirname, join, resolve } from "path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createTurnJournal } from "./brain/turn-journal.js";
import { createJournalRoutes } from "./routes/journal.js";
import { createTurnReverts } from "./brain/turn-revert.js";
import { createTurnRevertRoutes } from "./routes/turn-revert.js";
import { ambientExecConfig, resolveServerConfig, subprocessEnv, type ServerConfig } from "./config/env.js";
import { createHealthRoutes, createStatusRoutes } from "./routes/health.js";
import { createSubscriptionMonitor, parseMintedAt } from "./agent/subscription.js";
import { probeWorkerHostRecorded, ROOT_SERVER_WARNING, serverRunsAsRoot } from "./agent/worker-host.js";
import type { WorkerHostMode } from "./activity/runtime-status.js";
import { workerLimitsStatus, type WorkerHostProbe } from "@schlessera/brain-ui-sdk/internal";
import type { WorkerHostStatus } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainRoutes } from "./routes/brain.js";
import { createSessionProfiles } from "./ws/session-profiles.js";
import { createSessionProfileRoutes } from "./routes/session-profiles.js";
import { createSessionRoutes } from "./routes/sessions.js";
import { createDraftRoutes } from "./routes/drafts.js";
import { createSessionRecoveryRoutes } from "./routes/session-recovery.js";
import { supportsSessionRecovery } from "./ws/recovery.js";
import { createDraftStore } from "./drafts/store.js";
import { createActivityRoutes } from "./routes/activity.js";
import { createGovernanceRoutes } from "./routes/governance.js";
import { createTranscriptionRoutes } from "./routes/transcriptions.js";
import { createTranscriptionStore } from "./voice/transcription-store.js";
import { createVoiceRoutes } from "./routes/voice.js";
import { createFilesRoutes, HTML_PREVIEW_CSP, HTML_PREVIEW_PATH } from "./routes/files.js";
import { createInboxIntake } from "./inbox/intake.js";
import { createQueueRoutes } from "./routes/queue.js";
import { createScheduleRoutes } from "./routes/schedules.js";
import { createScheduleService, gitCheckIgnored } from "./schedules/service.js";
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
import { createCoreQueryAccess } from "./core-queries.js";
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
import { createModuleRoutes } from "./routes/modules.js";
import { createUiDb } from "./db/client.js";
import { createInboxBridgeTools } from "./inbox/bridge-tools.js";
import { createInboxStore } from "./inbox/store.js";
import { createHygieneReview } from "./inbox/hygiene-review.js";
import { createHygieneReviewRoutes } from "./routes/hygiene-review.js";
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
import type { InboxQueueItem } from "@schlessera/brain-ui-sdk/protocol";
import { createInboxRuntime } from "./inbox/runtime.js";
import { createInboxDispatcher, type InboxDispatcher } from "./inbox/dispatcher.js";
import { createInboxOperationEnvelope } from "./inbox/envelope.js";
import { INBOX_DISPATCH_FIXTURE, type InboxDispatchFixtureOptions } from "./inbox/dispatch-fixture.js";
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
import { boundaryPlanner } from "./brain/application.js";
import { coalesced, createHostExecution } from "./brain/host-execution.js";
import { createGovernedTurns } from "./brain/governed-turn.js";
import type { BackendVersionRequirements, ExecWrapperConfig, LiveConversationProvider, SpeechProvider } from "@schlessera/brain-ui-sdk/server";
import { validateVersionMinimum } from "@schlessera/brain-ui-sdk/server";
import { createCronScheduler } from "./cron/scheduler.js";
import { createScratchPins } from "./cron/scratch-pins.js";
import { startScratchPrune } from "./cron/scratch-prune.js";
import { WsHost } from "./ws/host.js";
import { createWsUpgrade, websocket } from "./ws/connection.js";
import { createSessionCatalog } from "./ws/session-catalog.js";
import { createJevClient, createTurnClassifier } from "./classification/index.js";
import { createLabeller, type LabellerOptions } from "./labels/labeller.js";
import type { KeytermSettings } from "./voice/keyterm-builder.js";
import { createObservability, type Observability } from "./observability/index.js";
import { isSameOriginRequest, originPolicy } from "./middleware/origin.js";
import type { AppEnv } from "./app-env.js";

import { assertOperationalStateOutsideBrain, operationalStateMasks } from "./brain/operational-state.js";

export type { AppRenderer };

/** Explicit host minima for independently resolved content and backend runtimes. */
export interface HostVersionRequirements {
  brainCli?: string;
  backends?: Readonly<Record<string, BackendVersionRequirements>>;
}

export interface CreateAppOptions {
  /** Tighten ordinary hosted turns to the read-only brain profile. Default: governed. */
  workerProfile?: "governed" | "strict";
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
  /**
   * External dictation provider, used ahead of automatic built-in discovery.
   * An explicit config.voice.provider must match its id; failures never select
   * another provider. Register a matching AsrClient in the client UI root.
   * @experimental Part of the SpeechProvider seam until 1.0.
   */
  speechProvider?: SpeechProvider;
  /**
   * Live-conversation provider (#957), registered separately from dictation.
   * Absent: the host does not advertise `liveConversation` and refuses the
   * `conversation_*` frames. Validated at startup; an invalid one throws.
   * @experimental Part of the LiveConversationProvider seam until 1.0.
   */
  conversationProvider?: LiveConversationProvider;
  /**
   * The small, fast model that labels working-session and pending follow-up
   * pills with a few words (#1004): any value of core's `CompletionProvider`
   * shape, separate from every session's chat model. Absent, which is the
   * default, labels nothing and pills print the session title or the start of
   * the prompt. When set, the text of every queued follow-up and of every
   * turn's request is sent to this provider, which may be a different vendor
   * from the session's backend. Every call that reaches the provider is a
   * `pill label` Activity run on the session it labels, priced only when the
   * provider reports usage and a model (`completeWithUsage`) and `billing` is
   * set; any other call is unpriced, never $0 (#1083).
   */
  labeller?: LabellerOptions;
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
  // The exec wrapper is a privilege boundary, so a configuration built before
  // `ServerConfig.exec` existed keeps the ambient one instead of spawning
  // unwrapped. Resolved here, once; every spawn below uses `config.exec`.
  const config: ServerConfig & { exec: ExecWrapperConfig } = {
    ...resolved,
    ...(options.dbPath !== undefined ? { dbPath: options.dbPath } : {}),
    exec: resolved.exec ?? ambientExecConfig(),
  };
  // First thing built, because everything below may want to report — including
  // the auth validation that can refuse to boot and the migration runner.
  const observability =
    options.observability ?? createObservability({ minSeverity: config.logLevel });
  const ephemeralJournal = config.dbPath === "" || config.dbPath === ":memory:";
  const journalRoot = ephemeralJournal ? mkdtempSync(join(tmpdir(), "brain-ui-journal-"))
    : join(dirname(resolve(config.dbPath)), `${basename(config.dbPath)}.journal`);
  const privateStatePaths = config.inbox?.pokeTokenFile
    ? [{ setting: "BRAIN_UI_INBOX_POKE_TOKEN_FILE", path: config.inbox.pokeTokenFile }] : [];
  privateStatePaths.push({ setting: "turn journal", path: journalRoot });
  try { assertOperationalStateOutsideBrain({ brainPath: config.brainPath, dbPath: config.dbPath, privateStatePaths }); }
  catch (error) {
    if (ephemeralJournal) rmSync(journalRoot, { recursive: true, force: true });
    observability.logger("brain").emit({ severityText: "ERROR", body: (error as Error).message,
      attributes: { "boot.refusal": (error as Error).name } });
    throw error;
  }
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
  //
  // The host execution boundary (#1648) comes first: before anything
  // evaluates the brain (the CLI version probe below runs the brain's own
  // CLI), every governed turn a dead server left mid-turn is reconciled, and
  // whatever protected file it created is quarantined.
  const brainLog = observability.logger("brain");
  // The boundary reads the latest ordinary worker host probe the server
  // recorded; before the activity runtime exists, the boot probe below is
  // taken here, once, and recorded with the others.
  let runtimeStatus: { snapshot(): { workerHost?: WorkerHostStatus } } | undefined;
  let bootOrdinary: WorkerHostProbe | undefined;
  // Claude workers also need their private runtime-state tmpfs (#1625).
  const workerStateBytes = (config.agent.backend ?? "claude") === "claude" ? config.agent.workerStateBytes : undefined;
  // Every worker has the same admitted private turn-temp allowance (#1703).
  const turnTempBytes = config.agent.turnTempBytes;
  const latestOrdinary = (): WorkerHostProbe => {
    const recorded = runtimeStatus?.snapshot().workerHost?.ordinary;
    if (recorded) return recorded.available ? { ok: true } : { ok: false, requirement: recorded.requirement };
    return bootOrdinary ??= probeWorkerHostRecorded(config.brainPath, "ordinary", undefined, "boot", workerStateBytes, turnTempBytes);
  };
  const hostExecution = createHostExecution({ profile: options.workerProfile, brainPath: config.brainPath, dbPath: config.dbPath, exec: config.exec, maintenanceTemp: config.maintenanceTemp, privateStatePaths,
    ...(subprocessEnv("brainCli").HOME ? { home: subprocessEnv("brainCli").HOME! } : {}), log: brainLog, workerHost: latestOrdinary });
  const boundary = hostExecution.boundary;
  const reconciled = (results: ReturnType<typeof hostExecution.attach>) => {
    for (const result of results) {
      brainLog.emit({ severityText: "WARN", body: `reconciled governed turn ${result.turnId} after an unclean stop: `
        + `quarantined ${result.quarantined.length} protected path(s)${result.failed.length ? `, ${result.failed.length} could not be moved` : ""}`,
        attributes: { "turn.id": result.turnId } });
    }
  };
  // Only an existing database can hold a manifest, and a refused boot below
  // must still leave no new database behind.
  reconciled(hostExecution.reconcileExisting());
  let inboxPokeAuth: ReturnType<typeof createInboxPokeAuth>;
  try {
    await probeBrainCliVersion(config.brainPath, brainLog, { exec: config.exec, minimumVersion: brainCliMinimum, boundary });
    // Provision the independently authorized runtime file before opening handles.
    inboxPokeAuth = createInboxPokeAuth(config.inbox?.pokeTokenFile ?? null);
  } catch (error) { hostExecution.release(); throw error; }
  const dbLog = observability.logger("db");
  let db: ReturnType<typeof createUiDb>;
  try { db = createUiDb(config.dbPath, { log: dbLog }); }
  catch (error) { hostExecution.release(); throw error; }
  try {
    reconciled(hostExecution.attach(db));
    assertInboxRecoveryReady(db);
  } catch (error) { hostExecution.release(); db.close(); throw error; }
  // One package-local pricing instance, shared by admission and Activity.
  // Refresh warms in the background; resolve() is synchronous and rollups
  // never wait on the network.
  const pricing = createModelPricing({
    brainPath: config.brainPath,
    enabled: config.pricing.enabled,
    ttlMs: config.pricing.ttlMs,
  });
  void pricing.ensureFresh();
  // Recovery/heartbeat only. Production dispatch stays gated (#689 ruling):
  // no config, environment or default constructs a dispatcher. Only the
  // repository's fixture host, through a symbol no package entry exports,
  // wires the production engine to prove its lifecycle.
  const dispatchFixture = (options as InboxDispatchFixtureOptions)[INBOX_DISPATCH_FIXTURE];
  if (dispatchFixture && !config.inbox?.budget) { db.close(); throw new Error("The dispatch fixture requires an inbox budget"); }
  const inboxBudget = config.inbox?.budget ? { config: config.inbox.budget, pricing,
    maxAutonomousRuns: config.inbox.maxAutonomousRuns } : undefined;
  let dispatcher: InboxDispatcher | undefined;
  const engine = dispatchFixture ? {
    route: (signal: AbortSignal) => dispatcher ? dispatcher.route(signal) : Promise.resolve(),
    claimable: (item: InboxQueueItem) => dispatcher?.claimable(item) ?? false,
    operation: (item: InboxQueueItem) => { if (!dispatcher) throw new Error("Dispatcher is not ready"); return dispatcher.operation(item); },
    dispatch: (item: InboxQueueItem, signal: AbortSignal) => dispatcher ? dispatcher.dispatch(item, signal) : Promise.reject(new Error("Dispatcher is not ready")),
  } : {};
  const inbox = createInboxRuntime(db, { log: observability.logger("inbox"),
    brainRoot: config.brainPath, budget: inboxBudget, now: dispatchFixture?.now, afterCleanupRemove: dispatchFixture?.afterCleanupRemove, ...engine });
  prunePrincipals(db, Date.now());
  const intake = createInboxIntake(db, config.brainPath, observability.logger("inbox"));
  try { await inbox.ready; await intake.reconcile(); } catch (error) { await inbox.close(); db.close(); throw error; }
  const brain = createBrainClient({ brainPath: config.brainPath, exec: config.exec, minimumVersion: brainCliMinimum, log: brainLog, boundary });
  // After a curated application, a credential-free worker indexed the change
  // without provider keys (#1648). The credentialed reindex that fills in its
  // vectors waits for the writer gate; one at a time, and one more if more
  // changes arrived meanwhile.
  const keyedReindex = coalesced(() => brain.index(), error => brainLog.emit({ severityText: "WARN",
    body: `the keyed reindex after an application failed: ${error instanceof Error ? error.message : String(error)}` }));
  const applicationPlanner = boundaryPlanner(boundary, { afterIndex: keyedReindex });
  const hygieneReview = createHygieneReview(db, { brain, timeZone: config.inbox?.budget?.timeZone,
    // Exact-operation approval stays fail-closed unless the gated engine runs.
    ...(dispatchFixture ? { allowedOperations: createInboxOperationEnvelope(db) } : {}) });
  try { await hygieneReview.recover(); } catch (error) { await inbox.close(); db.close(); throw error; }

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
      maintenance: boundary.maintenance,
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
  const scratchPins = createScratchPins(config.brainPath, registry);
  const scratchPrune = startScratchPrune({ brain, pins: scratchPins, db, log: observability.logger("cron") });
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
  // Per-session composer drafts (#979): the UI's operational database, one
  // namespace for this host, shared by its principals.
  const drafts = createDraftStore(db);
  const governedTurns = createGovernedTurns({ brainPath: config.brainPath, execution: hostExecution,
      profile: options.workerProfile ?? "governed",
      recordPolicy: (turnId, origin, profile, policy) => db.query(`INSERT INTO turn_governance_policy
        (turn_id, origin, profile, policy_hash, source, policy, errors, admitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(turnId, origin, profile, policy.hash, policy.source, JSON.stringify(policy.policy), JSON.stringify(policy.errors), Date.now()),
      maskPaths: operationalStateMasks({ brainPath: config.brainPath, dbPath: config.dbPath, privateStatePaths }),
      index: lock => brain.index({ lock }), report: message => brainLog.emit({ severityText: "WARN", body: message }) });
  const budgets = createTurnBudgets(db, pricing);
  const sessionProfiles = createSessionProfiles(db, governedTurns, budgets);
  const journal = createTurnJournal(db, { brainPath: config.brainPath, dbPath: config.dbPath, objectsRoot: journalRoot,
    changed(turnId, sessionId, summary) { host.clients.broadcast({ type: "turn_journal", sessionId, turnId, journal: { ...summary, ...(host.budgets?.saved(turnId) ? { budget: host.budgets.saved(turnId) } : {}) } }); } });
  const policyProposals = createPolicyProposals({ root: config.brainPath, db,
    lock: { withLock: (key, fn, admission) => host.workerLock.withLock(key, fn, admission) },
    observeUserPolicy: (turnId, write) => journal.observeUserPolicy(turnId, write),
    recordEvent: (review, turn) => recordGovernanceEvent(db, { kind: "policy_change", actor: "user", turnId: turn.turnId, sessionId: turn.sessionId(), model: null, profile: null,
      payload: { requestId: review.requestId, baseHash: review.baseHash, proposedHash: review.proposedHash, sections: review.sections, outcome: "updated" }, dedupeKey: `${turn.turnId}:${review.requestId}` }),
  });
  const host = new WsHost({
    policyProposals,
    journal,
    governedTurns,
    sessionProfiles,
    maintenance: boundary.maintenance,
    budgets,
    applicationPlanner,
    drafts,
    brainPath: config.brainPath,
    registry,
    observability,
    catalog: createSessionCatalog(() => db, dbLog, scratchPins),
    // Exact-operation approvals remain fail-closed until the full-v1 engine
    // wires current server authority. Dismiss/cancel/snooze need no grant.
    inboxTools: createInboxBridgeTools(db, intake, hygieneReview.resolver),
    inbox: createInboxStream(createInboxStore(db), db, observability.logger("inbox"),
      hygieneReview.resolver),
    classifier,
    labeller: createLabeller({
      options: options.labeller ?? null,
      log: observability.logger("labels"),
      meter: observability.meter("labels"),
      activity: { store: activity.store, onWrite: () => activity.stream.pump() },
    }),
    scratchPrune: () => scratchPrune.tick(),
    ...(options.conversationProvider ? { conversationProvider: options.conversationProvider } : {}),
    ...(options.appName ? { appName: options.appName } : {}),
    // Explicit option wins; then the env-resolved config; then the host default.
    ...(options.turnTimeoutMs ?? config.turnTimeoutMs
      ? { turnTimeoutMs: (options.turnTimeoutMs ?? config.turnTimeoutMs)! }
      : {}),
    maxConcurrentSessions: () => config.maxConcurrentSessions,
    askUserFormLimits: config.askUserFormLimits,
    wsRate: config.wsRate,
    wsMaxConnections: config.wsMaxConnections,
    isPrincipalAuthorized: (id) => {
      const current = resolvePrincipal(db, id);
      return current !== null && isUsablePrincipal(current, Date.now());
    },
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
      governance: activity.governance,
      governanceDb: db,
    },
  });
  if (dispatchFixture && inboxBudget) dispatcher = createInboxDispatcher(db, { brainRoot: config.brainPath,
    select: () => dispatchFixture.select(registry), budget: inboxBudget, fetch: dispatchFixture.fetch, now: dispatchFixture.now,
    classification: { apiKey: dispatchFixture.classificationKey ?? config.classification.apiKey },
    store: activity.store, runtime: activity.runtime, onWrite: () => activity.stream.pump(), log: observability.logger("inbox") });
  // The agent worker boundary, probed now (#1632) so the server knows at boot
  // whether this host can run a turn, and says so in the log, on /api/status
  // and in the client. Unlike a missing runtime, a failure does not refuse
  // the boot: everything but agent turns still works. Nor does it decide any
  // turn: each one runs its own probe, which re-records the outcome. The
  // restricted envelope only matters while autonomous work can run.
  const workerHostModes: WorkerHostMode[] = dispatcher ? ["ordinary", "restricted"] : ["ordinary"];
  // Claude workers also need their private runtime-state tmpfs (#1625).
  for (const mode of workerHostModes) {
    // The ordinary boot probe may already have run for the host boundary.
    if (mode === "ordinary" && bootOrdinary) {
      activity.runtime.recordWorkerHost(mode, bootOrdinary, "boot");
      activity.runtime.recordWorkerLimits(workerLimitsStatus());
    }
    else probeWorkerHostRecorded(config.brainPath, mode, activity.runtime, "boot", workerStateBytes, turnTempBytes);
  }
  runtimeStatus = activity.runtime;
  // Whether governed can run, and where the brain's own code is evaluated
  // (#1648): stated in the log and on /api/status, decided by the same
  // boundary that routes every evaluation.
  activity.runtime.recordGoverned(boundary.status());
  // A root-run server still boots (#1629, #1638), but its workers keep root's
  // reads and Unix-socket reach: warned once here, and kept on the status.
  if (serverRunsAsRoot()) activity.runtime.recordRootServer(ROOT_SERVER_WARNING);
  // Scheduled-task definitions and ledger (#914). Storage only: no dispatcher
  // is wired, so every task reports dispatch_disabled until #915/#689.
  const scheduleOrigins = config.schedules?.inferenceOrigins ?? null;
  const schedules = createScheduleService(db, {
    brainRoot: config.brainPath,
    gitIgnored: gitCheckIgnored(config.brainPath, boundary),
    executionPolicy: async () => {
      if (scheduleOrigins === null) return null;
      // The backend that owns the preferred profile, as a turn would resolve it.
      const profileId = await registry.getPreferredProfileId();
      const backendId = profileId === null ? await registry.getDefaultBackendId()
        : (await registry.getBackendForProfile(profileId))?.id;
      return backendId ? { backendId, profileId, inferenceOrigins: scheduleOrigins } : null;
    },
  });
  try { await schedules.ready; }
  catch { observability.logger("schedules").emit({ severityText: "WARN", body: "schedule journal reconciliation failed; journals retained" }); }
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
  // One lazily resolved core query access per app: the graph view and the
  // voice vocabulary share its single resolution of the optional peer.
  const coreQueries = createCoreQueryAccess({ log: observability.logger("core-queries") });
  const keyterms: KeytermSettings = {
    brainPath: config.brainPath,
    cacheDir: config.voice.cacheDir,
    limit: config.voice.keytermLimit,
    log: observability.logger("voice"),
    queries: coreQueries,
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
  // supplies its own frame-ancestors directive. The one exception is a
  // successful interactive HTML preview (#1084): it carries the sandboxing
  // CSP with `frame-ancestors 'self'`, so the file viewer may frame it.
  app.use("*", async (c, next) => {
    if (c.req.path === "/ws" && isWebSocketUpgradeAttempt(c.req.raw)) return next();
    await next();
    const sandboxedPreview =
      c.req.path === HTML_PREVIEW_PATH &&
      c.res.headers.get("Content-Security-Policy") === HTML_PREVIEW_CSP;
    c.header("X-Frame-Options", sandboxedPreview ? "SAMEORIGIN" : "DENY");
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
        // If-Match and Idempotency-Key carry draft revisions and receipts (#979).
        allowHeaders: ["Content-Type", "If-Match", "Idempotency-Key", "Content-SHA256"],
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
  // The account partition key rides on the probe every client already makes
  // before it mounts anything (#1014): an agent principal gets none.
  const accountKeys = createAccountPartitionKeys(db, config.brainPath, authMode);
  app.get("/api/vpn-check", (c) => {
    const accountKey = accountKeys(c.get("principal"));
    return c.json(accountKey ? { vpn: true, accountKey } : { vpn: true });
  });
  // Passkey registration/management: after the guard, so a session is required
  // by mount position (the public assertion routes are registered above).
  app.route("/api", passkeyManagementRoutes(authMode, passkeyCtx));
  app.route("/api", createHygieneReviewRoutes(hygieneReview));
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
      // "Check again" (#1632): the boot probes, re-run now and recorded.
      checkWorkerHost: () => {
        for (const mode of workerHostModes) probeWorkerHostRecorded(config.brainPath, mode, activity.runtime, "check", workerStateBytes, turnTempBytes);
        activity.runtime.recordGoverned(boundary.status());
        return activity.runtime.snapshot().workerHost ?? {};
      },
    })
  );
  app.route(
    "/api",
    createBrainRoutes({ brain, brainPath: config.brainPath, exec: config.exec, keyterms, brainCliMinimum, log: brainLog, boundary })
  );
  app.route("/api", createSessionProfileRoutes(sessionProfiles));
  app.route("/api", createSessionRoutes({ registry, db, labels: host.labels !== null, prepareHistory: (id, messages) => host.prepareHistory(id, messages) }));
  app.route("/api", createJournalRoutes({ journal }));
  const reverts = createTurnReverts(db, { brainPath: config.brainPath, journal, gate: hostExecution.gate()!, lock: host.workerLock,
    isAuthorized(id) { const principal = resolvePrincipal(db, id); return !!principal && ["owner", "ambient"].includes(principal.kind) && isUsablePrincipal(principal, Date.now()); },
    refresh() { host.governedTurns?.refresh(host.workerLock); } });
  host.turnReverts = reverts;
  app.route("/api", createTurnRevertRoutes(reverts));
  // Only where server_hello advertises it: elsewhere the route is absent,
  // which a client reads as a host too old to answer (#964).
  if (supportsSessionRecovery(host)) app.route("/api", createSessionRecoveryRoutes(host));
  app.route("/api", createPolicyProposalRoutes(host));
  app.route("/api", createAgentPolicyRoutes(host, () => activity.runtime.snapshot().workerHost?.limits ?? null));
  app.route("/api", createDraftRoutes(drafts));
  // Behind the guard by mount position, like /api/status: the activity
  // record leaks strictly more (session activity, errors, spend).
  app.route("/api", createActivityRoutes({ db, store: activity.store, notifier: activity.notifier, actionNotices: activity.actionNotices }));
  app.route("/api", createPushRoutes({ sender: activity.pushSender, notices: activity.actionNotices }));
  app.route("/api", createVoiceRoutes({ voice: config.voice, keyterms, speechProvider: options.speechProvider }));
  const transcriptions = createTranscriptionStore(db, accountKeys);
  app.route("/api", createTranscriptionRoutes({ store: transcriptions, voice: config.voice, keyterms, speechProvider: options.speechProvider }));
  app.route(
    "/api",
    createFilesRoutes({ brainRoot: config.brainPath, log: observability.logger("files") })
  );
  app.route("/api", createQueueRoutes(intake));
  app.route("/api", createScheduleRoutes(schedules));
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
  app.route("/api", createModuleRoutes(brain));
  app.route("/api", createGovernanceRoutes({ db }));
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
    createGraphRoutes({ brainRoot: config.brainPath, log: observability.logger("graph"), queries: coreQueries })
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
      scratchPins.close();
      await reverts.close();
      // A keyed reindex still queued finishes before the gate's database closes.
      await keyedReindex.idle();
      await host.governedTurns?.close();
      journal.close();
      if (ephemeralJournal) rmSync(journalRoot, { recursive: true, force: true });
      activity.close();
      db.close();
    },
  };
}

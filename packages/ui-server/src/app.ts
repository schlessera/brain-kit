import { createStorageHistory } from "./storage/history-store.js";
import { aggregateCollection } from "./storage/history-model.js";
import { createSharedStorageScan } from "./storage/shared-scan.js";
import { createStorageNotifier } from "./storage/notify.js";
import { createStorageGuidance } from "./storage/guidance.js";
import { createStorageSampling } from "./storage/sampling.js";
import storagePackage from "../package.json" with { type: "json" };
import { createStorageRemoval } from "./storage/removal.js";
import { createStorageRemovalRoutes } from "./routes/storage-removal.js";
import { createStorageMaintenance } from "./storage/maintenance.js";
import { createStorageMaintenanceRoutes } from "./routes/storage-maintenance.js";
import { createStorageCoordinator } from "./storage/coordinator.js";
import { createStorageRoutes } from "./routes/storage.js";
import type { StorageStore } from "./storage/collect.js";
import { createPolicyProposals } from "./brain/policy-proposal.js";
import { createAgentPolicyRoutes } from "./routes/agent-policy.js";
import { createPolicyProposalRoutes } from "./routes/policy-proposals.js";
import { createTurnBudgets } from "./brain/turn-budgets.js";
import { maintenanceProviderMeter } from "./brain/provider-meter.js";
import { createTrackRoutes } from "./routes/tracks.js";
import { createAccountPartitionKeys } from "./middleware/account-partition.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Database } from "bun:sqlite";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { basename, dirname, join, resolve } from "path";
import { lstatSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createTurnScope } from "./brain/turn-scope.js";
import { createTurnJournal } from "./brain/turn-journal.js";
import { createJournalRoutes } from "./routes/journal.js";
import { createTurnReverts } from "./brain/turn-revert.js";
import { createTurnRevertRoutes } from "./routes/turn-revert.js";
import { ambientExecConfig, referenceCredentialValues, resolveServerConfig, subprocessEnv, type ServerConfig } from "./config/env.js";
import { declaredContentRenderers } from "./brain/content-renderers.js";
import { createHealthRoutes, createStatusRoutes } from "./routes/health.js";
import { createSubscriptionMonitor, parseMintedAt } from "./agent/subscription.js";
import { probeWorkerHostRecorded, probeWorkerHostRecordedAsync, ROOT_SERVER_WARNING, serverRunsAsRoot } from "./agent/worker-host.js";
import type { WorkerHostMode } from "./activity/runtime-status.js";
import { createNativeBrainManagerClient, PROVIDER_CACHE_FILES, workerLimitsStatus, type WorkerHostProbe } from "@schlessera/brain-ui-sdk/internal";
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
  createLoginRateLimiter,
  authRoutes,
  isWsAuthorized,
  type AuthMode,
  type AuthRuntime,
} from "./middleware/auth.js";
import {
  createPasskeyChallenges,
  passkeyPublicRoutes,
  passkeyManagementRoutes,
  passwordLoginDisabled,
  assertPasskeyConfig,
  type PasskeyContext,
} from "./middleware/passkeys.js";
import { principalManagementRoutes } from "./middleware/principals.js";
import { createModuleRoutes } from "./routes/modules.js";
import { createUiDb } from "./db/client.js";
import { openSqliteWriter, procedureCaller } from "./db/write-worker.js";
import * as governedTurnWrites from "./brain/governed-turn-writes.js";
import { registerPrincipalWrites } from "./db/principal-writes.js";
import { JOURNAL_SCHEMA, journalDatabasePath } from "./db/journal-database.js";
import { createInboxBridgeTools } from "./inbox/bridge-tools.js";
import { createInboxStore } from "./inbox/store.js";
import { registerInboxWrites } from "./inbox/write-runtime.js";
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
import { createIndexBatch } from "./brain/index-batch.js";
import { INDEX_READ_ROUTES, indexReadBarrier } from "./routes/index-barrier.js";
import { coalesced, createHostExecution } from "./brain/host-execution.js";
import { ensureIndexDirectory, retireLegacyIndex } from "./brain/index-directory.js";
import { createGovernedTurns } from "./brain/governed-turn.js";
import { createProviderExposures } from "./brain/provider-exposure.js";
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

import { createNativeBrainLeaseManager } from "./brain/native-brain-leases.js";
import { createReferenceSources } from "./brain/reference-source.js";
import { createReferenceTools } from "./brain/reference-tools.js";
import { createReferenceTransport } from "./brain/reference-transport.js";
import { createReferenceWorktreeHygiene } from "./brain/reference-worktree-hygiene.js";
import { createReferenceWorktrees, forgetReferenceWorktreeCheckpoint, recordReferenceWorktreeCheckpoint, referenceWorktreeDependents, referenceWorktreeOwner } from "./brain/reference-worktrees.js";
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
   * Refuse new HTTP requests and drain admitted handlers before disposing of
   * their operational state. Stalled request bodies are cancelled on close.
   * Module metadata still waiting for execution admission is cancelled at
   * once. In-flight brain CLI reads, metadata and plain index runs get a 10 s
   * grace period and are then cancelled; every other run keeps its existing
   * shutdown behaviour.
   */
  close(): Promise<void>;
}

/**
 * How long close() lets in-flight brain CLI runs finish before cancelling
 * shared ones (#2473). Long enough for an ordinary follow-up index to finish,
 * short enough to bound shutdown well inside a 30 s hook.
 */
const CLOSE_GRACE_MS = 10_000;

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
  if (!config.nativeBrain) throw new Error("Hosted workers require managed Btrfs storage. Configure the native brain manager and BRAIN_UI_NATIVE_BRAIN_SOCKET; full-copy fallback is unsupported.");
  const nativeClient = createNativeBrainManagerClient(config.nativeBrain);
  const nativeReady = await nativeClient.ready();
  if (realpathSync(config.brainPath) !== nativeReady.brainPath) throw new Error("The native storage manager serves a different brain. Correct the configured managed brain path before starting hosted workers.");
  const ephemeralJournal = config.dbPath === "" || config.dbPath === ":memory:";
  if (ephemeralJournal && !config.nativeBrain.leasePath) throw new Error("An ephemeral UI database requires BRAIN_UI_NATIVE_BRAIN_LEASE_PATH outside the brain for durable native checkpoint ownership.");
  const nativeLeasePath = resolve(config.nativeBrain.leasePath ?? `${config.dbPath}.native-leases.sqlite`);
  const journalRoot = ephemeralJournal ? mkdtempSync(join(tmpdir(), "brain-ui-journal-"))
    : join(dirname(resolve(config.dbPath)), `${basename(config.dbPath)}.journal`);
  const storageCacheRoot = `${journalRoot}.storage-cache`;
  const privateStatePaths = config.inbox?.pokeTokenFile
    ? [{ setting: "BRAIN_UI_INBOX_POKE_TOKEN_FILE", path: config.inbox.pokeTokenFile }] : [];
  privateStatePaths.push({ setting: "Storage transfer cache", path: storageCacheRoot }, { setting: "turn journal", path: journalRoot }, { setting: "BRAIN_UI_NATIVE_BRAIN_LEASE_PATH", path: nativeLeasePath });
  // The manager verifies its fixed topology and root-private state. These are
  // exact masks, not app-owned directories to enumerate or mask by parent.
  const nativeMaskPaths = nativeReady.privatePaths;
  try { assertOperationalStateOutsideBrain({ brainPath: config.brainPath, dbPath: config.dbPath, privateStatePaths }); }
  catch (error) {
    if (ephemeralJournal) rmSync(journalRoot, { recursive: true, force: true });
    observability.logger("brain").emit({ severityText: "ERROR", body: (error as Error).message,
      attributes: { "boot.refusal": (error as Error).name } });
    throw error;
  }
  const nativeLeases = await createNativeBrainLeaseManager(nativeClient, { statePath: nativeLeasePath, brainPath: nativeReady.brainPath, fsid: nativeReady.fsid, brainUuid: nativeReady.brainUuid })
    .catch(error => { if (ephemeralJournal) rmSync(journalRoot, { recursive: true, force: true }); throw error; });
  const bootCleanup: (() => void | Promise<void>)[] = [];
  try {
  const nativeRecovery = await nativeLeases.recoverDeadOwners();
  if (nativeRecovery.unknown.length || nativeRecovery.retainedUnverifiable) observability.logger("brain").emit({ severityText: "WARN",
    body: `Native storage recovery retained ${nativeRecovery.unknown.length + nativeRecovery.retainedUnverifiable} unresolved checkpoint ownership record(s). Reconcile the native storage service before reclaiming their capacity.` });
  const nativeManager = nativeLeases.client;
  const probeState = { dbPath: config.dbPath, privateStatePaths };
  // Select from already validated host state; helper/configuration failures
  // remain recorded probe refusals rather than a new boot failure.
  const identitySentinelDirectory = dirname(resolve(config.dbPath && config.dbPath !== ":memory:" ? config.dbPath : nativeLeasePath));
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
    : await probeBackendRuntimes(config.agent, config.brainPath, observability.logger("agent"), undefined, backendRequirements, config.exec);

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
    if (recorded) return recorded.available ? { ok: true, ...(recorded.identity ? { identity: recorded.identity, workerUid: recorded.workerUid } : {}) } : { ok: false, requirement: recorded.requirement };
    return bootOrdinary ??= probeWorkerHostRecorded(config.brainPath, "ordinary", undefined, "boot", workerStateBytes, turnTempBytes, probeState);
  };
  // Credentialed maintenance reaches the CLI's providers through a metered
  // relay where the host has managed native storage (#1673); the budgets it
  // charges are created below.
  let relayBudgets: ReturnType<typeof createTurnBudgets> | undefined;
  const providerRelay = nativeManager ? maintenanceProviderMeter({ brainPath: config.brainPath,
    ...(config.cliProviderOrigins ? { origins: config.cliProviderOrigins } : {}), budgets: () => relayBudgets,
    report: message => brainLog.emit({ severityText: "WARN", body: message }) }) : undefined;
  const hostExecution = createHostExecution({ nativeManager, nativeMaskPaths, ...(providerRelay ? { providerRelay } : {}), profile: options.workerProfile, brainPath: config.brainPath, dbPath: config.dbPath, exec: config.exec, maintenanceTemp: config.maintenanceTemp, privateStatePaths,
    ...(subprocessEnv("brainCli").HOME ? { home: subprocessEnv("brainCli").HOME! } : {}), log: brainLog, workerHost: latestOrdinary });
  bootCleanup.push(() => hostExecution.release());
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
  await boundary.prepare();
  await probeBrainCliVersion(config.brainPath, brainLog, { exec: config.exec, minimumVersion: brainCliMinimum, boundary });
  // The CLI now keeps its index in .brain-index/. Delete the root-level copy
  // an earlier release left (it holds document bodies a provider-restricted
  // turn must not read); the index is rebuilt below, never moved (#1668).
  const legacyIndex = retireLegacyIndex(config.brainPath);
  const legacyCaches = PROVIDER_CACHE_FILES.filter(name => lstatSync(join(config.brainPath, name), { throwIfNoEntry: false })?.isFile());
  // The server, not a worker identity under its own umask in a staged view,
  // creates the index directory, with the brain root's mode, so every later
  // maintenance or turn worker can create SQLite sidecars in it.
  try { ensureIndexDirectory(config.brainPath); }
  catch (error) { brainLog.emit({ severityText: "WARN", body: `the index directory could not be prepared: ${error instanceof Error ? error.message : String(error)}` }); }
  if (legacyIndex.removed.length || legacyIndex.kept.length) brainLog.emit({ severityText: "WARN",
    body: `the search index moved to .brain-index/: removed the old root-level ${legacyIndex.removed.join(", ") || "files"}`
      + (legacyIndex.kept.length ? `; ${legacyIndex.kept.join(", ")} ${legacyIndex.kept.length === 1 ? "is a directory" : "are directories"} and must be removed by hand` : "") });
  // Provision the independently authorized runtime file before opening handles.
  const inboxPokeAuth = createInboxPokeAuth(config.inbox?.pokeTokenFile ?? null);
  const dbLog = observability.logger("db");
  const db = createUiDb(config.dbPath, { log: dbLog });
  bootCleanup.push(() => db.close());
  // Journal and Activity commits run on this worker's connection, off the event loop (#2814).
  // It owns the journal's own file too (#2789), attached as it is here.
  const writer = openSqliteWriter(db, { attach: [{ schema: JOURNAL_SCHEMA, path: journalDatabasePath(config.dbPath) }] });
  // Authentication's per-request principal writes commit on it too (#2850).
  registerPrincipalWrites(db, writer);
  registerInboxWrites(db, writer);
  bootCleanup.push(() => writer.close());
  reconciled(hostExecution.attach(db, writer));
  // Shared reference source (#2429) runs only where the native manager owns a reference pool.
  const referencePoolConfigured = await nativeManager.poolStatus().then(() => true, () => false);
  const referenceSources = referencePoolConfigured ? createReferenceSources({ db, pool: nativeManager, brain: nativeReady.brainUuid, credentials: referenceCredentialValues(),
    transport: createReferenceTransport({ brainPath: config.brainPath, ...(config.maintenanceTemp ? { tempLimits: config.maintenanceTemp } : {}),
      ...(config.dbPath && config.dbPath !== ":memory:" ? { tempDomain: { statePath: resolve(config.dbPath) } } : {}) }), ...(config.referenceSource ? { limits: config.referenceSource } : {}), log: brainLog,
    // Managed worktrees (#2430) keep the source roots they were snapshotted from.
    dependents: rootId => referenceWorktreeDependents(db, rootId) }) : undefined;
  // Worktree lifecycle (#2430); every grant is covered by the turn journal first.
  const referenceWorktrees = referenceSources ? createReferenceWorktrees({ db, pool: nativeManager, sources: referenceSources, log: brainLog,
    // Every grant is covered by the turn journal first; the journal exists once a turn can run.
    coverage: (input, signal) => journal.attachWorktree(input.turnId, input.worktreeId, signal) }) : undefined;
  if (referenceSources) {
    bootCleanup.push(() => referenceSources.close());
    const recovered = await referenceSources.recover().catch((error: Error) => ({ released: [], retained: [error.message] }));
    if (recovered.retained.length) brainLog.emit({ severityText: "WARN", body: `Reference source recovery retained ${recovered.retained.length} unresolved pool root(s).` });
  }
  // The agent tools (#2432) reach both services only through the turn's own access.
  const referenceTools = referenceSources ? createReferenceTools({ sources: referenceSources, ...(referenceWorktrees ? { worktrees: referenceWorktrees } : {}),
    log: brainLog }) : undefined;
  if (referenceWorktrees) {
    bootCleanup.push(() => referenceWorktrees.close());
    const recovered = await referenceWorktrees.recover().catch((error: Error) => ({ discarded: [], closed: [], retained: [error.message] }));
    if (recovered.retained.length) brainLog.emit({ severityText: "WARN", body: `Managed worktree recovery retained ${recovered.retained.length} unresolved worktree or generation record(s).` });
  }
  assertInboxRecoveryReady(db);
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
  if (dispatchFixture && !config.inbox?.budget) throw new Error("The dispatch fixture requires an inbox budget");
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
  bootCleanup.push(() => inbox.close());
  prunePrincipals(db, Date.now());
  const intake = createInboxIntake(db, config.brainPath, observability.logger("inbox"));
  bootCleanup.push(() => intake.close());
  await inbox.ready; await intake.reconcile();
  // Aborted when close() begins: cancels module metadata still waiting for
  // admission. Aborted when close()'s grace period ends: cancels in-flight
  // shared CLI runs, admitted metadata included.
  const closeBegun = new AbortController(), shutdown = new AbortController();
  const brain = createBrainClient({ brainPath: config.brainPath, exec: config.exec, minimumVersion: brainCliMinimum, log: brainLog, boundary, closing: closeBegun.signal, shutdown: shutdown.signal });
  // After a curated application, a credential-free worker indexed the change
  // without provider keys (#1648). The credentialed reindex that fills in its
  // vectors waits for the writer gate; one at a time, and one more if more
  // changes arrived meanwhile.
  // A refresh cancelled by close() is not a failure; every other error still reports.
  const ignoreShutdown = (error: unknown) => { if (error !== shutdown.signal.reason) throw error; };
  const keyedReindex = coalesced(() => brain.index().catch(ignoreShutdown), error => brainLog.emit({ severityText: "WARN",
    body: `the keyed reindex after an application failed: ${error instanceof Error ? error.message : String(error)}` }));
  bootCleanup.push(() => keyedReindex.idle());
  // A migrating brain rebuilds its index in the new directory once, at boot,
  // and that run moves root-level generated-text caches into `.brain-cache/`
  // (#2725): it keeps their lines, so the index run does the move, not the host.
  if (legacyIndex.removed.length || legacyCaches.length) keyedReindex();
  const applicationPlanner = boundaryPlanner(boundary, { afterIndex: keyedReindex });
  // Applications return after their Markdown commits; the paths they changed
  // are indexed together before the next read that needs them (#2835).
  const indexBatch = createIndexBatch({ index: paths => applicationPlanner.index(config.brainPath, undefined, paths) });
  bootCleanup.push(() => indexBatch.idle());
  // Managed worktree findings (#2431) reuse core's hygiene rules; without core there is no review to join.
  const hygieneCore = referenceWorktrees ? await import("@schlessera/brain/internal").catch(() => undefined) : undefined;
  const worktreeHygiene = referenceWorktrees && hygieneCore
    ? createReferenceWorktreeHygiene({ db, worktrees: referenceWorktrees, core: async () => hygieneCore, brainPath: config.brainPath }) : undefined;
  const hygieneReview = createHygieneReview(db, { brain, timeZone: config.inbox?.budget?.timeZone, ...(worktreeHygiene ? { worktrees: worktreeHygiene } : {}),
    // Exact-operation approval stays fail-closed unless the gated engine runs.
    ...(dispatchFixture ? { allowedOperations: createInboxOperationEnvelope(db) } : {}) });
  await hygieneReview.recover();

  // Activity record: span store + live stream + notifications + lifecycle
  // sweeps, owned by the runtime (see activity/runtime.ts).
  const activity = createActivityRuntime(db, {
    log: observability.logger("activity"),
    pricing,
    writer,
    pricingConfig: { brainPath: config.brainPath, enabled: config.pricing.enabled, ttlMs: config.pricing.ttlMs },
  });
  bootCleanup.push(() => activity.close());
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
      exec: config.exec,
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
  bootCleanup.push(() => scratchPins.close());
  const scratchPrune = startScratchPrune({ brain, pins: scratchPins, governance: activity.governanceWrites, log: observability.logger("cron") });
  bootCleanup.push(() => scratchPrune.close());
  // The subscription token (#254): boot warnings now, the expiry check daily,
  // and what /api/status says about it.
  const subscription = createSubscriptionMonitor({
    config: config.subscription,
    log: observability.logger("agent"),
    db,
    lastTurnFailure: () => activity.runtime.subscriptionAuthFailure(),
    modelSource: () => registry.getModelSource(),
  });
  bootCleanup.push(() => subscription.close());
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
    writer,
  });
  // Per-session composer drafts (#979): the UI's operational database, one
  // namespace for this host, shared by its principals.
  const drafts = createDraftStore(db);
  const turnMaskPaths = [...operationalStateMasks({ brainPath: config.brainPath, dbPath: config.dbPath, privateStatePaths }), ...nativeMaskPaths];
  const governedRecords = procedureCaller(db, governedTurnWrites, undefined, writer);
  const governedTurns = createGovernedTurns({ nativeManager, brainPath: config.brainPath, execution: hostExecution,
      profile: options.workerProfile ?? "governed",
      // Admission records commit on the write worker before the turn goes on (#2850).
      recordPolicy: (turnId, origin, profile, policy) => governedRecords("recordPolicy", turnId, origin, profile, policy.hash, policy.source,
        JSON.stringify(policy.policy), JSON.stringify(policy.errors), Date.now()),
      maskPaths: turnMaskPaths,
      index: lock => brain.index({ lock }).catch(ignoreShutdown), report: message => brainLog.emit({ severityText: "WARN", body: message }),
      exposures: createProviderExposures(db, writer), ...(config.providerRecipientOrigins ? { recipientOrigins: config.providerRecipientOrigins } : {}), indexBatch });
  bootCleanup.push(() => governedTurns.close());
  // Budget writes commit on the write worker (#2850).
  const budgets = createTurnBudgets(db, pricing, Date.now, writer);
  relayBudgets = budgets;
  // Catalog rows, and the profile rows and proposal binds that reference
  // them, commit on the write worker (#2850).
  const catalog = createSessionCatalog(() => db, dbLog, scratchPins, { pricing, store: activity.store, governance: activity.governanceWrites, writer,
    pricingConfig: { brainPath: config.brainPath, enabled: config.pricing.enabled, ttlMs: config.pricing.ttlMs } });
  const sessionProfiles = createSessionProfiles(db, governedTurns, budgets, { hardTimeoutMs: () => host.turnTimeoutMs }, { writer, catalog });
  const journal = createTurnJournal(db, { nativeManager, brainPath: config.brainPath, dbPath: config.dbPath, objectsRoot: journalRoot, writer,
    ...(referencePoolConfigured ? { referencePool: nativeManager, referenceCheckpoints: (() => {
      const owner = referenceWorktreeOwner();
      return { record: (id: string, worktreeId: string) => recordReferenceWorktreeCheckpoint(db, owner, id, worktreeId), forget: (id: string) => forgetReferenceWorktreeCheckpoint(db, id) };
    })() } : {}),
    changed(turnId, sessionId, summary) { host.clients.broadcast({ type: "turn_journal", sessionId, turnId, journal: { ...summary, ...(host.budgets?.saved(turnId) ? { budget: host.budgets.saved(turnId) } : {}) } }); } });
  bootCleanup.push(() => journal.close());
  // Startup recovery commits, or refuses boot, before any turn can run.
  await journal.ready;
  const policyProposals = createPolicyProposals({ root: config.brainPath, db, writer,
    lock: { withLock: (key, fn, admission) => host.workerLock.withLock(key, fn, admission) },
    observeUserPolicy: (turnId, write) => journal.observeUserPolicy(turnId, write),
    recordEvent: (review, turn) => activity.governanceWrites.record({ kind: "policy_change", actor: "user", turnId: turn.turnId, sessionId: turn.sessionId(), model: null, profile: null,
      payload: { requestId: review.requestId, baseHash: review.baseHash, proposedHash: review.proposedHash, sections: review.sections, outcome: "updated" }, dedupeKey: `${turn.turnId}:${review.requestId}` }),
  });
  const scope = createTurnScope(db, { brainPath: config.brainPath, journal, writer, governance: activity.governanceWrites, log: brainLog,
    connected: () => host.clients.hasClients(),
    changed(turnId, sessionId) { host.clients.broadcast({ type: "turn_journal", sessionId, turnId, journal: { ...journal.summary(turnId), ...(host.budgets?.saved(turnId) ? { budget: host.budgets.saved(turnId) } : {}) } }); } });
  const host = new WsHost({
    identitySentinelDirectory,
    scope,
    policyProposals,
    journal,
    governedTurns,
    ...(referenceWorktrees ? { referenceWorktrees, referenceWorktreeAccess: true } : {}),
    ...(referenceTools ? { referenceTools } : {}),
    sessionProfiles,
    maintenance: boundary.maintenance,
    budgets,
    ...(config.cliProviderOrigins ? { cliProviderOrigins: config.cliProviderOrigins } : {}),
    applicationPlanner,
    indexBatch,
    drafts,
    brainPath: config.brainPath,
    registry,
    observability,
    catalog,
    // Exact-operation approvals remain fail-closed until the full-v1 engine
    // wires current server authority. Dismiss/cancel/snooze need no grant.
    inboxTools: createInboxBridgeTools(db, intake, hygieneReview.resolver, config.brainPath),
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
      governanceWrites: activity.governanceWrites,
    },
  });
  bootCleanup.push(async () => { try { host.close(); } finally { await Promise.allSettled([...host.turnTasks]); } });
  if (dispatchFixture && inboxBudget) dispatcher = createInboxDispatcher(db, { identitySentinelDirectory, brainRoot: config.brainPath, nativeManager,
    privateIndex: { maskPaths: turnMaskPaths }, applicationPlanner: host.applicationPlanner, indexBatch,
    select: () => dispatchFixture.select(registry), budget: inboxBudget, fetch: dispatchFixture.fetch, now: dispatchFixture.now,
    classification: { apiKey: dispatchFixture.classificationKey ?? config.classification.apiKey },
    store: activity.store, runtime: activity.runtime, governanceWrites: activity.governanceWrites, onWrite: () => activity.stream.pump(), log: observability.logger("inbox") });
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
    else probeWorkerHostRecorded(config.brainPath, mode, activity.runtime, "boot", workerStateBytes, turnTempBytes, probeState);
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
  const rateLimiter = createLoginRateLimiter();
  const passkeyCtx: PasskeyContext = {
    rateLimiter,
    challenges: createPasskeyChallenges(),
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
      rateLimiter,
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
      log: authLog, brain: nativeReady.brainUuid,
      referenceAuthorityRevoked: (input) => { void referenceSources?.revoke(input).catch((error: Error) => authLog.emit({ severityText: "WARN", body: `reference revocation cleanup failed: ${error.message}` })); },
    })
  );
  app.route(
    "/api",
    createStatusRoutes({
      sourceCommit: config.sourceCommit,
      getContentRenderers: async signal => brain.modules ? declaredContentRenderers((await brain.modules({ signal })).enabled) : undefined,
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
      checkWorkerHost: async () => {
        for (const mode of workerHostModes) await probeWorkerHostRecordedAsync(config.brainPath, mode, activity.runtime, "check", workerStateBytes, turnTempBytes, probeState);
        await boundary.prepare();
        activity.runtime.recordGoverned(boundary.status());
        return activity.runtime.snapshot().workerHost ?? {};
      },
    })
  );
  // Host readers of the index wait for application updates queued before them (#2835).
  for (const path of INDEX_READ_ROUTES) app.use(path, indexReadBarrier(indexBatch));
  app.route(
    "/api",
    createBrainRoutes({ syncingRoots: new Set(), brain, brainPath: config.brainPath, exec: config.exec, keyterms, brainCliMinimum, log: brainLog, boundary })
  );
  app.route("/api", createSessionProfileRoutes(sessionProfiles));
  app.route("/api", createSessionRoutes({ registry, db, labels: host.labels !== null, prepareHistory: (id, messages) => host.prepareHistory(id, messages),
    settled: () => host.historySettled() }));
  app.route("/api", createJournalRoutes({ journal }));
  const storageHistory = createStorageHistory(db, config.brainPath, { writer });
  bootCleanup.push(() => storageHistory.close());
  const storageAuthorized = (id: string) => { const principal = resolvePrincipal(db, id); return !!principal && ["owner", "ambient"].includes(principal.kind) && isUsablePrincipal(principal, Date.now()); };
  const storageShared = createSharedStorageScan(db, config.brainPath, storageCacheRoot, storageAuthorized);
  const storageNotices = createStorageNotifier(db, storageHistory, writer);
  const storageStores: StorageStore[] = [
    { path: journalRoot, label: "Retained file history", category: "journal", owner: "app", recursive: true },
    { path: storageCacheRoot, label: "Storage shared scan cache", category: "temporary", owner: "app", recursive: true, optional: true },
  ];
  for (const [path, label] of [[config.dbPath, "Operational database"], [nativeLeasePath, "Native lease database"]] as const) {
    if (!path || path === ":memory:") continue;
    for (const suffix of ["", "-wal", "-shm", "-journal"]) storageStores.push({ path: resolve(path + suffix), label: label + suffix, category: "database", owner: "app", recursive: false, optional: suffix !== "" });
  }
  // The journal's metadata has its own file since #2789; it is retained file history, like its objects.
  if (!ephemeralJournal) for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    storageStores.push({ path: journalDatabasePath(config.dbPath) + suffix, label: "Retained file history database" + suffix, category: "journal", owner: "app", recursive: false, optional: suffix !== "" });
  }
  for (const [index, path] of (config.storage?.backupRoots ?? []).entries()) storageStores.push({ path, label: `Backup store ${index + 1}`, category: "backup", owner: "operator", recursive: true });
  const storage = createStorageCoordinator({ salt: storageHistory.salt, shared: storageShared,
    onCollection(value, source) { storageHistory.offer(aggregateCollection(value, source, storagePackage.version)); },
    onFailure(at) { storageHistory.failure(at); },
    onWrite(report) { storageHistory.ownerWrite(report); },
    brainPath: config.brainPath, stores: storageStores, gitRoots: [...config.storage?.gitRoots ?? []],
    authorized(id) { const principal = resolvePrincipal(db, id); return !!principal && ["owner", "ambient"].includes(principal.kind) && isUsablePrincipal(principal, Date.now()); },
    unavailable: [
      { label: "Native checkpoints and output", category: "native", owner: "app", reason: "shared-native-allocation-unavailable" },
      { label: "Live temporary stores", category: "temporary", owner: "app", reason: "private-runtime-usage-unavailable" },
    ],
    storesNow() {
      const stores: StorageStore[] = [], unavailable: Array<{ label: string; category: "transcripts"; owner: "app"; reason: string }> = [];
      const quarantine = hostExecution.quarantinePath();
      if (quarantine) stores.push({ path: quarantine, label: "Quarantined changes", category: "journal", owner: "app", recursive: true, optional: true });
      const backends = registry.peekBackends?.();
      if (!backends) unavailable.push({ label: "Backend transcripts", category: "transcripts", owner: "app", reason: "backend-owner-not-initialized" });
      for (const backend of backends ?? []) {
        if (!backend.storageRoots) { unavailable.push({ label: `${backend.id} transcripts`, category: "transcripts", owner: "app", reason: "backend-storage-unsupported" }); continue; }
        try { for (const location of backend.storageRoots()) stores.push({ path: location.path, label: `${backend.id} ${location.kind}`, category: "transcripts", owner: "app", recursive: true, optional: true }); } catch { unavailable.push({ label: `${backend.id} transcripts`, category: "transcripts", owner: "app", reason: "backend-roots-unavailable" }); }
      }
      return { stores, unavailable };
    },
  });
  bootCleanup.push(() => storage.close());
  const storageGuidance = createStorageGuidance(db, storageHistory, storage, storageNotices);
  const storageSampling = createStorageSampling(db, storage, storageHistory, storageShared, storageNotices, activity.pushSender);
  bootCleanup.push(() => storageSampling.close());
  app.route("/api", createStorageRoutes(storage, storageGuidance));
  const storageMaintenance = createStorageMaintenance(db, { brainPath: config.brainPath, storage, brain, scratch: scratchPrune, inbox, boundary,
    authorized(id) { const principal = resolvePrincipal(db, id); return !!principal && ["owner", "ambient"].includes(principal.kind) && isUsablePrincipal(principal, Date.now()); },
  });
  bootCleanup.push(() => storageMaintenance.close());
  app.route("/api", createStorageMaintenanceRoutes(storageMaintenance));

  const storageRemoval = createStorageRemoval(db, { brainPath: config.brainPath, retainedRoot: journalRoot, boundary, journal, gate: hostExecution.gate()!, lock: host.workerLock, storage,
    protectedPaths: [...storageStores.map(store => store.path), ...config.storage?.gitRoots ?? []].filter(path => path === config.brainPath || path.startsWith(config.brainPath + "/")).map(path => path === config.brainPath ? "." : path.slice(config.brainPath.length + 1)),
    authorized(id) { const principal = resolvePrincipal(db, id); return !!principal && ["owner", "ambient"].includes(principal.kind) && isUsablePrincipal(principal, Date.now()); },
  });
  bootCleanup.push(() => storageRemoval.close());
  app.route("/api", createStorageRemovalRoutes(storageRemoval));

  const reverts = createTurnReverts(db, { brainPath: config.brainPath, journal, gate: hostExecution.gate()!, lock: host.workerLock, governance: activity.governanceWrites,
    isAuthorized(id) { const principal = resolvePrincipal(db, id); return !!principal && ["owner", "ambient"].includes(principal.kind) && isUsablePrincipal(principal, Date.now()); },
    refresh() { host.governedTurns?.refresh(host.workerLock); } });
  bootCleanup.push(() => reverts.close());
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
  app.route("/api", createRenderRoutes(options.renderer, observability.logger("render"), brain));
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

  const httpRequests = new Map<Promise<void>, () => void>();
  const fetch: Hono["fetch"] = (request, env, executionCtx) => {
    if (host.closing) return Response.json({ error: "Server shutting down" }, { status: 503,
      headers: { "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" } });
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let cancelBody = (_reason: unknown) => {};
    let removeAbort = () => {};
    // Hono's JSON, multipart and bounded raw readers otherwise can wait on an
    // unfinished client body forever. Own the reader only when it is pulled;
    // shutdown errors its consumer immediately and does not await an arbitrary
    // producer's cancel promise. Normal bytes, metadata and route caps remain.
    if (request.body && !request.bodyUsed && !request.body.locked) {
      const original = request, body = request.body;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let ended = false;
      let interruptCancel!: () => void;
      const interrupted = new Promise<void>(resolve => { interruptCancel = resolve; });
      const cancelSource = (reason: unknown) => reader ? reader.cancel(reason) : body.cancel(reason);
      cancelBody = reason => {
        // A route may already be awaiting producer cancellation after its own
        // byte cap. Shutdown must release that wait as well as active reads.
        interruptCancel();
        if (ended) return;
        ended = true;
        controller.error(reason);
        void cancelSource(reason).catch(() => {});
      };
      const readable = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        async pull() {
          try {
            reader ??= body.getReader();
            const chunk = await reader.read();
            if (ended) return;
            if (chunk.done) { ended = true; controller.close(); reader.releaseLock(); }
            else controller.enqueue(chunk.value);
          } catch (error) { cancelBody(error); }
        },
        cancel(reason) {
          if (!ended) { ended = true; return Promise.race([cancelSource(reason), interrupted]); }
        },
      }, { highWaterMark: 0 });
      request = new Request(original, { method: original.method, body: readable });
      const disconnected = () => cancelBody(original.signal.reason);
      original.signal.addEventListener("abort", disconnected, { once: true });
      removeAbort = () => original.signal.removeEventListener("abort", disconnected);
      if (original.signal.aborted) disconnected();
    }
    const complete = () => { removeAbort(); httpRequests.delete(pending); finish(); };
    httpRequests.set(pending, () => cancelBody(new HTTPException(503, { message: "Server shutting down" })));
    try { return Promise.resolve(app.fetch(request, env, executionCtx)).finally(complete); }
    catch (error) { complete(); throw error; }
  };
  let closing: Promise<void> | undefined;
  return {
    fetch,
    websocket,
    config,
    authMode,
    db,
    wsHost: host,
    observability,
    isTurnActive: () => host.coordinator.isTurnActive(),
    cancelActiveTurns: () => host.coordinator.cancelAll("Server shutting down"),
    close: () => closing ??= (async () => {
      // Refuse new requests immediately; every remaining owner drains even
      // when a native deletion reply is unknown and its durable row stays.
      host.closing = true;
      // Queued module metadata is cancelled now (#2457). In-flight work gets a
      // short grace period; then shared CLI runs (reads and plain index) are
      // cancelled so they cannot hold close open (#2473).
      closeBegun.abort(new Error("Server shutting down"));
      const grace = setTimeout(() => shutdown.abort(new Error("Server shutting down")), CLOSE_GRACE_MS);
      const failures: unknown[] = [];
      const attempt = async (close: () => void | Promise<void>) => { try { await close(); } catch (error) { failures.push(error); } };
      for (const cancelBody of httpRequests.values()) cancelBody();
      // Cancel turn work before joining HTTP handlers that may be waiting for
      // its locks. Keep operational state alive until admitted dispatch ends.
      await attempt(() => { host.coordinator.cancelAll("Server shutting down"); });
      await attempt(() => storageSampling.close());
      await attempt(() => storageRemoval.close());
      await attempt(() => storageMaintenance.close());
      await attempt(() => inbox.close());
      await Promise.allSettled([...httpRequests.keys()]);
      await attempt(() => host.close());
      await attempt(async () => { await Promise.allSettled([...host.turnTasks]); });
      await attempt(() => subscription.close());
      await attempt(() => intake.close());
      await attempt(() => storage.close());
      await attempt(async () => { await storageHistory.flush(); storageHistory.close(); });
      await attempt(() => scratchPrune.close());
      await attempt(() => scratchPins.close());
      await attempt(() => reverts.close());
      await attempt(() => keyedReindex.idle());
      await attempt(async () => { await host.governedTurns?.close(); });
      await attempt(() => journal.close());
      await attempt(async () => { await referenceWorktrees?.close(); });
      await attempt(async () => { await referenceSources?.close(); });
      await attempt(() => nativeLeases.close());
      if (ephemeralJournal) await attempt(() => { rmSync(journalRoot, { recursive: true, force: true }); rmSync(storageCacheRoot, { recursive: true, force: true }); });
      // Gate releases commit off the event loop (#2850): every one lands first.
      await attempt(async () => { await hostExecution.gate()?.settled(); });
      await attempt(() => activity.close());
      await attempt(() => hostExecution.release());
      await attempt(() => db.close());
      clearTimeout(grace);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Application shutdown retained failed cleanup outcomes.");
    })(),
  };
  } catch (error) {
    const failures: unknown[] = [];
    for (const close of bootCleanup.reverse()) { try { await close(); } catch (cleanupError) { failures.push(cleanupError); } }
    try { await nativeLeases.close(); } catch (cleanupError) { failures.push(cleanupError); }
    if (ephemeralJournal) { try { rmSync(journalRoot, { recursive: true, force: true }); } catch (cleanupError) { failures.push(cleanupError); } }
    if (failures.length) throw new AggregateError([error, ...failures], "Application boot failed and retained failed cleanup outcomes.");
    throw error;
  }
}

/**
 * @schlessera/brain-ui-server — the chat-UI backend as a library.
 *
 * The deployment shell owns the process: it builds the Bun.serve() object,
 * decides the port/idleTimeout, wires SIGTERM, and injects deployment-only
 * pieces (static client build, PNG/PDF renderer). Everything else — routes,
 * auth, passkeys, the WebSocket turn coordinator, the session catalog — lives
 * behind createApp(), which returns a handle carrying the app's own resources
 * (config, database, ws host) instead of module-level singletons.
 */
export {
  createApp,
  type CreateAppOptions,
  type BrainUiApp,
  type AppRenderer,
} from "./app.js";

// Configuration: the package's single environment chokepoint. The descriptor
// (ENV_VARS) is the artifact the env-parity gate diffs against documentation.
export {
  ENV_VARS,
  resolveServerConfig,
  type EnvVarDescriptor,
  type ServerConfig,
  type AuthConfig,
  type WebAuthnConfig,
  type AgentConfig,
  type VoiceConfig,
} from "./config/env.js";

// Boot-time diagnostics (fail fast on a bad AGENT_BACKEND / profile config,
// log the resolved auth mode).
export {
  assertBackendResolvable,
  createBackendRegistry,
  createStaticBackendRegistry,
  type BackendLogFn,
  type BackendRegistry,
  type ModelDiscoverySource,
  type ModelDiscoveryState,
} from "./agent/backend.js";
export {
  authGuard,
  isWsAuthorized,
  resolveCookiePrincipal,
  resolveAuthMode,
  revokeAllSessions,
  type AuthMode,
  type AuthRuntime,
} from "./middleware/auth.js";

export { type Principal } from "./db/principals.js";
export { type AppEnv } from "./app-env.js";

// The app's own SQLite database (sessions, passkeys, settings).
export { createUiDb } from "./db/client.js";

// Brain database access (read-only, schema-gated) for embedders adding
// their own readers.
export {
  openBrainDb,
  withBrainDb,
  BrainDbUnavailableError,
  MIN_BRAIN_SCHEMA_VERSION,
} from "./db/brain-db.js";

// WebSocket internals for embedders and tests.
export { WsHost, type WsHostOptions } from "./ws/host.js";
export { createWsUpgrade, createWsHandlers, websocket } from "./ws/connection.js";
export {
  handleClientMessage,
  turnIdMatches,
  type ConnectionState,
} from "./ws/dispatch.js";
export { type AuthorizationContext } from "./ws/turns.js";
export { resolveTurnTarget } from "./ws/routing.js";
export {
  createSessionCatalog,
  type SessionCatalog,
} from "./ws/session-catalog.js";

// Brain repo access (spawned CLI wrapper) — useful for embedders that add
// their own routes on top.
export {
  BrainSyncError,
  createBrainClient,
  MIN_BRAIN_CLI_VERSION,
  type BrainClient,
} from "./brain/client.js";
export {
  parseSyncResult,
  syncActivityAttrs,
  syncMessage,
  type BrainSyncAgent,
  type BrainSyncOutput,
} from "./brain/sync-result.js";

// Cron run history. Scheduling belongs to the deployment (container crontab);
// an external scheduler's wrapper records each run here so /api/status's
// `cronJobs` reflects what actually ran.
export { recordCronRun, type CronRunRecord } from "./cron/scheduler.js";

// The activity record. The cron wrapper is a second PROCESS writing spans
// into the same store (root span + heartbeat + span-sink ingest); everything
// else consumes it through the app.
export {
  createActivityStore,
  SPAN_OUTCOMES,
  type ActivityStore,
  type SpanRow,
  type SpanEventRow,
  type SpanOutcome,
  type SpanUsage,
  type ActivityChange,
  type RollupPricing,
} from "./activity/store.js";
export { createActivityStream, type ActivityStream } from "./activity/stream.js";
export { ingestSpanSink } from "./activity/span-sink.js";
export {
  generateActivityDigest,
  latestActivityDigest,
  DIGEST_JOB_NAME,
  type ActivityDigest,
} from "./activity/digest.js";

// The classification pass's confidence record (D42): the read side, so a
// deployment can pull the distribution its swap thresholds should be tuned on.
// The write side is internal to the pass.
export {
  CONFIDENCE_BUCKETS,
  CONFIDENCE_BUCKET_WIDTH,
  CONFIDENCE_RETENTION_MS,
  confidenceDistribution,
  type ConfidenceBucket,
  type ConfidenceReadOptions,
} from "./classification/confidence-store.js";

// Share staging: a deployment can sweep expired staging dirs at boot; the
// intake route also sweeps opportunistically on every share.
export { pruneShareStaging, shareStagingRoot } from "./share/staging.js";

// Skill archive transport sizing for deployment shells. The route keeps the
// application-level check; consumers use this value only to avoid setting a
// smaller process-level request ceiling.
export { MAX_ARCHIVE_BYTES } from "./skills/install.js";

// Observability: the producing side is the OpenTelemetry API, the consuming
// side is ours. Swap the consumer to change where a deployment reports; a test
// swaps in the recording one and asserts on what the server actually said.
export {
  createObservability,
  createRecordingObservability,
  createSilentObservability,
  createConsoleLoggerProvider,
  createRecordingLoggerProvider,
  createSilentLoggerProvider,
  createInMemoryMeterProvider,
  SEVERITIES,
  severityRank,
  seriesKey,
} from "./observability/index.js";
export type {
  Observability,
  ObservabilityOptions,
  RecordingObservability,
  RecordingLoggerProvider,
  InMemoryMeterProvider,
  LogReader,
  LogWriter,
  MetricsReader,
  Severity,
  CapturedLog,
  LogQuery,
  MetricPoint,
  MetricSnapshot,
} from "./observability/index.js";

// Voice keyterm cache rebuild (used by deployments after `brain sync`).
export {
  buildKeyterms,
  writeCache,
  type KeytermSettings,
} from "./voice/keyterm-builder.js";

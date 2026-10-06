/**
 * @schlessera/brain-ui-server — the chat-UI backend as a library.
 *
 * The deployment shell owns the process: it builds the Bun.serve() object,
 * decides the port/idleTimeout, wires SIGTERM, and injects deployment-only
 * pieces (static client build, PNG/PDF renderer). Everything else — routes,
 * auth, passkeys, the WebSocket turn coordinator, the session catalog — lives
 * behind the awaited createApp(), which resolves to a handle carrying the app's own resources
 * (config, database, ws host) instead of module-level singletons.
 */
export {
  createApp,
  type CreateAppOptions,
  type HostVersionRequirements,
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
  createStaticBackendRegistry,
  type BackendRegistry,
  type ModelDiscoverySource,
} from "./agent/backend.js";
export {
  type AuthMode,
} from "./middleware/auth.js";

export { type Principal } from "./db/principals.js";

// Brain database access (read-only, schema-gated) for embedders adding
// their own readers, under the integration contract's direct-SQL guarantees.
export {
  openBrainDb,
  withBrainDb,
  BrainDbUnavailableError,
  MIN_BRAIN_SCHEMA_VERSION,
} from "./db/brain-db.js";

// WebSocket host for embedders.
export { WsHost, type WsHostOptions } from "./ws/host.js";
// Pill labels (#1004): the createApp option's shape and the labeller a
// WsHost embedder passes.
export {
  createLabeller,
  normaliseLabel,
  LABEL_MAX_CHARS,
  type Labeller,
  type LabellerOptions,
  type LabelCompletionProvider,
} from "./labels/index.js";
export { websocket } from "./ws/connection.js";
export { type AuthorizationContext } from "./ws/turns.js";
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
  type BrainSyncAgent,
  type BrainSyncOutput,
} from "./brain/sync-result.js";

// The activity record. The cron wrapper is a second PROCESS writing spans
// into the same store (root span + heartbeat + span-sink ingest); everything
// else consumes it through the app.
export {
  type ActivityStore,
  type SpanRow,
  type SpanEventRow,
  type SpanOutcome,
  type SpanUsage,
  type ActivityChange,
} from "./activity/store.js";
export { type ActivityStream } from "./activity/stream.js";

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

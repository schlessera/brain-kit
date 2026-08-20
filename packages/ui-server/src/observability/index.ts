/**
 * Observability for the chat-UI server: what it reports, and who receives it.
 *
 * The split is deliberate and is the whole design. The PRODUCING side is the
 * standard OpenTelemetry API — `logger.emit(...)`, `counter.add(...)` — so
 * instrumentation is portable and a real SDK can take over later without a
 * single call site changing. The CONSUMING side is ours: a console consumer in
 * production, a recording consumer in tests, an in-memory meter feeding
 * `/api/status`. That is what keeps the dependency surface to two packages and
 * makes "what did the server report?" answerable as data.
 *
 * An `Observability` is a value you construct and own, like the app's database
 * handle or a `ScrapeClient`'s rate limiter — NOT a process-global. The
 * OpenTelemetry globals are supported (`installGlobally`) for instrumentation
 * that cannot be reached with an argument, but nothing in this package
 * requires them, so two differently-configured apps can share a process and a
 * test never inherits the previous test's sinks.
 */
import { metrics, type Meter, type MeterProvider } from "@opentelemetry/api";
import { logs, type Logger, type LoggerProvider } from "@opentelemetry/api-logs";

import {
  createConsoleLoggerProvider,
  createRecordingLoggerProvider,
  createSilentLoggerProvider,
  type LogReader,
  type RecordingLoggerProvider,
} from "./loggers.js";
import { createInMemoryMeterProvider, type InMemoryMeterProvider, type MetricsReader } from "./meter.js";
import type { Severity } from "./types.js";

export interface ObservabilityOptions {
  /** Where logs go. Default: the console consumer at `minSeverity`. */
  loggerProvider?: LoggerProvider;
  /** Where metrics go. Default: an in-memory recorder (what /api/status reads). */
  meterProvider?: MeterProvider;
  /** Threshold for the DEFAULT console consumer; ignored if one is passed in. */
  minSeverity?: Severity;
}

/** What the app holds, and hands to anything that reports. */
export interface Observability {
  /** A logger for one instrumentation scope — the `[ws]` / `[auth]` prefix. */
  logger(scope: string): Logger;
  /** A meter for one instrumentation scope. */
  meter(scope: string): Meter;
  /** Recorded metrics, when the meter provider supports reading. */
  metrics?: MetricsReader;
  /** Captured logs, when the logger provider supports reading (tests). */
  logs?: LogReader;
  /**
   * Register these providers as the OpenTelemetry globals, so code that cannot
   * be handed an argument still reports somewhere. Returns a function that
   * restores whatever was there before — a test that installs globally must be
   * able to put the process back.
   */
  installGlobally(): () => void;
}

function hasMetricsReader(p: MeterProvider): p is MeterProvider & MetricsReader {
  return typeof (p as Partial<MetricsReader>).snapshot === "function";
}

function hasLogReader(p: LoggerProvider): p is LoggerProvider & LogReader {
  return typeof (p as Partial<LogReader>).records === "function";
}

export function createObservability(options: ObservabilityOptions = {}): Observability {
  const loggerProvider =
    options.loggerProvider ?? createConsoleLoggerProvider({ minSeverity: options.minSeverity });
  const meterProvider = options.meterProvider ?? createInMemoryMeterProvider();

  return {
    logger: (scope) => loggerProvider.getLogger(scope),
    meter: (scope) => meterProvider.getMeter(scope),
    metrics: hasMetricsReader(meterProvider) ? meterProvider : undefined,
    logs: hasLogReader(loggerProvider) ? loggerProvider : undefined,
    installGlobally() {
      // The API exposes no "read the current provider object" that round-trips
      // through disable(), so restoration is a disable rather than a swap-back.
      // Good enough for the one case that needs it — a test cleaning up.
      logs.setGlobalLoggerProvider(loggerProvider);
      metrics.setGlobalMeterProvider(meterProvider);
      return () => {
        logs.disable();
        metrics.disable();
      };
    },
  };
}

/**
 * The test flavour: recording consumers on both signals, with the read APIs
 * guaranteed present so a test does not have to narrow them.
 *
 * Same code path as production — only the sink differs — so an assertion here
 * is an assertion about the real emission, not about a double.
 */
export interface RecordingObservability extends Observability {
  metrics: InMemoryMeterProvider;
  logs: RecordingLoggerProvider;
  /** Forget everything captured so far. */
  reset(): void;
}

export function createRecordingObservability(): RecordingObservability {
  const loggerProvider = createRecordingLoggerProvider();
  const meterProvider = createInMemoryMeterProvider();
  const base = createObservability({ loggerProvider, meterProvider });
  return {
    ...base,
    metrics: meterProvider,
    logs: loggerProvider,
    reset() {
      loggerProvider.clear();
      meterProvider.reset();
    },
  };
}

/** An observability that reports nowhere — for a consumer that wants silence. */
export function createSilentObservability(): Observability {
  return createObservability({
    loggerProvider: createSilentLoggerProvider(),
    meterProvider: createInMemoryMeterProvider(),
  });
}

export {
  createConsoleLoggerProvider,
  createRecordingLoggerProvider,
  createSilentLoggerProvider,
} from "./loggers.js";
export type {
  ConsoleLoggerProviderOptions,
  RecordingLoggerProviderOptions,
  RecordingLoggerProvider,
  LogReader,
  LogWriter,
} from "./loggers.js";
export { createInMemoryMeterProvider } from "./meter.js";
export type { InMemoryMeterProvider, MetricsReader } from "./meter.js";
export { SEVERITIES, severityRank, seriesKey } from "./types.js";
export type {
  Severity,
  CapturedLog,
  LogQuery,
  MetricPoint,
  MetricSnapshot,
} from "./types.js";

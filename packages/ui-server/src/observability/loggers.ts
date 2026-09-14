/**
 * The two log consumers: one that writes, one that remembers.
 *
 * Both implement `LoggerProvider` from `@opentelemetry/api-logs`, so they are
 * interchangeable at the one call site that installs them, and so a real
 * OpenTelemetry SDK is a third option that needs no change to any
 * instrumentation.
 *
 * Why `@opentelemetry/api-logs` is pinned to an EXACT version in package.json
 * rather than caretted: the logs API is still 0.x. That was checked rather
 * than assumed — the producing surface used here (`getLogger().emit()`) is
 * unchanged across the 0.57 → 0.221 range, and the global registration
 * handshake is keyed on a backwards-compatibility constant that has stayed at
 * 1 throughout, so two copies at different versions still interoperate. The
 * churn that does exist is in `@opentelemetry/sdk-logs`, whose
 * `SimpleLogRecordProcessor` changed constructor shape — which is precisely
 * why the consumers below are ours and that package is not a dependency. If
 * upstream ever breaks the producing surface, the whole API is ~137 lines and
 * forking it is the stated fallback.
 */
import type { Logger, LoggerProvider, LogRecord } from "@opentelemetry/api-logs";

import {
  bodyToString,
  flattenAttributes,
  severityRank,
  type CapturedLog,
  type LogQuery,
  type Severity,
} from "./types.js";

/** Where a console consumer sends a formatted line. Injected so tests capture it. */
export interface LogWriter {
  (severity: Severity, line: string): void;
}

const defaultWriter: LogWriter = (severity, line) => {
  if (severity === "ERROR" || severity === "FATAL") console.error(line);
  else if (severity === "WARN") console.warn(line);
  else console.log(line);
};

export interface ConsoleLoggerProviderOptions {
  /** Records below this severity are dropped before formatting. Default INFO. */
  minSeverity?: Severity;
  write?: LogWriter;
}

/**
 * Formats to the `[scope] message key=value` shape this repo already logs in,
 * so adopting structured emission does not churn every existing log line's
 * appearance at the same time.
 */
function formatLine(record: CapturedLog): string {
  const attrs = Object.entries(record.attributes)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
  return `[${record.scope}] ${record.body}${attrs.length ? ` ${attrs.join(" ")}` : ""}`;
}

function toCaptured(scope: string, record: LogRecord): CapturedLog {
  return {
    scope,
    severity: (record.severityText ?? "INFO") as Severity,
    body: bodyToString(record.body),
    attributes: flattenAttributes(record.attributes),
    timestamp: Date.now(),
  };
}

/** The production consumer: severity-filtered lines on stdout/stderr. */
export function createConsoleLoggerProvider(
  options: ConsoleLoggerProviderOptions = {}
): LoggerProvider {
  const threshold = severityRank(options.minSeverity ?? "INFO");
  const write = options.write ?? defaultWriter;

  return {
    getLogger(name: string): Logger {
      return {
        emit(record: LogRecord) {
          if (severityRank(record.severityText) < threshold) return;
          const captured = toCaptured(name, record);
          write(captured.severity, formatLine(captured));
        },
        enabled(opts?: { severityNumber?: number }) {
          void opts;
          return true;
        },
      } as Logger;
    },
  };
}

/** Read side of the recording consumer. */
export interface LogReader {
  /** Everything captured, in emit order. */
  records(): CapturedLog[];
  /** Records matching every field of the query. */
  find(query?: LogQuery): CapturedLog[];
  /** How many records match — the common assertion. */
  count(query?: LogQuery): number;
  clear(): void;
}

export interface RecordingLoggerProvider extends LoggerProvider, LogReader {}

function matches(record: CapturedLog, query: LogQuery): boolean {
  if (query.scope !== undefined && record.scope !== query.scope) return false;
  if (query.severity !== undefined && record.severity !== query.severity) return false;
  if (query.minSeverity !== undefined && severityRank(record.severity) < severityRank(query.minSeverity)) {
    return false;
  }
  if (query.body !== undefined && !record.body.includes(query.body)) return false;
  for (const [key, value] of Object.entries(query.attributes ?? {})) {
    if (record.attributes[key] !== value) return false;
  }
  return true;
}

export interface RecordingLoggerProviderOptions {
  /**
   * Cap on retained records. A test asserts on a handful; a long-lived process
   * that installed this by accident should not grow without bound. Oldest are
   * dropped first. Default 1000.
   */
  limit?: number;
}

/**
 * The consumer a test installs. Because it implements the same interface the
 * production consumer does, a test asserts against the real emission path —
 * the instrumentation under test cannot tell the difference.
 */
export function createRecordingLoggerProvider(
  options: RecordingLoggerProviderOptions = {}
): RecordingLoggerProvider {
  const limit = options.limit ?? 1000;
  const captured: CapturedLog[] = [];

  return {
    getLogger(name: string): Logger {
      return {
        emit(record: LogRecord) {
          captured.push(toCaptured(name, record));
          if (captured.length > limit) captured.splice(0, captured.length - limit);
        },
        enabled() {
          return true;
        },
      } as Logger;
    },
    records: () => [...captured],
    find: (query = {}) => captured.filter((r) => matches(r, query)),
    count: (query = {}) => captured.reduce((n, r) => n + (matches(r, query) ? 1 : 0), 0),
    clear: () => {
      captured.length = 0;
    },
  };
}

/** A consumer that discards everything — the default when nothing is installed. */
export function createSilentLoggerProvider(): LoggerProvider {
  return {
    getLogger(): Logger {
      return {
        emit() {},
        enabled() {
          return false;
        },
      } as Logger;
    },
  };
}

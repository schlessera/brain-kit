/**
 * Shapes the observability consumers expose for inspection.
 *
 * These exist so that "what did the server report?" is answerable as DATA — by
 * a test, by `/api/status`, by a future exporter — rather than by scraping
 * stdout. Every consumer in this directory implements a standard OpenTelemetry
 * provider interface, so swapping one for another is an argument change and
 * never a change to instrumentation.
 */
import type { Attributes } from "@opentelemetry/api";
import type { LogRecord } from "@opentelemetry/api-logs";

/**
 * Attributes as this package retains them.
 *
 * Log attributes upstream are `AnyValue` — nested maps, arrays, null. Metric
 * attributes are narrower. Both are normalized to scalars on capture so one
 * query shape works over either, `/api/status` stays JSON-safe, and a
 * formatted line never prints `[object Object]`.
 */
export type FlatAttributes = Record<string, string | number | boolean>;

/** Coerce either attribute flavour to scalars, dropping empty values. */
export function flattenAttributes(attributes: unknown): FlatAttributes {
  const flat: FlatAttributes = {};
  if (!attributes || typeof attributes !== "object") return flat;
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      flat[key] = value;
    } else {
      flat[key] = JSON.stringify(value);
    }
  }
  return flat;
}

/** Severities this codebase uses, ordered. Anything below the configured
 *  threshold is dropped by the console consumer before it is formatted. */
export const SEVERITIES = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(severity: string | undefined): number {
  const index = SEVERITIES.indexOf((severity ?? "INFO") as Severity);
  return index === -1 ? SEVERITIES.indexOf("INFO") : index;
}

/** One emitted record, with the scope that produced it. */
export interface CapturedLog {
  /** Instrumentation scope — the `[ws]` / `[auth]` prefix this repo already uses. */
  scope: string;
  severity: Severity;
  body: string;
  attributes: FlatAttributes;
  /** Wall clock at emit, in ms. */
  timestamp: number;
}

/** A query over captured logs. Every field is an AND, every field optional. */
export interface LogQuery {
  scope?: string;
  severity?: Severity;
  /** Minimum severity, inclusive. */
  minSeverity?: Severity;
  /** Substring match against the body. */
  body?: string;
  /** Every listed attribute must be present and equal. */
  attributes?: FlatAttributes;
}

/** One counter/histogram series: an instrument plus one attribute combination. */
export interface MetricPoint {
  name: string;
  /** The attribute set that identifies this series. */
  attributes: FlatAttributes;
  /** Sum for counters, count of observations for histograms. */
  value: number;
  kind: "counter" | "updowncounter" | "histogram" | "gauge";
}

/** Serializable metric state, for `/api/status` and for assertions. */
export type MetricSnapshot = MetricPoint[];

/**
 * Stable key for a series. Attributes are sorted, so two calls with the same
 * attributes in a different literal order land on the same series.
 */
export function seriesKey(name: string, attributes: Attributes | undefined): string {
  const entries = Object.entries(attributes ?? {})
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v)}`);
  return entries.length ? `${name}|${entries.join(",")}` : name;
}

/** Convert a `LogRecord` body — typed as unknown-ish upstream — to a string. */
export function bodyToString(body: LogRecord["body"]): string {
  if (typeof body === "string") return body;
  if (body === undefined || body === null) return "";
  return typeof body === "object" ? JSON.stringify(body) : String(body);
}

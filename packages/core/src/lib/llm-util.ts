/**
 * Generic retry/backoff for LLM API calls.
 *
 * Extracted verbatim from the reference brain's embedder (attempt counts,
 * backoff curve, and error classification preserved). Shared by every built-in
 * provider so embeddings, completions, and future backends retry identically.
 */

// Rate-limit windows are typically per-minute — short backoffs burn retries
// without ever leaving the window, so back off long enough to escape it.
export const MAX_RETRIES = 5;
export const BASE_DELAY_MS = 4000;
/** Transient (5xx/network) errors back off from a shorter base. */
export const TRANSIENT_DELAY_MS = 1000;

export type ErrorKind = "rate-limit" | "transient" | "fatal";

/** Sleep helper for rate-limit backoff. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Classify an API error: rate limits back off long (per-minute windows),
 * transient server/network errors back off short, anything else is fatal.
 */
export function classifyError(e: any): ErrorKind {
  const status = typeof e?.status === "number" ? e.status : undefined;
  const msg = String(e?.message ?? e ?? "");
  if (status === 429 || msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
    return "rate-limit";
  }
  if (
    (status !== undefined && status >= 500) ||
    /\b(500|502|503|504)\b/.test(msg) ||
    /INTERNAL|UNAVAILABLE|DEADLINE_EXCEEDED|overloaded/i.test(msg) ||
    /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(msg)
  ) {
    return "transient";
  }
  return "fatal";
}

export interface RetryOptions {
  maxRetries?: number;
  /** Base delay for rate-limit backoff (doubled each attempt). */
  baseDelayMs?: number;
  /** Base delay for transient backoff (doubled each attempt). */
  transientDelayMs?: number;
  /** Injectable for tests; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each backoff; defaults to a console.warn (preserving the original log). */
  onRetry?: (info: { kind: ErrorKind; attempt: number; delayMs: number; error: unknown }) => void;
}

function defaultOnRetry(info: { kind: ErrorKind; delayMs: number }): void {
  console.warn(
    `${info.kind === "rate-limit" ? "Rate limited" : "Transient API error"}, retrying in ${info.delayMs}ms...`
  );
}

/**
 * Retry a function with exponential backoff. Rate-limit and transient errors
 * are retried up to `maxRetries` attempts; fatal errors throw immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? BASE_DELAY_MS;
  const transientDelayMs = opts.transientDelayMs ?? TRANSIENT_DELAY_MS;
  const doSleep = opts.sleep ?? sleep;
  const onRetry = opts.onRetry ?? defaultOnRetry;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      const kind = classifyError(e);
      if (kind === "fatal" || attempt === maxRetries - 1) throw e;
      const base = kind === "rate-limit" ? baseDelayMs : transientDelayMs;
      const delayMs = base * Math.pow(2, attempt);
      onRetry({ kind, attempt, delayMs, error: e });
      await doSleep(delayMs);
    }
  }
  throw new Error("Unreachable");
}

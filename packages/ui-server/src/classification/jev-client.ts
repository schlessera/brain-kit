/**
 * The transport to the classifier (D42 §2): one request, one budget.
 *
 * Progressive enhancement is the rule, so the whole call — one attempt plus
 * one retry on 429/529 — lives inside a single deadline (2 s by default).
 * A timeout, a non-2xx status, a malformed body, or a missing key all
 * resolve to `null` with an outcome the caller counts; nothing here throws
 * into a turn, and nothing here is awaited by anything that renders.
 *
 * A classifier that keeps failing is not asked: after a few consecutive
 * failures the client opens a breaker and skips calls for a backoff that
 * doubles on every further failure, up to a cap. When the backoff passes,
 * ONE call goes through as the probe; it succeeding closes the breaker and
 * resets the backoff. A dead vendor or a bad link then costs one probe per
 * window rather than a budget's worth of waiting on every answer.
 */

import type {
  ClassificationAnswers,
  ClassificationRequest,
} from "@schlessera/brain-ui-sdk/internal";
import type { Logger } from "@opentelemetry/api-logs";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/**
 * The budget one pass gets, end to end. Raised from 1 s on 2026-09-21 after
 * the live run measured Jev at 700–800 ms on this connection: a second left
 * no room for the retry, and the pass is still nothing the answer waits on.
 */
export const JEV_TIMEOUT_MS = 2000;

export type JevOutcome =
  | "answered"
  | "timeout"
  | "rate_limited"
  | "http_error"
  | "network_error"
  | "bad_response"
  | "no_key"
  /** Skipped without a call: the breaker is open after consecutive failures. */
  | "circuit_open";

/** Consecutive failures that open the breaker. */
export const BREAKER_FAILURES = 3;
/** First backoff once open; doubles per further failure. */
export const BREAKER_BASE_MS = 30_000;
/** The backoff never grows past this. */
export const BREAKER_MAX_MS = 30 * 60_000;

export interface JevResult {
  outcome: JevOutcome;
  answers: ClassificationAnswers | null;
  /** Wall time the call took, for the latency record. */
  durationMs: number;
  /** HTTP status when there was one. */
  status?: number;
}

/** The slice of `fetch` the client uses, so a test can hand in one that never resolves. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JevClientOptions {
  apiKey: string | null;
  /** Injected so a test can hand in a fetch that never resolves. */
  fetch?: FetchLike;
  endpoint?: string;
  timeoutMs?: number;
  log?: Logger;
  /** Injected clock for deterministic latency in tests. */
  now?: () => number;
}

export interface JevClient {
  /** Enabled means a key is configured; the pass is skipped otherwise. */
  readonly enabled: boolean;
  classify(request: ClassificationRequest): Promise<JevResult>;
  /** The breaker's state, for the record and for tests. */
  breaker(): { open: boolean; consecutiveFailures: number; retryAt: number | null };
}

const RETRY_STATUSES = new Set([429, 529]);

function isAnswers(value: unknown): value is ClassificationAnswers {
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(
    (answer) =>
      !!answer &&
      typeof answer === "object" &&
      ((answer as { type?: unknown }).type === "choice" || (answer as { type?: unknown }).type === "noul")
  );
}

export function createJevClient(options: JevClientOptions): JevClient {
  const apiKey = options.apiKey?.trim() || null;
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const endpoint = options.endpoint ?? JEV_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? JEV_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  async function attempt(
    body: string,
    signal: AbortSignal
  ): Promise<{ kind: "ok"; answers: ClassificationAnswers } | { kind: "status"; status: number } | { kind: "bad" }> {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body,
      signal,
    });
    if (!response.ok) return { kind: "status", status: response.status };
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { kind: "bad" };
    }
    const answers = (json as { answers?: unknown } | null)?.answers;
    return isAnswers(answers) ? { kind: "ok", answers } : { kind: "bad" };
  }

  // The breaker. `consecutiveFailures` counts every outcome that is not an
  // answer; `retryAt` is set while open and is when the next probe may go.
  let consecutiveFailures = 0;
  let retryAt: number | null = null;
  let backoffMs = BREAKER_BASE_MS;
  let probeInFlight = false;

  function recordFailure(outcome: JevOutcome): void {
    consecutiveFailures++;
    if (consecutiveFailures < BREAKER_FAILURES) return;
    // Open, or stay open with a longer wait: the first opening waits the
    // base, each failed probe doubles it up to the cap.
    const wait = consecutiveFailures === BREAKER_FAILURES ? BREAKER_BASE_MS : backoffMs;
    retryAt = now() + wait;
    backoffMs = Math.min(wait * 2, BREAKER_MAX_MS);
    options.log?.emit({
      severityText: "WARN",
      body: consecutiveFailures === BREAKER_FAILURES ? "classifier breaker opened" : "classifier probe failed; breaker stays open",
      attributes: {
        "classification.outcome": outcome,
        "classification.consecutive_failures": consecutiveFailures,
        "classification.retry_in_ms": wait,
      },
    });
  }

  function recordSuccess(): void {
    if (retryAt !== null) {
      options.log?.emit({
        severityText: "INFO",
        body: "classifier breaker closed",
        attributes: { "classification.consecutive_failures": consecutiveFailures },
      });
    }
    consecutiveFailures = 0;
    retryAt = null;
    backoffMs = BREAKER_BASE_MS;
  }

  return {
    enabled: apiKey !== null,
    breaker: () => ({ open: retryAt !== null && now() < retryAt, consecutiveFailures, retryAt }),
    async classify(request) {
      const startedAt = now();
      const done = (outcome: JevOutcome, answers: ClassificationAnswers | null, status?: number): JevResult => {
        const result: JevResult = { outcome, answers, durationMs: now() - startedAt };
        if (status !== undefined) result.status = status;
        if (outcome === "answered") recordSuccess();
        else if (outcome !== "no_key" && outcome !== "circuit_open") recordFailure(outcome);
        return result;
      };
      if (!apiKey) return done("no_key", null);
      // Reserve the first call after backoff for the whole logical probe,
      // including its retry; other calls skip while that probe is pending.
      if (probeInFlight || (retryAt !== null && now() < retryAt)) return done("circuit_open", null);
      const isProbe = retryAt !== null;
      if (isProbe) probeInFlight = true;
      try {
        const body = JSON.stringify(request);
        // One deadline for the whole call, retry included: the budget is the
        // reader's, not the vendor's.
        const signal = AbortSignal.timeout(timeoutMs);
        let lastStatus: number | undefined;
        for (let tries = 0; tries < 2; tries++) {
          if (signal.aborted) break;
          try {
            const outcome = await attempt(body, signal);
            if (outcome.kind === "ok") return done("answered", outcome.answers);
            if (outcome.kind === "bad") return done("bad_response", null);
            lastStatus = outcome.status;
            if (!RETRY_STATUSES.has(outcome.status)) return done("http_error", null, outcome.status);
            // Retry once, immediately: any backoff long enough to matter would
            // outlive the budget.
          } catch (err) {
            if (signal.aborted) return done("timeout", null);
            options.log?.emit({
              severityText: "WARN",
              body: "classification call failed",
              attributes: { "error.message": err instanceof Error ? err.message : String(err) },
            });
            return done("network_error", null);
          }
        }
        return signal.aborted && lastStatus === undefined
          ? done("timeout", null)
          : done("rate_limited", null, lastStatus);
      } finally {
        // A call admitted while closed must not release a later probe.
        if (isProbe) probeInFlight = false;
      }
    },
  };
}

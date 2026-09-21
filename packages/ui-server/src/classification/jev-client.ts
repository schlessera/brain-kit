/**
 * The transport to the classifier (D42 §2): one request, one budget.
 *
 * Progressive enhancement is the rule, so the whole call — one attempt plus
 * one retry on 429/529 — lives inside a single deadline (2 s by default).
 * A timeout, a non-2xx status, a malformed body, or a missing key all
 * resolve to `null` with an outcome the caller counts; nothing here throws
 * into a turn, and nothing here is awaited by anything that renders.
 */

import type {
  ClassificationAnswers,
  ClassificationRequest,
} from "@schlessera/brain-ui-sdk/server";
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
  | "no_key";

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

  return {
    enabled: apiKey !== null,
    async classify(request) {
      const startedAt = now();
      const done = (outcome: JevOutcome, answers: ClassificationAnswers | null, status?: number): JevResult => {
        const result: JevResult = { outcome, answers, durationMs: now() - startedAt };
        if (status !== undefined) result.status = status;
        return result;
      };
      if (!apiKey) return done("no_key", null);
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
    },
  };
}

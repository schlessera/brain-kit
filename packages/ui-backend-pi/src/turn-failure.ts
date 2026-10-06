import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describeRetry } from "@schlessera/brain-ui-sdk/internal";
import type { ServerMessage, TurnFailure, TurnRetry } from "@schlessera/brain-ui-sdk/server";

/**
 * Follows one turn's provider failures (#575).
 *
 * pi does not throw when a model call fails: `prompt()` resolves, and the
 * failure is the turn's last assistant message, with `stopReason: "error"` and
 * the provider's text in `errorMessage` (pi-coding-agent 0.87.1,
 * `_handlePostAgentRun` in `dist/core/agent-session.js`). A retryable one is
 * retried first, announced by `auto_retry_start`. So the failure is whatever
 * the last settled assistant message says, and a later answer clears it.
 */
export interface TurnFailureTracker {
  /** Observe one event; returns the frames it produces (a retry's status). */
  observe(ev: AgentSessionEvent): ServerMessage[];
  /** The failure the turn ended on, or null when its last answer settled. */
  failure(fallback?: TurnFailure): TurnFailure | null;
}

export function createTurnFailureTracker(): TurnFailureTracker {
  let current: TurnFailure | null = null;
  let attempts: number | undefined;
  return {
    observe(ev) {
      if (ev.type === "message_end") {
        const { message } = ev;
        if (!("role" in message) || message.role !== "assistant") return [];
        if (message.stopReason === "error") {
          current = failureFromPiError(message.errorMessage);
        } else if (message.stopReason !== "aborted") {
          current = null;
        }
        return [];
      }
      if (ev.type === "auto_retry_start") {
        if (Number.isSafeInteger(ev.attempt) && ev.attempt > 0) attempts = ev.attempt;
        const { status, errorClass } = classify(ev.errorMessage);
        const retry: TurnRetry = {
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          ...(errorClass !== "unknown" ? { errorClass } : {}),
          ...(status !== undefined ? { status } : {}),
        };
        return [{ type: "status", status: "thinking", detail: describeRetry(retry), retry }];
      }
      return [];
    },
    failure: (fallback) => {
      const failure = fallback ?? current;
      return failure ? { ...failure, ...(attempts !== undefined ? { attempts } : {}) } : null;
    },
  };
}

/**
 * A pi provider error as a wire failure. pi keeps only the provider's text,
 * so the status is the one the text opens with — how pi-ai's providers write
 * it ("400 {…}", "429: …") — and the class is read from that status alone.
 */
export function failureFromPiError(errorMessage: string | undefined): TurnFailure {
  const message = errorMessage?.trim() || "The model call failed.";
  const { status, errorClass } = classify(message);
  return { errorClass, ...(status !== undefined ? { status } : {}), message };
}

function classify(text: string): { status?: number; errorClass: string } {
  const match = /^([1-5]\d\d)(?=[\s:])/.exec(text.trim());
  if (!match) return { errorClass: "unknown" };
  const status = Number(match[1]);
  return { status, errorClass: classForStatus(status) };
}

/**
 * The class a status implies, in the Claude Agent SDK's vocabulary. Only the
 * statuses whose meaning does not depend on the provider are mapped.
 */
function classForStatus(status: number): string {
  if (status === 400) return "invalid_request";
  if (status === 401) return "authentication_failed";
  if (status === 429) return "rate_limit";
  if (status === 529) return "overloaded";
  if (status >= 500) return "server_error";
  return "unknown";
}

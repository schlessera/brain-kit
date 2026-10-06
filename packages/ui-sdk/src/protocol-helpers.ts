/**
 * Helpers over protocol values that first-party hosts, backends and the UI
 * share so they word and normalize them identically. They are not part of the
 * wire contract and not a supported API: `./internal` and `./internal/client`
 * re-export them, with no compatibility promise (#1053).
 */
import { THINKING_LEVELS, type ThinkingLevel, type TurnRetry } from "./protocol.js";

/**
 * A retry in words, for `ServerStatus.detail`: "Retrying (attempt 2 of 10) in
 * 5s after rate_limit, HTTP 429". One wording for every backend, and only the
 * parts the runtime reported.
 */
export function describeRetry(retry: TurnRetry): string {
  const attempt =
    retry.maxAttempts !== undefined ? `attempt ${retry.attempt} of ${retry.maxAttempts}` : `attempt ${retry.attempt}`;
  const wait = retry.delayMs !== undefined ? ` in ${formatRetryDelay(retry.delayMs)}` : "";
  const cause = [
    retry.errorClass !== undefined && retry.errorClass !== "unknown" ? retry.errorClass : undefined,
    retry.status !== undefined ? `HTTP ${retry.status}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return `Retrying (${attempt})${wait}${cause.length ? ` after ${cause.join(", ")}` : ""}`;
}

function formatRetryDelay(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  return seconds < 10 ? `${Math.round(seconds * 10) / 10}s` : `${Math.round(seconds)}s`;
}

/** Resolve unsupported effort to the nearest lower supported choice, or the lowest. */
export function resolveThinkingLevel(
  requested: ThinkingLevel,
  supported: readonly ThinkingLevel[]
): ThinkingLevel | undefined {
  const choices = THINKING_LEVELS.filter((level) => supported.includes(level));
  return choices.filter((level) => THINKING_LEVELS.indexOf(level) <= THINKING_LEVELS.indexOf(requested)).at(-1)
    ?? choices[0];
}

/**
 * Strip a dated snapshot suffix from a model id:
 * `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. The API lists some models
 * only under a dated id; the undated alias is the public name (and the API
 * resolves it back). Shared here so model discovery and pricing canonicalize
 * identically.
 */
export function canonicalModelId(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

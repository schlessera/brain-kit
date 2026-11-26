/**
 * Helpers over protocol values that hosts, backends and the UI share so they
 * word and normalize them identically. They are not part of the wire
 * contract. `describeRetry` and `resolveThinkingLevel` are public backend
 * toolkit on `/server` (#1399); `canonicalModelId` is first-party sharing
 * only. `./internal/client` re-exports all three for the browser, with no
 * compatibility promise (#1053).
 */
import { THINKING_LEVELS, type ThinkingLevel, type TurnRetry } from "./protocol.js";

/**
 * A retry in words, for `ServerStatus.detail`: "Retrying (attempt 2 of 10) in
 * 5s after rate_limit, HTTP 429". One wording for every backend, and only the
 * parts the runtime reported.
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
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

/**
 * Resolve unsupported effort to the nearest lower supported choice, or the lowest.
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
 */
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

/** The SDK uses authored configuration keys, including punctuation and printable display names. */
export function isMcpTimingServerName(name: unknown, source?: unknown): name is string {
  if (typeof name !== "string" || name.length > 48 || new TextEncoder().encode(name).byteLength > 48) return false;
  if (/[\p{C}\p{Zl}\p{Zp}\/\\]/u.test(name)) return false;
  const safePart = (part: string) => {
    const key = part.trim();
    return key.length > 0 && key !== "." && key !== ".." && !/^[A-Za-z]:/.test(key);
  };
  if (!safePart(name)) return false;
  // A configured key is opaque. Only its provenance identifies a CLI-generated
  // identifier. On older CLIs without provenance, keep checking for embedded paths.
  const unknownSource = typeof source !== "string" || !source.length;
  if ((source === "claudeai" || unknownSource) && name.startsWith("claude.ai ")) return safePart(name.slice("claude.ai ".length));
  if ((source === "plugin" || unknownSource) && name.startsWith("plugin:")) {
    const parts = name.slice("plugin:".length).split(":");
    if (parts.length > 2 && parts.slice(0, -1).some(part => /^[A-Za-z]$/.test(part.trim()))) return false;
    return parts.every(part => (unknownSource && part.length === 0) || safePart(part));
  }
  return true;
}

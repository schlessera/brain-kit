import {
  getSessionMessages as sdkGetSessionMessages,
  listSessions as sdkListSessions,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import type { KeyedLock } from "@schlessera/brain-ui-sdk/server";

import { DEFAULT_PROFILES, type InferenceProfile } from "./profiles.js";

/**
 * Minimal host-injected log seam. A callback rather than a logger object so
 * this package carries no telemetry dependency — the ui-server registry adapts
 * its own structured logger to this shape and passes it through.
 */
export type BackendLogFn = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  attrs?: Record<string, string | number | boolean>
) => void;

export interface ClaudeBackendOptions {
  /** Working directory for the agent — the brain repo the model operates on. */
  brainPath: string;
  /**
   * Path to the native `claude` executable. The Agent SDK can't always
   * auto-discover it; pass it explicitly when it isn't on PATH. Omitted =
   * let the SDK locate it.
   */
  claudeCodePath?: string;
  /**
   * Inference profiles this backend can run. Defaults to
   * {@link DEFAULT_PROFILES}.
   *
   * Pass a FUNCTION when the roster can change while the process runs (model
   * discovery, host-side settings). It is called on every `listProfiles()` and
   * every turn, so a newly discovered model is selectable without a restart —
   * an array is captured once and cannot grow.
   */
  profiles?: InferenceProfile[] | (() => InferenceProfile[]);
  /**
   * Reserved. The host owns turn timeouts via the StartTurnRequest signal (see
   * the startTurn contract), so this is accepted for forward-compatibility but
   * NOT enforced here.
   */
  defaultTimeoutMs?: number;
  /** Backend-wide tool allowlist; a profile's own `allowedTools` overrides it. */
  allowedTools?: string[];
  /**
   * Regex sources; a Bash command matching any of them raises a confirmation
   * card before it runs. Defaults to the shared confirm patterns. An EMPTY
   * array disables the confirmation entirely — which is a real choice, not a
   * misconfiguration, so it is honoured as given.
   *
   * Configurable because "destructive" is deployment-specific: a published
   * package can ship `rm -rf`, but it cannot know which of YOUR commands are
   * the ones worth stopping on.
   */
  confirmBashPatterns?: readonly string[];
  /**
   * Where this backend reports degradations. Absent, it falls back to
   * `console.warn` so a standalone consumer still sees them.
   */
  log?: BackendLogFn;
  /**
   * Text appended to the Claude Code system prompt, describing the chat
   * surface the answer renders on. Defaults to `buildSystemPromptAppend(...)`,
   * rebuilt per turn from the client's reported device; setting this pins one
   * STATIC string instead. Repo-specific instructions belong in the brain
   * repo's own CLAUDE.md, which the SDK already loads; this is only for facts
   * about the UI. Pass an empty string to append nothing.
   */
  systemPromptAppend?: string;
  /**
   * Serializes contending tool executions across every session this backend
   * runs — per target file for path-declaring tools, repo-wide for git
   * staging/history commands, one shared key for the brain document tools
   * (see `lockKeyForTool`). Defaults to a fresh per-instance lock; inject a
   * shared one to coordinate with other writers of the same repo (or to
   * observe it in tests).
   */
  writeLock?: KeyedLock;
  /**
   * How long a tool call may WAIT for its lock before it is denied with a
   * retryable reason, in ms. Must stay comfortably under the CLI's hook
   * timeout (60s): a waiter that stalls past that is refused by the CLI
   * itself with "PreToolUse hook did not respond before its timeout" — a
   * message the model misreads as something being wrong with the call.
   * Default 30s. Zero or negative disables the bound (never advisable).
   */
  lockWaitMs?: number;
  /** @internal Test seam — inject the SDK `query` function. Defaults to the real one. */
  queryFn?: typeof query;
  /** @internal Test seam — inject the SDK `listSessions` reader. */
  listSessionsFn?: typeof sdkListSessions;
  /** @internal Test seam — inject the SDK `getSessionMessages` reader. */
  getSessionMessagesFn?: typeof sdkGetSessionMessages;
}

export function resolveClaudeProfiles(options: ClaudeBackendOptions): InferenceProfile[] {
  const source = options.profiles;
  const list = typeof source === "function" ? source() : source;
  return list && list.length > 0 ? list : DEFAULT_PROFILES;
}

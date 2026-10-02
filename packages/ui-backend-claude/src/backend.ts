import {
  getSessionMessages as sdkGetSessionMessages,
  listSessions as sdkListSessions,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentBackend,
  BackendCapabilities,
  ChatSession,
  ProviderInfo,
  SessionHistoryMessage,
} from "@schlessera/brain-ui-sdk/server";
import { compileConfirmPatterns, createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { DEFAULT_CONFIRM_BASH_PATTERNS } from "@schlessera/brain-ui-sdk/internal";

import { createHistory } from "./history.js";
import type { BackendLogFn, ClaudeBackendOptions } from "./options.js";
import { resolveClaudeProfiles } from "./options.js";
import { listProfiles } from "./profiles.js";
import { createClaudeTurnRunner } from "./turn-runner.js";
import { assertClaudeSdk, claudeRuntimeRequirements } from "./version-requirements.js";

const BACKEND_ID = "claude";

// Re-exported from their new homes so direct source imports and the package's
// public surface stay identical after the factory split.
export type { BackendLogFn, ClaudeBackendOptions } from "./options.js";
export { lockKeyForTool } from "./tool-policy.js";
export { GIT_LOCK_KEY, BRAIN_LOCK_KEY } from "@schlessera/brain-ui-sdk/server";

/**
 * Bash commands that raise a confirmation card before they run.
 *
 * WHY THIS EXISTS HERE. `Bash` is auto-allowed, and the SDK never consults
 * `canUseTool` for an allowlisted tool — so `brain archive x.md` typed into
 * Bash ran silently while the same operation through `brain_archive` raised a
 * card. Worse, the brain repo's own CLAUDE.md documents the CLI form, so the
 * gated path was the one nobody took. The approval existed on the path the
 * documentation steers away from.
 *
 * The pattern list itself is backend-independent policy and lives in
 * `@schlessera/brain-ui-sdk/internal` (shared with the pi backend's tool_call
 * gate); available through the package's internal entry for first-party sharing.
 */
export { DEFAULT_CONFIRM_BASH_PATTERNS } from "@schlessera/brain-ui-sdk/internal";

/**
 * Build an AgentBackend backed by the Claude Agent SDK. The SDK owns session
 * persistence (JSONL under the brain dir), tool execution, and cost reporting;
 * this wrapper maps its streaming output onto the brain-kit wire protocol and
 * routes permission / ask-user / location round-trips through the host bridge.
 */
export function createClaudeBackend(options: ClaudeBackendOptions): AgentBackend {
  options = { ...options, ...(options.versionRequirements ? { versionRequirements: { ...options.versionRequirements } } : {}) };
  assertClaudeSdk(options.versionRequirements, "backend construction");
  claudeRuntimeRequirements(options.versionRequirements);
  // Resolved per call, not captured: a function source may return more profiles
  // later (discovery refresh). An empty roster falls back to the built-in.
  const resolveProfiles = () => resolveClaudeProfiles(options);
  // Compiled once per backend: the sources are configuration, not per-turn
  // input. `?? DEFAULT` rather than `|| DEFAULT` so an explicit empty array
  // disables confirmation instead of silently restoring the defaults.
  const confirmPatterns = compileConfirmPatterns(
    options.confirmBashPatterns ?? DEFAULT_CONFIRM_BASH_PATTERNS,
    (source, message) =>
      options.log
        ? options.log("warn", "ignoring unparseable confirmBashPatterns entry", {
            source,
            error: message,
          })
        : console.warn(
            `[claude-backend] ignoring unparseable confirmBashPatterns entry ${JSON.stringify(source)}: ${message}`
          )
  );
  const history = createHistory({
    brainPath: options.brainPath,
    listSessionsFn: options.listSessionsFn ?? sdkListSessions,
    getSessionMessagesFn: options.getSessionMessagesFn ?? sdkGetSessionMessages,
  });
  const log: BackendLogFn =
    options.log ??
    ((level, message, attrs) =>
      console[level === "debug" ? "log" : level](
        `[claude-backend] ${message}`,
        attrs ?? ""
      ));
  const startTurn = createClaudeTurnRunner({
    backend: options,
    resolveProfiles,
    confirmPatterns,
    writeLock: options.writeLock ?? createKeyedLock(),
    lockWaitMs: options.lockWaitMs ?? 30_000,
    log,
  });

  const capabilities: BackendCapabilities = {
    autonomous: true,
    resume: true,
    permissions: true,
    thinking: true,
    attachments: true,
    askUser: true,
    costReporting: true,
    // Each turn is its own `query()` subprocess with per-turn closure state, so
    // turns on different sessions run in parallel; busy-ness is per session.
    concurrentSessions: true,
    // The Agent SDK has no mid-turn message injection, so the host queues
    // follow-ups as the session's next turn (status: queued) rather than us
    // delivering them into the running one.
    followUp: false,
  };

  return {
    id: BACKEND_ID,
    capabilities,
    listProfiles(): ProviderInfo[] {
      return listProfiles(resolveProfiles());
    },
    startTurn,
    listSessions(): Promise<ChatSession[]> {
      return history.listSessions();
    },
    getHistory(sessionId: string): Promise<SessionHistoryMessage[]> {
      return history.getHistory(sessionId);
    },
  };
}

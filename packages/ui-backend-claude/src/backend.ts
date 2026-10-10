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
  UnavailableProfile,
} from "@schlessera/brain-ui-sdk/server";
import { compileConfirmPatterns, createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { DEFAULT_ALLOWED_TOOLS, VOICE_ALLOWED_TOOLS } from "./tool-policy.js";
import { DEFAULT_CONFIRM_BASH_PATTERNS } from "@schlessera/brain-ui-sdk/internal";

import { createHistory } from "./history.js";
import type { BackendLogFn, ClaudeBackendOptions } from "./options.js";
import { resolveClaudeProfiles } from "./options.js";
import { listProfiles, listUnavailableProfiles } from "./profiles.js";
import { createClaudeTurnRunner } from "./turn-runner.js";
import { assertClaudeSdk, claudeRuntimeRequirements } from "./version-requirements.js";

const BACKEND_ID = "claude";

// Re-exported from their new homes so direct source imports and the package's
// public surface stay identical after the factory split.
export type { BackendLogFn, ClaudeBackendOptions } from "./options.js";
export { lockKeyForTool } from "./tool-policy.js";
export { GIT_LOCK_KEY, BRAIN_LOCK_KEY } from "@schlessera/brain-ui-sdk/internal";

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
  const writeLock = options.writeLock ?? createKeyedLock();
  const { startTurn, followUp } = createClaudeTurnRunner({
    backend: options,
    resolveProfiles,
    confirmPatterns,
    writeLock,
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
    // A message sent mid-turn joins the running turn: the turn's input stays
    // open, and Claude Code hands a queued message to the model beside the
    // next tool result, without interrupting the running step (#1003,
    // turn-input.ts).
    followUp: true,
  };

  return {
    id: BACKEND_ID,
    capabilities,
    listProfiles(): ProviderInfo[] {
      return listProfiles(resolveProfiles());
    },
    listUnavailableProfiles(): UnavailableProfile[] {
      return listUnavailableProfiles(resolveProfiles());
    },
    brainApplicationPolicy(req) {
      const profile = resolveProfiles().find(p => p.id === req.profileId) ?? resolveProfiles()[0];
      const allowed = new Set(req.autonomous?.allowedTools ??
        (req.posture === "voice" ? VOICE_ALLOWED_TOOLS : undefined) ??
        profile?.allowedTools ?? options.allowedTools ?? DEFAULT_ALLOWED_TOOLS);
      const names = { add: ["mcp__brain-ui__brain_add", "mcp__brain__brain_add"],
        update: ["mcp__brain-ui__brain_update", "mcp__brain__brain_update"],
        archive: ["mcp__brain-ui__brain_archive", "mcp__brain__brain_archive"],
        write: ["mcp__brain-ui__write_file", "Write"], edit: ["mcp__brain-ui__edit_file", "Edit"],
        staged: ["mcp__brain-ui__apply_staged_changes"] };
      const autoAllowed = (Object.keys(names) as (keyof typeof names)[]).filter(op => names[op].some(n => allowed.has(n)));
      return { autoAllowed, enforceAllowedTools: req.enforceAllowedTools, available: (req.noGrantSurface || req.autonomous) ? autoAllowed : Object.keys(names) as (keyof typeof names)[], lock: writeLock };
    },
    startTurn,
    followUp,
    listSessions(): Promise<ChatSession[]> {
      return history.listSessions();
    },
    getHistory(sessionId: string): Promise<SessionHistoryMessage[]> {
      return history.getHistory(sessionId);
    },
  };
}

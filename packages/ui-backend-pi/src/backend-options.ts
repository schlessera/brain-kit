import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type {
  BackendBridge,
  ClientEnvironment,
  ConfirmPatternSource,
  WriteLock,
} from "@schlessera/brain-ui-sdk/server";

import type { TurnContext } from "./turn-context.js";

/**
 * The slice of pi's AgentSession this backend drives — also the injection
 * surface for the cross-backend contract tests (no live model needed).
 */
export interface PiSessionLike {
  readonly sessionId: string;
  /** Native effort surface; optional only for older injected test sessions. */
  readonly model?: Model<any>;
  readonly thinkingLevel?: ThinkingLevel;
  getAvailableThinkingLevels?(): ThinkingLevel[];
  setThinkingLevel?(level: ThinkingLevel, options?: { persist?: boolean }): void;
  subscribe(listener: (ev: AgentSessionEvent) => void): () => void;
  /**
   * `streamingBehavior` selects how a message sent WHILE the session is already
   * streaming is queued: "followUp" waits for the running turn to finish its
   * tool calls (queue-within-turn — used by followUp()), "steer" interrupts.
   * Omitted for the initial turn (the session is idle).
   */
  prompt(
    text: string,
    opts?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
  ): Promise<unknown>;
  abort(): Promise<void>;
  getSessionStats(): { cost: number };
  dispose(): void;
}

/**
 * The per-session curated toolset and its mutable turn holder. Passed to the
 * @internal sessionFactory so injected fake sessions can exercise the real
 * per-session tool binding (the tools close over `turnContext`).
 */
export interface SessionToolkit {
  tools: ToolDefinition[];
  turnContext: TurnContext;
}

/**
 * @internal Test seam — replaces createAgentSession-based session acquisition.
 * The optional `toolkit` is the per-session curated toolset the real path wires
 * into createAgentSession; fakes may ignore it or use it to run the real tools.
 */
export interface PiSessionFactory {
  newSession(profileId?: string, toolkit?: SessionToolkit): Promise<PiSessionLike>;
  openSession(sessionId: string, toolkit?: SessionToolkit): Promise<PiSessionLike>;
}

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

export interface PiProfile {
  /** Opaque profile id surfaced to the client (travels the wire as providerId). */
  id: string;
  label: string;
  /** pi provider id, e.g. "anthropic", "openai", "google", "openrouter". */
  vendor?: string;
  /** pi model id within the vendor, e.g. "claude-sonnet-4-5". */
  model: string;
  /**
   * Reasoning default re-read on every turn, including resumed sessions.
   * Absent = pi's default ("medium"); a per-turn override does not replace it.
   */
  thinkingLevel?: ThinkingLevel;
}

export interface CreatePiBackendOptions {
  /** Absolute path to the brain repository (the agent's cwd). */
  brainPath: string;
  /** Default model when no profiles are configured: "vendor/modelId" or "modelId". */
  model?: string;
  /**
   * Selectable model/endpoint profiles. First is the default for new
   * sessions. A FUNCTION is re-read on every use, so the host can apply
   * runtime configuration (e.g. per-model thinking overrides from settings)
   * without rebuilding the backend.
   */
  profiles?: PiProfile[] | (() => PiProfile[]);
  /** Where pi stores session JSONL. Default: <brainPath>/.brain-kit-ui/sessions. */
  sessionDir?: string;
  /**
   * Load pi extensions (installed pi packages and repo-local extensions).
   * Default TRUE since the tool_call permission gate covers extension tools:
   * a tool the gate's allowlist does not know raises an approval card before
   * it runs, so installing e.g. `pi-mcp-adapter` (MCP servers from the repo's
   * `.mcp.json`) or `pi-web-access` (web search/fetch) extends the surface
   * with the same approval posture the Claude backend gives MCP tools.
   * Set false to pin the surface to the curated tools alone.
   */
  loadExtensions?: boolean;
  /**
   * Text appended to the system prompt describing the chat surface the answer
   * renders on. Defaults to `buildSystemPromptAppend()` fed with the
   * session-opening turn's client environment and the host's bridge
   * capabilities; pass an empty string to append nothing.
   */
  systemPromptAppend?: string;
  /**
   * Regex sources; a bash command matching any of them raises a confirmation
   * card before it runs even though bash is auto-allowed. Defaults to the
   * shared DEFAULT_CONFIRM_BASH_PATTERNS. An EMPTY array disables the
   * confirmation entirely — honoured as given, like the Claude backend.
   * Entries are bare regex sources or `{ pattern, effect }`; the effect is
   * what the approval card shows. A nonempty list with no valid regex throws
   * during construction; mixed lists report and skip invalid entries.
   */
  confirmBashPatterns?: readonly ConfirmPatternSource[];
  /**
   * Tool names that run WITHOUT an approval card. Defaults to
   * DEFAULT_PI_ALLOWED_TOOLS (every curated tool except brain_archive, plus
   * the recommended web extension's tools). Any executed tool NOT in this
   * list — e.g. a third-party MCP tool through pi-mcp-adapter — raises an
   * approval card.
   */
  allowedTools?: readonly string[];
  /**
   * LEGACY whole-lock opt-in: when injected, EVERY mutating tool execution
   * serializes on this one mutex (the pre-0.27 behavior — for sharing a lock
   * with another in-process writer). Absent (the default), mutations
   * serialize per contention key instead: git staging/history commands
   * repo-wide, brain document writes together, file writes per path — and
   * everything else (builds, greps, curls) runs in parallel.
   */
  writeLock?: WriteLock;
  /** Where this backend reports degradations. Absent means silence. */
  log?: BackendLogFn;
  /** @internal Test seam — inject session acquisition (contract tests). */
  sessionFactory?: PiSessionFactory;
}

/** The host bridge capabilities one session's tool surface is built for. */
export interface SessionCaps {
  askUser: boolean;
  askUserList: boolean;
  askUserRank: boolean;
  location: boolean;
  activity: boolean;
  mask: boolean;
}

/** What one session's system prompt and toolset are conditioned on. */
export interface SessionEnv {
  client?: ClientEnvironment;
  caps: SessionCaps;
  turnBudgetMs?: number;
}

export function capsOf(bridge: BackendBridge): SessionCaps {
  return {
    askUser: Boolean(bridge.askUser),
    askUserList: Boolean(bridge.askUserList),
    askUserRank: Boolean(bridge.askUserRank),
    location: Boolean(bridge.getLocation),
    activity: Boolean(bridge.queryActivity),
    mask: Boolean(bridge.requestMask),
  };
}

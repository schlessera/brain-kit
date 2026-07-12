/**
 * @brainform/ui-backend-pi — the OSS-default AgentBackend, built on the upstream
 * pi coding-agent SDK (@earendil-works/pi-coding-agent).
 *
 * pi's built-in read/bash/edit/write tools are disabled (`noTools: "builtin"`)
 * and replaced with a curated, brain-repo-scoped tool set (see tools.ts) that
 * carries the permission gate inside each tool. Conversations are pi
 * SessionManager JSONL trees; the wire protocol frames are produced by
 * subscribing to the AgentSession event stream.
 *
 * Auth/model credentials come from pi's own mechanisms (env vars / `pi` auth
 * storage under the agent dir) — this backend does not manage keys.
 */

import { join } from "path";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ImageContent, Model } from "@earendil-works/pi-ai";

import {
  BackendBusyError,
  BackendRequestError,
  type AgentBackend,
  type BackendCapabilities,
  type ProviderInfo,
  type ServerMessage,
  type StartTurnRequest,
  type ChatSession,
  type SessionHistoryMessage,
} from "@brainform/ui-sdk/server";

import { createBrainAccess } from "./brain-access";
import { createTurnContext } from "./turn-context";
import { createBrainTools } from "./tools";
import { listPiSessions, getPiHistory } from "./history";

export const PI_BACKEND_ID = "pi";

/**
 * The slice of pi's AgentSession this backend drives — also the injection
 * surface for the cross-backend contract tests (no live model needed).
 */
export interface PiSessionLike {
  readonly sessionId: string;
  subscribe(listener: (ev: AgentSessionEvent) => void): () => void;
  prompt(text: string, opts?: { images?: ImageContent[] }): Promise<unknown>;
  abort(): Promise<void>;
  getSessionStats(): { cost: number };
  dispose(): void;
}

/** @internal Test seam — replaces createAgentSession-based session acquisition. */
export interface PiSessionFactory {
  newSession(profileId?: string): Promise<PiSessionLike>;
  openSession(sessionId: string): Promise<PiSessionLike>;
}

export interface PiProfile {
  /** Opaque profile id surfaced to the client (travels the wire as providerId). */
  id: string;
  label: string;
  /** pi provider id, e.g. "anthropic", "openai", "google", "openrouter". */
  vendor?: string;
  /** pi model id within the vendor, e.g. "claude-sonnet-4-5". */
  model: string;
}

export interface CreatePiBackendOptions {
  /** Absolute path to the brain repository (the agent's cwd). */
  brainPath: string;
  /** Default model when no profiles are configured: "vendor/modelId" or "modelId". */
  model?: string;
  /** Selectable model/endpoint profiles. First is the default for new sessions. */
  profiles?: PiProfile[];
  /** Where pi stores session JSONL. Default: <brainPath>/.brainform-ui/sessions. */
  sessionDir?: string;
  /**
   * Load pi extensions discovered in the brain repo. Default false: the curated
   * tool surface is the whole point, so repo-provided pi extensions (which can
   * register tools and lifecycle hooks) are NOT loaded. Skills and AGENTS.md /
   * CLAUDE.md context files always load regardless.
   */
  loadExtensions?: boolean;
  /** @internal Test seam — inject session acquisition (contract tests). */
  sessionFactory?: PiSessionFactory;
}

const CAPABILITIES: BackendCapabilities = {
  resume: true,
  permissions: true,
  thinking: true,
  attachments: true,
  askUser: true,
  costReporting: true,
  // Placeholders until the parallel-sessions work lands (task 27): the current
  // implementation is single-turn with no mid-turn follow-up.
  concurrentSessions: false,
  followUp: false,
};

interface ModelSpec {
  vendor?: string;
  model: string;
}

export function createPiBackend(options: CreatePiBackendOptions): AgentBackend {
  const brainPath = options.brainPath;
  const sessionDir = options.sessionDir ?? join(brainPath, ".brainform-ui", "sessions");

  const brain = createBrainAccess(brainPath);
  const turn = createTurnContext();
  const tools = createBrainTools({ brain, turn });

  let busy = false;
  let current: { session: PiSessionLike; id: string } | null = null;

  // Shared resource loader + settings, built once and reused. Disabling
  // extensions keeps the tool surface curated; skills + context files still load.
  let sharedResources:
    | { loader: DefaultResourceLoader; settingsManager: SettingsManager }
    | null
    | undefined; // undefined = not yet attempted, null = build failed (use pi defaults)

  async function getSharedResources() {
    if (sharedResources !== undefined) return sharedResources;
    try {
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.create(brainPath, agentDir);
      const loader = new DefaultResourceLoader({
        cwd: brainPath,
        agentDir,
        settingsManager,
        noExtensions: !options.loadExtensions,
      });
      await loader.reload();
      sharedResources = { loader, settingsManager };
    } catch {
      // Fall back to pi's internal DefaultResourceLoader (still discovers
      // skills + context files from cwd); we lose only the extension opt-out.
      sharedResources = null;
    }
    return sharedResources;
  }

  function resolveModelSpec(profileId?: string): ModelSpec | undefined {
    const profiles = options.profiles;
    if (profileId) {
      const p = profiles?.find((x) => x.id === profileId);
      if (p) return { vendor: p.vendor, model: p.model };
      // Ad-hoc "vendor/modelId" profile ids are accepted (config-driven UIs
      // may pass them directly). A malformed opaque id is a caller error.
      if (profileId.includes("/")) return parseModelString(profileId);
      throw new BackendRequestError(`Unknown profileId: ${profileId}`);
    }
    if (profiles && profiles.length > 0) {
      return { vendor: profiles[0].vendor, model: profiles[0].model };
    }
    if (options.model) return parseModelString(options.model);
    return undefined;
  }

  /** Resolve a spec to a concrete pi Model, or undefined to let pi choose. */
  function toModel(spec: ModelSpec | undefined): Model<any> | undefined {
    if (!spec?.vendor) return undefined;
    try {
      // Cast: getBuiltinModel is literal-typed over the static catalog; at
      // runtime it's a lookup returning undefined for unknown vendor/model.
      return getBuiltinModel(spec.vendor as never, spec.model as never) as Model<any> | undefined;
    } catch {
      return undefined;
    }
  }

  async function newSession(profileId?: string): Promise<PiSessionLike> {
    const spec = resolveModelSpec(profileId);
    if (options.sessionFactory) return options.sessionFactory.newSession(profileId);
    const sm = SessionManager.create(brainPath, sessionDir);
    const resources = await getSharedResources();
    const { session } = await createAgentSession({
      cwd: brainPath,
      noTools: "builtin",
      customTools: tools,
      sessionManager: sm,
      ...(resources
        ? { resourceLoader: resources.loader, settingsManager: resources.settingsManager }
        : {}),
      ...(toModel(spec) ? { model: toModel(spec) } : {}),
    });
    return session;
  }

  async function openSession(sessionId: string): Promise<PiSessionLike> {
    if (options.sessionFactory) return options.sessionFactory.openSession(sessionId);
    const infos = await SessionManager.list(brainPath, sessionDir);
    const info = infos.find((i) => i.id === sessionId);
    if (!info) throw new BackendRequestError(`Cannot resume unknown session: ${sessionId}`);
    const sm = SessionManager.open(info.path, sessionDir);
    const resources = await getSharedResources();
    const { session } = await createAgentSession({
      cwd: brainPath,
      noTools: "builtin",
      customTools: tools,
      sessionManager: sm,
      // Resumed sessions stay pinned to their saved model — no model override.
      ...(resources
        ? { resourceLoader: resources.loader, settingsManager: resources.settingsManager }
        : {}),
    });
    return session;
  }

  /** Get the session for this turn, reusing the in-memory one when it matches. */
  async function acquireSession(
    req: StartTurnRequest
  ): Promise<{ session: PiSessionLike; isNew: boolean }> {
    if (req.sessionId) {
      if (current && current.id === req.sessionId) {
        return { session: current.session, isNew: false };
      }
      disposeCurrent();
      const session = await openSession(req.sessionId);
      current = { session, id: session.sessionId };
      return { session, isNew: false };
    }
    disposeCurrent();
    const session = await newSession(req.profileId);
    current = { session, id: session.sessionId };
    return { session, isNew: true };
  }

  function disposeCurrent(): void {
    if (current) {
      try {
        current.session.dispose();
      } catch {
        /* best effort */
      }
      current = null;
    }
  }

  function snapshotCost(session: PiSessionLike): number {
    try {
      return session.getSessionStats().cost;
    } catch {
      return 0;
    }
  }

  return {
    id: PI_BACKEND_ID,
    capabilities: CAPABILITIES,

    listProfiles(): ProviderInfo[] {
      // Precedence: explicit profiles → a single default from `model`. No pi
      // ModelRegistry fallback: on a machine with an OpenRouter key that
      // returns ~1700 models — useless as a picker list, environment-
      // dependent, and it surfaces ids the deployment never chose. Profiles
      // are deliberately an explicit-configuration surface; a "vendor/model"
      // string is still accepted as an ad-hoc profileId (resolveModelSpec).
      if (options.profiles && options.profiles.length > 0) {
        return options.profiles.map((p) => ({ id: p.id, label: p.label, vendor: p.vendor }));
      }
      if (options.model) {
        const spec = parseModelString(options.model);
        return [{ id: "default", label: options.model, vendor: spec.vendor }];
      }
      return [];
    },

    async startTurn(req: StartTurnRequest): Promise<void> {
      if (busy) throw new BackendBusyError(PI_BACKEND_ID);
      busy = true;
      const emit = (msg: ServerMessage) => req.bridge.emit(msg);
      const startedAt = Date.now();

      let session: PiSessionLike;
      let isNew: boolean;
      try {
        ({ session, isNew } = await acquireSession(req));
      } catch (err) {
        busy = false;
        // Caller errors (unknown profile/session) REJECT per the startTurn contract.
        throw err;
      }

      // Bind this turn's plumbing so the curated tools use the right bridge/signal.
      turn.bridge = req.bridge;
      turn.signal = req.signal;

      const unsubscribe = session.subscribe(makeEventHandler(emit));
      const onAbort = () => {
        void session.abort();
      };
      req.signal.addEventListener("abort", onAbort, { once: true });

      // session_info must precede any content frames for a new session.
      emit({
        type: "session_info",
        sessionId: session.sessionId,
        isNew,
        ...(req.profileId ? { providerId: req.profileId } : {}),
      });

      const costBefore = snapshotCost(session);
      const images = toImages(req);

      try {
        emit({ type: "status", status: "thinking" });
        await session.prompt(req.prompt, images.length > 0 ? { images } : undefined);
      } catch (err) {
        // Runtime failure (no model/auth, provider unreachable) → error frame,
        // then a terminal result. The promise RESOLVES.
        emit({ type: "error", code: "agent_error", message: errorMessage(err) });
      } finally {
        unsubscribe();
        req.signal.removeEventListener("abort", onAbort);
        turn.bridge = null;
        turn.signal = null;
        busy = false;
      }

      if (req.signal.aborted) {
        emit({ type: "status", status: "cancelled", activeSessionId: session.sessionId });
        return;
      }

      emit({
        type: "result",
        sessionId: session.sessionId,
        costUsd: Math.max(0, snapshotCost(session) - costBefore),
        durationMs: Date.now() - startedAt,
        numTurns: 1,
        isError: false,
      });
    },

    listSessions(): Promise<ChatSession[]> {
      return listPiSessions(brainPath, sessionDir);
    },

    getHistory(sessionId: string): Promise<SessionHistoryMessage[]> {
      return getPiHistory(brainPath, sessionId, sessionDir);
    },
  };
}

/** Translate pi AgentSession events into wire-protocol frames. */
function makeEventHandler(emit: (msg: ServerMessage) => void) {
  return (ev: AgentSessionEvent): void => {
    for (const frame of mapPiEvent(ev)) emit(frame);
  };
}

/**
 * Pure event → frame mapping (exported for tests). Returns the ordered frames a
 * single pi AgentSession event produces; unmapped events return [].
 */
export function mapPiEvent(ev: AgentSessionEvent): ServerMessage[] {
  switch (ev.type) {
    case "message_update": {
      const a = ev.assistantMessageEvent;
      if (a.type === "text_delta") return [{ type: "text_delta", text: a.delta }];
      if (a.type === "thinking_delta") return [{ type: "thinking_delta", text: a.delta }];
      return [];
    }
    case "tool_execution_start":
      // Tool args arrive complete (not streamed): emit start + complete with
      // the full input; the protocol allows omitting input_delta frames.
      return [
        { type: "tool_use_start", toolUseId: ev.toolCallId, toolName: ev.toolName },
        {
          type: "tool_use_complete",
          toolUseId: ev.toolCallId,
          toolName: ev.toolName,
          input: (ev.args ?? {}) as Record<string, unknown>,
        },
        { type: "status", status: "tool_executing" },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool_result",
          toolUseId: ev.toolCallId,
          output: toolResultText(ev.result),
          isError: ev.isError,
        },
      ];
    default:
      return [];
  }
}

/** Extract the text of a pi AgentToolResult's content parts. */
function toolResultText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

function toImages(req: StartTurnRequest): ImageContent[] {
  if (!req.attachments || req.attachments.length === 0) return [];
  return req.attachments.map((att) => ({
    type: "image" as const,
    data: att.data,
    mimeType: att.mediaType,
  }));
}

function parseModelString(spec: string): ModelSpec {
  const slash = spec.indexOf("/");
  if (slash > 0) return { vendor: spec.slice(0, slash), model: spec.slice(slash + 1) };
  return { model: spec };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

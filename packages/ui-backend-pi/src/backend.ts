/**
 * @schlessera/brain-backend-pi — the OSS-default AgentBackend, built on the upstream
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
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ImageContent, Model, Usage } from "@earendil-works/pi-ai";

import {
  BackendBusyError,
  BackendRequestError,
  createWriteLock,
  type AgentBackend,
  type BackendCapabilities,
  type ProviderInfo,
  type ServerMessage,
  type StartTurnRequest,
  type FollowUpRequest,
  type ChatSession,
  type ChatImageAttachment,
  type SessionHistoryMessage,
  type WriteLock,
  type ModelUsage,
  type TurnUsage,
  buildSystemPromptAppend,
  sumModelUsage,
} from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "./brain-access.js";
import { createTurnContext, type TurnContext } from "./turn-context.js";
import { createBrainTools, PI_ASK_USER_TOOL_NAME } from "./tools.js";
import { listPiSessions, getPiHistory } from "./history.js";

export const PI_BACKEND_ID = "pi";

/**
 * The slice of pi's AgentSession this backend drives — also the injection
 * surface for the cross-backend contract tests (no live model needed).
 */
export interface PiSessionLike {
  readonly sessionId: string;
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
   * Reasoning level for this profile's NEW sessions (pi clamps it to the
   * model's capabilities). Absent = pi's default ("medium").
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
   * Load pi extensions discovered in the brain repo. Default false: the curated
   * tool surface is the whole point, so repo-provided pi extensions (which can
   * register tools and lifecycle hooks) are NOT loaded. Skills and AGENTS.md /
   * CLAUDE.md context files always load regardless.
   */
  loadExtensions?: boolean;
  /**
   * Text appended to the system prompt describing the chat surface the answer
   * renders on. Defaults to `buildSystemPromptAppend()` with no device detail
   * (see below); pass an empty string to append nothing.
   */
  systemPromptAppend?: string;
  /**
   * Serializes mutating tool executions across all this backend's sessions so
   * concurrent agents never interleave writes/git ops in the shared working
   * tree. Defaults to a fresh in-process lock; inject one to share a lock with
   * another writer in the same process.
   */
  writeLock?: WriteLock;
  /** Where this backend reports degradations. Absent means silence. */
  log?: BackendLogFn;
  /** @internal Test seam — inject session acquisition (contract tests). */
  sessionFactory?: PiSessionFactory;
}

/**
 * Max pi AgentSessions kept resident in memory. Beyond this, IDLE (not running)
 * sessions are disposed least-recently-used-first at the end of a turn; their
 * transcripts stay on disk and reopen on the next resume. Running sessions are
 * never evicted.
 */
const MAX_IN_MEMORY_SESSIONS = 5;

const CAPABILITIES: BackendCapabilities = {
  resume: true,
  permissions: true,
  thinking: true,
  attachments: true,
  askUser: true,
  costReporting: true,
  // Turns on different sessions run in parallel; mid-turn user messages are
  // injected into the running turn via followUp() (native pi queue-within-turn).
  concurrentSessions: true,
  followUp: true,
};

/** One resident session: its pi runtime, its per-session tool plumbing, liveness. */
interface SessionEntry {
  session: PiSessionLike;
  turnContext: TurnContext;
  /** True while a turn targeting this session is in flight (per-session busy). */
  running: boolean;
}

interface ModelSpec {
  vendor?: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export function createPiBackend(options: CreatePiBackendOptions): AgentBackend {
  const brainPath = options.brainPath;
  const sessionDir = options.sessionDir ?? join(brainPath, ".brain-kit-ui", "sessions");
  // Built WITHOUT a client environment: pi's resource loader (and therefore
  // its system prompt) is constructed once per backend and shared by every
  // session, so unlike the Claude backend there is no per-turn hook to feed
  // the current device into. The brief degrades to its device-unknown form.
  const systemPromptAppend =
    options.systemPromptAppend ??
    buildSystemPromptAppend({
      // pi's ask tool is registered under its bare name (see tools.ts) and pi
      // has no location tool at all — naming Claude's MCP tools here would
      // send the model after tools this backend does not have.
      tools: { askUser: PI_ASK_USER_TOOL_NAME, location: false },
    });

  // Shared across all sessions: read paths are parallel-safe (per-call handles,
  // busy_timeout on the write path) and the write lock is what serializes mutations.
  const brain = createBrainAccess(brainPath);
  const writeLock = options.writeLock ?? createWriteLock();

  // Resident sessions, keyed by pi sessionId. Insertion order is the LRU order:
  // reused sessions are re-inserted at the tail (touch), eviction drops the head.
  const sessions = new Map<string, SessionEntry>();

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
        // Same chat-surface brief the Claude backend appends: what the answer
        // renders into (diagrams, share blocks, who is reading), on top of
        // whatever the brain repo's own context files say. Note the catch
        // below falls back to pi's internal loader, which loses this.
        ...(systemPromptAppend
          ? { appendSystemPromptOverride: (base: string[]) => [...base, systemPromptAppend] }
          : {}),
      });
      await loader.reload();
      sharedResources = { loader, settingsManager };
    } catch (err) {
      // Fall back to pi's internal DefaultResourceLoader (still discovers
      // skills + context files from cwd). The fallback loses the extension
      // opt-out AND the chat-surface system-prompt append — degraded output
      // for every session this backend runs, so it must not happen silently.
      options.log?.(
        "warn",
        "falling back to pi's internal resource loader; the chat-surface system-prompt append is lost",
        { error: err instanceof Error ? err.message : String(err) }
      );
      sharedResources = null;
    }
    return sharedResources;
  }

  function configuredProfiles(): PiProfile[] | undefined {
    return typeof options.profiles === "function" ? options.profiles() : options.profiles;
  }

  function resolveModelSpec(profileId?: string): ModelSpec | undefined {
    const profiles = configuredProfiles();
    if (profileId) {
      const p = profiles?.find((x) => x.id === profileId);
      if (p) return { vendor: p.vendor, model: p.model, thinkingLevel: p.thinkingLevel };
      // Ad-hoc "vendor/modelId" profile ids are accepted (config-driven UIs
      // may pass them directly). A malformed opaque id is a caller error.
      if (profileId.includes("/")) return parseModelString(profileId);
      throw new BackendRequestError(`Unknown profileId: ${profileId}`);
    }
    if (profiles && profiles.length > 0) {
      const p = profiles[0];
      return { vendor: p.vendor, model: p.model, thinkingLevel: p.thinkingLevel };
    }
    if (options.model) return parseModelString(options.model);
    return undefined;
  }

  /**
   * Resolve a spec to a concrete pi Model, or undefined to let pi choose
   * (only when no vendor was configured at all). A DECLARED vendor/model that
   * is not in pi's builtin catalog throws instead of silently handing the
   * choice back to pi — which would run whichever provider happens to have
   * ambient credentials, under the declared profile's label and billing.
   */
  function toModel(spec: ModelSpec | undefined): Model<any> | undefined {
    if (!spec?.vendor) return undefined;
    let model: Model<any> | undefined;
    try {
      // Cast: getBuiltinModel is literal-typed over the static catalog; at
      // runtime it's a lookup returning undefined for unknown vendor/model.
      model = getBuiltinModel(spec.vendor as never, spec.model as never) as
        | Model<any>
        | undefined;
    } catch {
      model = undefined;
    }
    if (!model) {
      throw new BackendRequestError(
        `Unknown model "${spec.vendor}/${spec.model}" — not in pi's builtin catalog. ` +
          "Fix the profile's vendor/model or update the pi SDK."
      );
    }
    return model;
  }

  /** A fresh per-session TurnContext and the curated tools bound to it. */
  function buildToolkit(): SessionToolkit {
    const turnContext = createTurnContext();
    const tools = createBrainTools({ brain, turn: turnContext, writeLock });
    return { tools, turnContext };
  }

  async function newSession(
    profileId?: string
  ): Promise<{ session: PiSessionLike; turnContext: TurnContext }> {
    const spec = resolveModelSpec(profileId); // throws BackendRequestError on bad profile
    const toolkit = buildToolkit();
    if (options.sessionFactory) {
      const session = await options.sessionFactory.newSession(profileId, toolkit);
      return { session, turnContext: toolkit.turnContext };
    }
    const sm = SessionManager.create(brainPath, sessionDir);
    const resources = await getSharedResources();
    const model = toModel(spec); // throws on a declared model missing from the catalog
    const { session } = await createAgentSession({
      cwd: brainPath,
      noTools: "builtin",
      customTools: toolkit.tools,
      sessionManager: sm,
      ...(resources
        ? { resourceLoader: resources.loader, settingsManager: resources.settingsManager }
        : {}),
      ...(model ? { model } : {}),
      ...(spec?.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
    });
    return { session, turnContext: toolkit.turnContext };
  }

  async function openSession(
    sessionId: string
  ): Promise<{ session: PiSessionLike; turnContext: TurnContext }> {
    const toolkit = buildToolkit();
    if (options.sessionFactory) {
      const session = await options.sessionFactory.openSession(sessionId, toolkit);
      return { session, turnContext: toolkit.turnContext };
    }
    const infos = await SessionManager.list(brainPath, sessionDir);
    const info = infos.find((i) => i.id === sessionId);
    if (!info) throw new BackendRequestError(`Cannot resume unknown session: ${sessionId}`);
    const sm = SessionManager.open(info.path, sessionDir);
    const resources = await getSharedResources();
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: brainPath,
      noTools: "builtin",
      customTools: toolkit.tools,
      sessionManager: sm,
      // Resumed sessions stay pinned to their saved model — no model override.
      ...(resources
        ? { resourceLoader: resources.loader, settingsManager: resources.settingsManager }
        : {}),
    });
    // pi silently substitutes another configured model when the saved one is
    // unavailable (catalog change, missing/expired credential). Refuse instead:
    // continuing would run the turn on a different model — and possibly a
    // different provider and billing — under the session's pinned identity.
    if (modelFallbackMessage) {
      try {
        session.dispose();
      } catch {
        // Best-effort: the rejection below is the primary signal.
      }
      throw new BackendRequestError(
        `Cannot resume on the session's saved model: ${modelFallbackMessage} ` +
          "Restore the credential (e.g. `pi login`) or start a new conversation."
      );
    }
    return { session, turnContext: toolkit.turnContext };
  }

  /**
   * Resolve the session for this turn and claim it (entry.running = true). A
   * matching in-memory session is reused (and touched for LRU); an unknown
   * running session raises a per-session BackendBusyError; an unknown resume id
   * or bad profile raises BackendRequestError (both before anything is emitted).
   */
  async function acquire(
    req: StartTurnRequest
  ): Promise<{ entry: SessionEntry; isNew: boolean }> {
    if (req.sessionId) {
      const existing = sessions.get(req.sessionId);
      if (existing) {
        if (existing.running) throw new BackendBusyError(PI_BACKEND_ID, req.sessionId);
        existing.running = true;
        touch(req.sessionId);
        return { entry: existing, isNew: false };
      }
      // Not resident — reopen the transcript from disk.
      const { session, turnContext } = await openSession(req.sessionId);
      // A concurrent turn for the same id may have registered it while we opened.
      const raced = sessions.get(req.sessionId);
      if (raced) {
        disposeSession(session);
        if (raced.running) throw new BackendBusyError(PI_BACKEND_ID, req.sessionId);
        raced.running = true;
        touch(req.sessionId);
        return { entry: raced, isNew: false };
      }
      const entry: SessionEntry = { session, turnContext, running: true };
      register(entry);
      return { entry, isNew: false };
    }
    const { session, turnContext } = await newSession(req.profileId);
    const existing = sessions.get(session.sessionId);
    if (existing) {
      // The runtime handed back an id we already track. In production pi ids are
      // unique so this never fires; the injected fake reuses ids, and either way
      // we must not clobber a running turn — surface per-session busy and drop
      // the duplicate.
      disposeSession(session);
      if (existing.running) throw new BackendBusyError(PI_BACKEND_ID, session.sessionId);
      existing.running = true;
      touch(session.sessionId);
      return { entry: existing, isNew: false };
    }
    const entry: SessionEntry = { session, turnContext, running: true };
    register(entry);
    return { entry, isNew: true };
  }

  function register(entry: SessionEntry): void {
    sessions.set(entry.session.sessionId, entry);
  }

  /** Move a reused session to the LRU tail so eviction favours colder sessions. */
  function touch(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    sessions.set(sessionId, entry);
  }

  function disposeSession(session: PiSessionLike): void {
    try {
      session.dispose();
    } catch {
      /* best effort */
    }
  }

  /** Dispose idle (not running) sessions, LRU-first, until back under the cap. */
  function evictIdle(): void {
    if (sessions.size <= MAX_IN_MEMORY_SESSIONS) return;
    for (const [id, entry] of sessions) {
      if (sessions.size <= MAX_IN_MEMORY_SESSIONS) break;
      if (entry.running) continue;
      disposeSession(entry.session);
      sessions.delete(id);
    }
  }

  /** Lifetime session cost, or null when the runtime can't report it. */
  function snapshotCost(session: PiSessionLike): number | null {
    try {
      const cost = session.getSessionStats().cost;
      return Number.isFinite(cost) ? cost : null;
    } catch {
      return null;
    }
  }

  /**
   * Turn cost = after - before. Returns undefined (→ omit `costUsd`) when
   * either snapshot is unavailable: the protocol defines 0 as "actually
   * free", so an unknown cost must not be reported as zero.
   */
  function turnCost(before: number | null, after: number | null): number | undefined {
    if (before === null || after === null) return undefined;
    return Math.max(0, after - before);
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
      const profiles = configuredProfiles();
      if (profiles && profiles.length > 0) {
        return profiles.map((p) => {
          // Effective reasoning level (pi defaults absent ones to "medium").
          // Presence doubles as "this profile supports an effort setting",
          // so it is OMITTED for models the catalog marks non-reasoning —
          // pi would clamp any level to "off" there, and advertising an
          // effort knob for them would be a lie. An unknown model (declared
          // typo — fails loudly at session time) gets no knob either.
          let reasoning = false;
          try {
            reasoning =
              p.vendor !== undefined &&
              (getBuiltinModel(p.vendor as never, p.model as never) as Model<any> | undefined)
                ?.reasoning === true;
          } catch {
            reasoning = false;
          }
          return {
            id: p.id,
            label: p.label,
            vendor: p.vendor,
            ...(reasoning ? { thinkingLevel: p.thinkingLevel ?? "medium" } : {}),
          };
        });
      }
      if (options.model) {
        const spec = parseModelString(options.model);
        return [{ id: "default", label: options.model, vendor: spec.vendor }];
      }
      return [];
    },

    async startTurn(req: StartTurnRequest): Promise<void> {
      const startedAt = Date.now();

      // acquire() claims the session (per-session busy) and validates caller
      // input. On any throw — BackendBusyError / BackendRequestError — nothing
      // has been emitted and the promise REJECTS, per the startTurn contract.
      const { entry, isNew } = await acquire(req);
      const { session, turnContext } = entry;
      const sessionId = session.sessionId;

      // Scope every frame this turn emits to its session so a multiplexed client
      // can demux concurrent sessions. Follow-up frames flow through this same
      // emit (the subscription below stays live for the whole turn).
      const emit = (msg: ServerMessage) => req.bridge.emit(scopeFrame(msg, sessionId));

      // Bind this session's tool plumbing to the current turn's bridge/signal.
      turnContext.bridge = req.bridge;
      turnContext.signal = req.signal;

      // Everything from here on runs inside the try: a throw from subscribe()
      // or the first emit() would otherwise leave entry.running stuck true,
      // bricking this session id (every later turn rejects BackendBusyError
      // and evictIdle skips running entries).
      let unsubscribe: () => void = () => {};
      // Latch the cancellation at the moment it happens. A post-hoc
      // signal.aborted check would mislabel a turn that COMPLETED and only
      // then got aborted as "cancelled", discarding a paid-for answer.
      let cancelled = req.signal.aborted;
      const onAbort = () => {
        cancelled = true;
        void session.abort();
      };
      const costBefore = snapshotCost(session);
      const turnUsage = createUsageAccumulator();
      let failed = false;

      try {
        if (!req.signal.aborted) {
          req.signal.addEventListener("abort", onAbort, { once: true });
        }

        unsubscribe = session.subscribe(makeEventHandler(emit, turnUsage));

        // session_info must precede any content frames for a new session.
        emit({
          type: "session_info",
          sessionId,
          isNew,
          backendId: PI_BACKEND_ID,
          ...(req.profileId ? { providerId: req.profileId } : {}),
        });

        // An already-aborted signal never fires "abort", and aborting a
        // session that has not been prompted does not cancel a LATER prompt —
        // so never start one. Prompting anyway would hang until the model
        // finished, leaking the concurrency slot for the whole turn.
        if (!req.signal.aborted) {
          const images = toImages(req);
          emit({ type: "status", status: "thinking" });
          await session.prompt(req.prompt, images.length > 0 ? { images } : undefined);
        }
      } catch (err) {
        // Runtime failure (no model/auth, provider unreachable) → diagnostic
        // error frame, then a terminal result with outcome "error". The
        // promise RESOLVES. A host abort also surfaces as a throw — that is
        // a cancellation, not an error; the abort path below owns it.
        failed = true;
        if (!cancelled) {
          emit({ type: "error", code: "agent_error", message: errorMessage(err) });
        }
      } finally {
        unsubscribe();
        req.signal.removeEventListener("abort", onAbort);
        turnContext.bridge = null;
        turnContext.signal = null;
        entry.running = false;
        // Now that this session is idle, drop cold sessions above the cap.
        evictIdle();
      }

      const costUsd = turnCost(costBefore, snapshotCost(session));
      const usage = turnUsage.toWire();

      if (cancelled) {
        emit({ type: "status", status: "cancelled" });
        emit({
          type: "result",
          sessionId,
          outcome: "cancelled",
          ...(costUsd !== undefined ? { costUsd } : {}),
          ...(usage ? { usage } : {}),
          durationMs: Date.now() - startedAt,
          numTurns: 1,
          isError: false,
        });
        return;
      }

      // Parity with the claude backend, which emits idle before its terminal
      // result — the two backends must produce interchangeable frame streams.
      emit({ type: "status", status: "idle" });
      emit({
        type: "result",
        sessionId,
        outcome: failed ? "error" : "success",
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(usage ? { usage } : {}),
        durationMs: Date.now() - startedAt,
        numTurns: 1,
        isError: failed,
      });
    },

    async followUp(req: FollowUpRequest): Promise<void> {
      const entry = sessions.get(req.sessionId);
      if (!entry || !entry.running) {
        // Follow-up only lands in a RUNNING turn; the host queues it as the
        // session's next turn otherwise.
        throw new BackendRequestError(
          `No running turn for session ${req.sessionId} to deliver a follow-up to.`
        );
      }
      // Injected into the live turn: pi's "followUp" queues the message within
      // the turn (delivered after the current assistant step + tool calls),
      // whereas "steer" would interrupt. Frames keep flowing through the running
      // turn's subscription/emit — no new subscription here.
      const images = toImages(req);
      await entry.session.prompt(req.prompt, {
        streamingBehavior: "followUp",
        ...(images.length > 0 ? { images } : {}),
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

/**
 * Stamp `sessionId` on an outgoing frame. Every ServerMessage variant permits a
 * string sessionId (SessionScoped frames make it optional; `result` and
 * `session_info` already require it), so this is safe for all of them.
 */
function scopeFrame(msg: ServerMessage, sessionId: string): ServerMessage {
  return { ...msg, sessionId } as ServerMessage;
}

/** Translate pi AgentSession events into wire-protocol frames. */
function makeEventHandler(emit: (msg: ServerMessage) => void, usage?: TurnUsageAccumulator) {
  return (ev: AgentSessionEvent): void => {
    usage?.observe(ev);
    for (const frame of mapPiEvent(ev)) emit(frame);
  };
}

/**
 * Sums per-message token usage across one turn. pi delivers a full `Usage`
 * (tokens + cost breakdown) on every assistant message; message_end is the
 * settled value for that message, so summing message_end events yields the
 * turn's tokens. Cost stays with the session-stats diff (`turnCost`) — the
 * authoritative number — while per-model cost sums ride the breakdown.
 */
export interface TurnUsageAccumulator {
  observe(ev: AgentSessionEvent): void;
  /** The wire usage block, or undefined when nothing was observed. */
  toWire(): TurnUsage | undefined;
}

export function createUsageAccumulator(): TurnUsageAccumulator {
  const perModel = new Map<string, ModelUsage>();

  return {
    observe(ev: AgentSessionEvent) {
      // turn_end re-delivers the LAST assistant message, which message_end
      // already counted — only message_end accumulates.
      if (ev.type !== "message_end") return;
      // ev is narrowed to the message_end variant ({ message: AgentMessage });
      // the role check narrows AgentMessage to pi-ai's AssistantMessage, whose
      // usage (tokens + cost) and model are required fields — no casts needed.
      const { message } = ev;
      if (!("role" in message) || message.role !== "assistant") return;
      // Runtime tolerance beyond the type: a usage-less assistant message
      // (a custom AgentMessage claiming the role) carries nothing to count.
      const u: Usage | undefined = message.usage;
      if (!u) return;
      const key = message.model;
      const entry = perModel.get(key) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      entry.inputTokens = (entry.inputTokens ?? 0) + (u.input ?? 0);
      entry.outputTokens = (entry.outputTokens ?? 0) + (u.output ?? 0);
      entry.cacheReadTokens = (entry.cacheReadTokens ?? 0) + (u.cacheRead ?? 0);
      entry.cacheCreationTokens = (entry.cacheCreationTokens ?? 0) + (u.cacheWrite ?? 0);
      if (typeof u.cost?.total === "number") {
        entry.costUsd = (entry.costUsd ?? 0) + u.cost.total;
      }
      perModel.set(key, entry);
    },

    toWire() {
      if (perModel.size === 0) return undefined;
      const breakdown: Record<string, ModelUsage> = {};
      for (const [model, u] of perModel) breakdown[model] = u;
      // Per-model costUsd sums ride the breakdown untouched; sumModelUsage
      // rolls up tokens only, leaving top-level cost to the session-stats diff.
      return sumModelUsage(breakdown);
    },
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

function toImages(req: { attachments?: ChatImageAttachment[] }): ImageContent[] {
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

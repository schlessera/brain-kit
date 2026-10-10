/**
 * AgentBackend — the seam between the brain-ui server and whatever agent
 * runtime drives a conversation. Two first-party implementations exist:
 * @schlessera/brain-backend-pi (upstream pi SDK, OSS default) and
 * @schlessera/brain-backend-claude (Claude Agent SDK, flat-rate-subscription
 * path). One backend is active per deployment (v1).
 *
 * ## startTurn contract (rev 2 — parallel sessions)
 *
 * - Resolves when the turn has fully ended: after the backend emitted its
 *   terminal frame (`result`, or a pre-identity `error`).
 * - Ordinary turns MUST emit `session_info` before content once identity is known.
 *   Explicit autonomous mode reports `autonomous_identity` through activity.
 * - Multi-session servers require every session-scoped frame to carry
 *   `sessionId` (backends emit it whenever the session identity is known).
 * - Abort: the host owns the AbortController (user cancel + timeout). Work stops
 *   and resolves after a cancelled result, or a pre-identity error terminal.
 * - Runtime failures (agent crashed, provider unreachable) are emitted as an
 *   `error` frame and the promise RESOLVES — the wire consumer needs the
 *   frame either way. The promise REJECTS only for caller errors: a turn on a
 *   session that is already running (BackendBusyError), an unknown profileId,
 *   or unsupported resume/autonomous mode (BackendRequestError).
 * - Concurrency: busy-ness is PER SESSION. When `capabilities.concurrentSessions`
 *   is true, turns on different sessions run in parallel (the host enforces
 *   its own deployment-time cap); when false, the backend is a single-turn
 *   instance and the host serializes.
 * - Follow-up: when `capabilities.followUp` is true the backend implements
 *   `followUp()` — the host delivers mid-turn user messages into the RUNNING
 *   turn (frames keep flowing through the original turn's bridge). When
 *   false the host queues the message and starts it as the session's next
 *   turn after the current one resolves (`status: queued` on the wire).
 * - Shared-repo safety: backends serialize MUTATING tool executions across
 *   all their sessions through a WriteLock (see write-lock.ts) — two agents
 *   editing one working tree must never interleave writes/git operations.
 */

import type {
  AskUserAnnotation,
  AskUserListSpec,
  AskUserRankSpec,
  AskUserFormSpec,
  AskUserFormLimits,
  AskUserFormAnswers,
  AskUserQuestion,
  BillingMode,
  ChatImageAttachment,
  ChatSession,
  ClientEnvironment,
  GeoCoords,
  GeoRequestOptions,
  ProfileUnavailableReason,
  ProviderInfo,
  ServerMessage,
  SessionHistoryMessage,
  ThinkingLevel,
} from "../protocol.js";

/**
 * A profile the backend is configured with but cannot run now, and why
 * (additive, #1044). `reason` is the closed `ProfileUnavailableReason` enum;
 * the host drops an entry with any other value and copies only these three
 * fields, so no backend-authored detail reaches a client.
 *
 * @experimental Part of the `AgentBackend` seam.
 */
export interface UnavailableProfile {
  id: string;
  label: string;
  reason: ProfileUnavailableReason;
}

/** @experimental Part of the `AgentBackend` seam. */
export interface BackendCapabilities {
  /** Explicit nonpersistent turns; does not claim containment or enable dispatch. */
  autonomous?: boolean;
  /** Can continue an existing session (startTurn with sessionId). */
  resume: boolean;
  /** Emits tool_approval_request round-trips via bridge.requestPermission. */
  permissions: boolean;
  /** Emits thinking_delta frames. */
  thinking: boolean;
  /** Accepts image attachments on startTurn. */
  attachments: boolean;
  /** Routes clarifying questions via bridge.askUser. */
  askUser: boolean;
  /** Reports known result.costUsd; unknown is null or absent, never a guessed zero. */
  costReporting: boolean;
  /** Turns on different sessions may run in parallel (busy-ness is per session). */
  concurrentSessions: boolean;
  /**
   * Mid-turn user messages are injected into the running turn via followUp().
   * false → the host queues them as the session's next turn (status: queued).
   */
  followUp: boolean;
}

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  description?: string;
  /**
   * What is being approved. "tool" (default) — a tool outside the
   * auto-allow list; the host may auto-answer from its remembered-tools
   * set and may offer "always allow". "command" — a destructive-pattern
   * confirmation for an otherwise auto-allowed tool; never remembered.
   */
  kind?: "tool" | "command";
  /**
   * This turn declared `enforceAllowedTools` and the tool is NOT on its
   * allowlist. The host must decide the request on its own merits: it may
   * neither answer it from its remembered "always allow" set nor add to that
   * set from the answer. A grant belongs to the posture it was given under,
   * and a narrower turn is a different posture in both directions.
   *
   * Absent (the default) the host behaves exactly as it always has.
   *
   * @experimental
   */
  outsideEnforcedAllowlist?: boolean;
}

export interface AskUserResult {
  answers: Record<string, string>;
  annotations?: Record<string, AskUserAnnotation>;
}

/** The user's answers to an `ask_user_list`, keyed by item id. */
export interface AskUserListResult {
  answers: Record<string, string>;
  notes?: Record<string, string>;
}

export interface AskUserFormResult { answers: AskUserFormAnswers }

export interface AskUserRankResult { order: string[]; unchanged: boolean }

export interface LocationFix {
  coords: GeoCoords;
  /** Epoch millis when the fix was taken. */
  timestamp: number;
}

/**
 * Host plumbing handed to the backend for one turn. `emit` delivers protocol
 * frames to the client; the request/response methods resolve when the user
 * answers and REJECT on cancel/disconnect — backends must translate a
 * rejection into the agent-appropriate tool error, never crash the turn.
 *
 * Optional members signal host capability: a backend only registers its
 * ask-user / location tooling when the corresponding method is present.
 *
 * @experimental Part of the `AgentBackend` seam.
 */
export interface BackendBridge {
  /** Host-owned, turn-bound application. Absent means no authoritative route. */
  readBrainBase?(path: string): Promise<{ content: string; expectedBaseHash: string }>;
  applyBrain?(input: import("./brain-application.js").BrainApplicationInput): Promise<import("./brain-application.js").BrainApplicationResult>;
  emit(msg: ServerMessage): void;
  /** Synchronous server checkpoint before a no-grant denial; never an approval promise. */
  checkpointPermission?(req: PermissionRequest): void;
  requestPermission(req: PermissionRequest): Promise<PermissionDecision>;
  askUser?(requestId: string, questions: AskUserQuestion[]): Promise<AskUserResult>;
  /**
   * Ask the user to place every item of a list on one scale, in one card.
   * Resolves with the answers by item id; rejects on dismiss or cancel.
   */
  askUserList?(requestId: string, request: AskUserListSpec): Promise<AskUserListResult>;
  /** Complete id order; rejects on dismiss or cancel. */
  askUserRank?(requestId: string, request: AskUserRankSpec): Promise<AskUserRankResult>;
  /** Conditional form, with host-owned configurable bounds. */
  askUserForm?(requestId: string, request: AskUserFormSpec): Promise<AskUserFormResult>;
  askUserFormLimits?: AskUserFormLimits;
  getLocation?(options?: GeoRequestOptions): Promise<LocationFix>;
  /**
   * Ask the user to paint a mask over an image. Resolves with a PNG whose
   * fully transparent pixels mark the editable region; rejects if the user
   * cancels or no client is connected.
   */
  requestMask?(imagePath: string, instruction?: string): Promise<Uint8Array>;
  /**
   * Prune the brain's scratch area after a bridge tool wrote into it (#310).
   * The host owns the policy (it runs `brain scratch prune` through its CLI
   * client) and never rejects; absent when the host has no scratch pass.
   */
  pruneScratch?(): Promise<void>;
  /**
   * Side channel for activity enrichment the wire protocol deliberately does
   * not carry to chat clients (subagent lifecycle/usage, transcript
   * excerpts). Present only when the host records activity; backends treat
   * it as fire-and-forget and MUST NOT let a throwing reporter fail a turn.
   */
  activity?(event: BackendActivityEvent): void;
  /**
   * Read the host's activity record — the same data the UI reads — so the
   * agent can answer "what ran / what is running?" from the record instead
   * of log forensics. Present only when the host records activity; backends
   * expose it as a read-only tool.
   */
  queryActivity?(query: ActivityQuery): Promise<ActivityQueryResult>;
}

/** A read over the activity record, shaped for model consumption. */
export interface ActivityQuery {
  scope: "running" | "recent" | "run" | "rollups" | "inbox";
  /** Required for scope "run". */
  runId?: string;
  /** Window for "recent"/"rollups", in hours back from now (default 24). */
  hoursBack?: number;
  limit?: number;
}

/** JSON-serializable result; the exact shape is the host's and may grow. */
export type ActivityQueryResult = Record<string, unknown>;

/**
 * Backend-reported activity enrichment. The host derives baseline spans from
 * the frames it already relays; these events add what only the backend sees.
 */
export type BackendActivityEvent =
  | {
      /** Runtime identity without advertising a resumable interactive session. */
      kind: "autonomous_identity";
      runtimeSessionId: string;
      backendId: string;
      profileId?: string;
    }
  | {
      kind: "subagent_started";
      /** The Agent tool call that spawned this subagent. */
      toolUseId: string;
      taskId?: string;
      subagentType?: string;
      description?: string;
      /** 1 for a top-level subagent, N+1 nested. */
      depth?: number;
    }
  | {
      kind: "subagent_status";
      toolUseId: string;
      status: "running" | "completed" | "failed" | "killed" | "paused";
      usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
      summary?: string;
    }
  | {
      kind: "subagent_transcript";
      toolUseId: string;
      role: "assistant" | "user";
      text: string;
    }
  | {
      /**
       * The backend refused a permission request instead of putting it to the
       * bridge (`noGrantSurface`). The host records a user's denial as the
       * card is answered, inside `requestPermission`; this one never gets
       * there, so it is reported here rather than left to close as the
       * backend's own error tool result.
       */
      kind: "permission_denied";
      /** The tool call the refusal belongs to. */
      toolUseId: string;
      /** The request that would have been raised, had anyone been able to answer it. */
      requestKind: "tool" | "command";
      /** Why, in the words the model was given. */
      reason: string;
    }
  | {
      /**
       * What the backend's runtime said about itself as the turn started: the
       * versions that actually ran, the credential it selected, and the billing
       * mode that credential implies. Observed, not classified — the host
       * records it next to the profile's classification, and a profile whose
       * policy the observation contradicts is flagged.
       */
      kind: "runtime_observed";
      runtime?: { name: string; version: string };
      sdk?: { name: string; version: string };
      /** The credential fields the runtime reported, in its own terms. */
      credential?: Record<string, string>;
      /** Derived from `credential`; "unknown" when it cannot be told. */
      billing: BillingMode | "unknown";
      /** What the turn's profile requires. */
      policy?: BillingMode;
      /** Set when `billing` contradicts `policy`: why, in one sentence. */
      policyViolation?: string;
      /** Whether this is the runtime the backend's behaviour was measured against. */
      measured?: boolean;
    }
  | {
      /**
       * The turn failed because the runtime could not authenticate — a
       * rejected or expired credential, an account on hold, a subscription
       * check that refused the turn. Recorded as its own failure class, apart
       * from other errors, so an operator is told to log in again.
       */
      kind: "auth_failure";
      /** The runtime's own class for it, e.g. `authentication_failed`. */
      errorClass: string;
      message?: string;
    };

// The subscription auth actions are part of the wire (`TurnFailure.authAction`,
// #575), so they live beside it; the server entry keeps exporting them.
export {
  SUBSCRIPTION_AUTH_INSTRUCTIONS,
  SUBSCRIPTION_RELOGIN_PROCEDURE,
  subscriptionAuthAction,
} from "../protocol.js";
export type { SubscriptionAuthAction } from "../protocol.js";

/** @experimental Part of the `AgentBackend` seam. */
export interface StartTurnRequest {
  /** Server-only explicit mode. Absent preserves the ordinary session contract. */
  autonomous?: AutonomousTurnOptions;
  prompt: string;
  attachments?: ChatImageAttachment[];
  /** Resume this session (requires capabilities.resume). Absent = new session. */
  sessionId?: string;
  /**
   * Opaque profile id from listProfiles(). Travels the wire as `providerId`
   * (historical name). Only honored on new sessions — resumed sessions stay
   * pinned to their original profile.
   */
  profileId?: string;
  /** One-turn effort override. Resumes re-read defaults; this does not pin effort to a session. */
  thinkingLevel?: ThinkingLevel;
  /** Host-owned cancellation (user cancel + host timeout). */
  signal: AbortSignal;
  /**
   * The host's per-turn timeout for THIS turn, in ms — the budget after which
   * `signal` fires. Advisory: backends that build a per-turn system prompt
   * should surface it (`buildSystemPromptAppend({ turnBudgetMs })`) so the
   * model can size its work to the cap instead of discovering it mid-flight.
   */
  turnBudgetMs?: number;
  bridge: BackendBridge;
  /**
   * What the reader is on, as the browser measured it at send time. Absent
   * when the client is older or headless. Backends that can vary their system
   * prompt per turn should feed it to `buildSystemPromptAppend()`; it is
   * advisory and never required.
   */
  client?: ClientEnvironment;
  /**
   * Treat this turn's tool allowlist as a BOUNDARY rather than merely an
   * auto-allow list. Every conforming backend must not admit a tool absent
   * from the allowlist through any shortcut that skips the permission
   * decision — input-rewrite hooks that grant so their rewrite applies, a
   * host's remembered "always allow" set, or anything else it adds later.
   * The tool is not forbidden; the decision is simply never skipped, and the
   * request carries `outsideEnforcedAllowlist` so the host cannot skip it
   * either.
   *
   * Absent or false (the default) every existing deployment behaves exactly
   * as it always has. A conforming backend must enforce this posture or reject
   * it with BackendRequestError before runtime execution. Silent ignoring is
   * forbidden; the field remains an optional per-turn input.
   *
   * @experimental
   */
  enforceAllowedTools?: boolean;
  /**
   * This turn has NO surface that could grant a permission request: nobody is
   * looking at an approval card and nothing else can answer one. A conforming
   * backend resolves such a request `{ behavior: "deny", message }`
   * itself, naming the tool, instead of putting it to the bridge — a card
   * raised here is a card nobody can answer, and it parks until the turn
   * budget expires. A capability that needs a human surface is withheld from
   * the turn for the same reason, rather than offered and then blocked on.
   *
   * Distinct from `enforceAllowedTools`, and only valid WITH it: a turn may
   * enforce its allowlist and still have a human able to answer a card, but
   * it is enforcement that makes the decision happen here at all rather than
   * be skipped by one of the runtime's own shortcuts. Declared without it,
   * the shipped backends reject the turn with `BackendRequestError`
   * (`assertTurnPosture`).
   *
   * Absent or false (the default) every existing deployment behaves exactly as
   * it always has. A conforming backend must enforce this posture or reject it
   * with BackendRequestError before runtime execution. Silent ignoring is
   * forbidden; the field remains an optional per-turn input.
   *
   * @experimental
   */
  noGrantSurface?: boolean;
  /**
   * Run this turn under the backend's declared VOICE tool posture
   * (docs/decisions/voice-permission.md "The voice posture"): the backend
   * selects its named voice allowlist in place of its ordinary one. Only valid
   * with `enforceAllowedTools` and `noGrantSurface` (`assertTurnPosture`). A
   * backend that declares no voice posture must reject the turn with
   * `BackendRequestError` rather than run it on its ordinary allowlist.
   *
   * Absent (the default) every existing deployment behaves exactly as it
   * always has. Hosts set it for turns a live conversation starts (#957).
   *
   * @experimental
   */
  posture?: "voice";
}

/** @experimental Nonpersistence and permission posture, not a containment profile. */
export interface AutonomousTurnOptions {
  origin: "autonomous";
  persistence: "none";
  /** Exact runtime names selected by the server; never inherited from a client or model. */
  allowedTools: readonly string[];
  /** Server-selected prompt configuration; cache/static-prefix work is separate. */
  systemPromptAppend: string;
  /** Server-only, synchronous checkpoint before cooperative abort. The backend
   * notifies once per turn when an interactive waiter reaches the threshold. */
  onYield?: (key: string) => void;
  yieldAfterMs?: number;
  /** Server-retained execution receipts, never capability grants. A fresh
   * attempt refuses automatic replay of these exact completed calls. */
  completedToolCalls?: readonly CompletedAutonomousToolCall[];
}

export interface CompletedAutonomousToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

/** Order-insensitive JSON input comparison; receipts only restrict authority. */
export function isCompletedAutonomousToolCall(
  mode: AutonomousTurnOptions | undefined, toolName: string, input: unknown
): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])
    );
    return value;
  };
  const key = JSON.stringify(canonical(input));
  return mode?.completedToolCalls?.some((call) => call.toolName === toolName && JSON.stringify(canonical(call.input)) === key) ?? false;
}

/** Mid-turn user message for a RUNNING session (capabilities.followUp). */
export interface FollowUpRequest {
  sessionId: string;
  prompt: string;
  attachments?: ChatImageAttachment[];
}

/**
 * The runtime that drives a chat session. A `BackendModule` constructs one.
 *
 * @experimental Extension seam; may change before 1.0.
 */
export interface AgentBackend {
  /** Stable identity, e.g. "pi" | "claude". Persisted per session (backend_id). */
  id: string;
  capabilities: BackendCapabilities;
  /** Model/endpoint profiles this backend can run. Never exposes keys. */
  listProfiles(): ProviderInfo[] | Promise<ProviderInfo[]>;
  /**
   * Profiles this backend is configured with but cannot run now (additive,
   * #1044). Optional and absent by default: a backend that omits it reports
   * none. Never part of `listProfiles()`, so routing and the runnable roster
   * are unaffected; the host lists them apart, for presentation only.
   */
  listUnavailableProfiles?(): UnavailableProfile[] | Promise<UnavailableProfile[]>;
  /** Resolve configured authority in the trusted host, before any worker initializes. */
  brainApplicationPolicy?(req: Pick<StartTurnRequest, "profileId" | "posture" | "autonomous" | "noGrantSurface" | "enforceAllowedTools">): import("./brain-application.js").BrainApplicationPolicy;
  startTurn(req: StartTurnRequest): Promise<void>;
  /**
   * Inject a user message into a session's RUNNING turn (only when
   * capabilities.followUp). Frames keep flowing through that turn's bridge;
   * rejects with BackendRequestError when the session has no running turn.
   * The host calls it only once it has handed the turn to startTurn, and
   * queues a message refused that way as the session's next turn.
   */
  followUp?(req: FollowUpRequest): Promise<void>;
  /** Sessions this backend owns (its own transcript store). */
  listSessions(): Promise<ChatSession[]>;
  /** Normalized-at-read history; backends own raw transcripts. */
  getHistory(sessionId: string): Promise<SessionHistoryMessage[]>;
}

/**
 * A startTurn for a session that already has a running turn (or, for
 * single-turn backends, any concurrent turn). The host queues instead.
 */
export class BackendBusyError extends Error {
  constructor(backendId: string, sessionId?: string) {
    super(
      sessionId
        ? `Backend "${backendId}" already has an active turn for session ${sessionId}`
        : `Backend "${backendId}" already has an active turn`
    );
    this.name = "BackendBusyError";
  }
}

/** Invalid startTurn request (unknown profile, unsupported resume, …). */
export class BackendRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendRequestError";
  }
}

/**
 * Refuse a turn whose permission posture cannot mean what it says: one that
 * declares `noGrantSurface` without `enforceAllowedTools`. Without enforcement
 * a runtime's own shortcuts can admit a tool before any permission request is
 * raised, so the refusal `noGrantSurface` promises is never reached for it.
 * Every shipped backend calls this first in `startTurn`, including one whose
 * runtime has no such shortcuts, so one rule describes the declaration
 * wherever a posture runs.
 *
 * @experimental
 */
export function assertTurnPosture(
  req: Pick<StartTurnRequest, "enforceAllowedTools" | "noGrantSurface" | "autonomous" | "sessionId"> & Partial<Pick<StartTurnRequest, "bridge" | "posture">>,
  supportsAutonomous: boolean = false
): void {
  if (req.autonomous !== undefined) {
    if (!supportsAutonomous) throw new BackendRequestError("This backend does not support autonomous turns.");
    if (req.sessionId !== undefined || req.autonomous.origin !== "autonomous" ||
        req.autonomous.persistence !== "none" || !Array.isArray(req.autonomous.allowedTools) ||
        !req.autonomous.allowedTools.every((name) => typeof name === "string" && name.length > 0) ||
        typeof req.autonomous.systemPromptAppend !== "string" ||
        (req.autonomous.onYield !== undefined && typeof req.autonomous.onYield !== "function") ||
        (req.autonomous.yieldAfterMs !== undefined && (!Number.isFinite(req.autonomous.yieldAfterMs) || req.autonomous.yieldAfterMs <= 0)) ||
        (req.autonomous.completedToolCalls !== undefined && (!Array.isArray(req.autonomous.completedToolCalls) ||
          !req.autonomous.completedToolCalls.every((call) => call && typeof call.toolName === "string" && call.input && typeof call.input === "object" && !Array.isArray(call.input)))) ||
        req.enforceAllowedTools !== true || req.noGrantSurface !== true ||
        typeof req.bridge?.checkpointPermission !== "function") {
      throw new BackendRequestError("Autonomous turns require nonpersistence, an explicit tool policy, enforced no-grant posture and a checkpoint bridge; resume is forbidden.");
    }
  }
  if (req.posture !== undefined &&
      (req.posture !== "voice" || req.autonomous !== undefined || req.enforceAllowedTools !== true || req.noGrantSurface !== true)) {
    throw new BackendRequestError(
      "A voice-posture turn must declare enforceAllowedTools and noGrantSurface, and cannot be autonomous."
    );
  }
  if (req.noGrantSurface === true && req.enforceAllowedTools !== true) {
    throw new BackendRequestError(
      "A turn that declares noGrantSurface must also declare enforceAllowedTools. " +
        "Without enforcement a tool can be admitted before any permission request " +
        "is raised, so there would be nothing to refuse."
    );
  }
}

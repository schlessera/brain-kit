import { type AskUserFormLimits } from "@schlessera/brain-ui-sdk/tool-contracts";
import { resolveAskUserFormLimits } from "@schlessera/brain-ui-sdk/internal/client";
import { FOLLOW_UP_QUEUE_CAPABILITY, type ServerMessage, type ServerSessionQueue } from "@schlessera/brain-ui-sdk/protocol";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { TurnClassifier } from "../classification/classify-turn.js";
import { ClientSet, sendTo, type WSContext } from "./clients.js";
import { followUpView, TurnCoordinator, type FollowUpQueueChange } from "./turns.js";
import type { SessionCatalog } from "./session-catalog.js";
import type { BackendRegistry } from "../agent/backend.js";
import { createSilentObservability, type Observability } from "../observability/index.js";
import { FrameRateLimiter } from "./rate-limit.js";
import type { ActivityStore } from "../activity/store.js";
import type { ActivityStream } from "../activity/stream.js";
import type { PushSender } from "../activity/push-sender.js";
import type { RuntimeStatus } from "../activity/runtime-status.js";
import type { Principal } from "../db/principals.js";
import type { InboxStream } from "../inbox/stream.js";
import type { DraftStore } from "../drafts/store.js";
import { spliceLocalExchanges, stripLocalContext } from "./local-exchanges.js";
import { FailureReplay } from "./turn-failures.js";
import type { LiveConversationProvider } from "@schlessera/brain-ui-sdk/server";
import { assertLiveConversationProvider } from "@schlessera/brain-ui-sdk/server";
import { ConversationHost } from "./conversation.js";
import type { Labeller } from "../labels/labeller.js";
import { createPillLabels, type PillLabels } from "../labels/pill-labels.js";

/** The activity record and its live stream, when the host records activity. */
export interface ActivityRuntime {
  store: ActivityStore;
  stream: ActivityStream;
  /** Push bindings invalidated through the same principal-revocation boundary. */
  pushSender?: Pick<PushSender, "unbindPrincipal">;
  /** Read seam for the agent-facing query tool (bridge.queryActivity). */
  query?: (query: import("@schlessera/brain-ui-sdk/server").ActivityQuery) => Record<string, unknown>;
  /** Where each turn's runtime report and auth failures are kept for /api/status. */
  runtime?: Pick<RuntimeStatus, "observe" | "authFailure"> & Partial<Pick<RuntimeStatus, "subscriptionProven">>;
}

/** Host-side turn timeout. The backend no longer times out — the host owns it. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Default cap on concurrently RUNNING sessions (MAX_CONCURRENT_SESSIONS). */
const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;
const AUTHORIZATION_EXPIRY_SWEEP_MS = 1_000;
const SESSION_EXPIRED_CLOSE_CODE = 1008;
const SESSION_EXPIRED_CLOSE_REASON = "Session expired";

/**
 * Budget for the host-side follow-up queue of ONE session (backends without a
 * native `followUp`; with one, messages go into the running turn and none of
 * this applies).
 *
 * Bytes rather than a message count, because that is what the cost actually
 * tracks: a queued entry is retained in this process until its turn runs, and
 * an entry carrying four images outweighs a hundred carrying text. Counting
 * messages made a text-only queue and a 50 MB image queue look identical.
 *
 * Past the warn mark the message is still accepted — the sender is told the
 * queue is getting heavy, in `detail` on the `queued` status and in the server
 * log. Past the hard cap it is refused with SESSION_QUEUE_FULL, which is an
 * explicit error frame, never a silent drop.
 */
export const QUEUE_WARN_BYTES = 20 * 1024 * 1024;
export const QUEUE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Backstop on depth. Bytes do not bound COUNT, and every queued entry becomes
 * its own turn: without this, ~500k one-line messages fit inside the byte cap
 * and would run the session for days. Not the limit anyone should hit.
 */
export const MAX_SESSION_QUEUE = 50;

export interface WsHostOptions {
  /** Concrete contained staging root for track attachments; absent refuses the new path. */
  brainPath?: string;
  askUserFormLimits?: Partial<AskUserFormLimits>;
  /** Backend registry resolving profiles/sessions to agent backends. */
  registry: BackendRegistry;
  /**
   * Session persistence seam (SQLite catalog in production).
   * @internal Supplied by createApp (#1053).
   */
  catalog: SessionCatalog;
  /**
   * The classification pass over finished turns (D42). Absent means no pass:
   * answers render as markdown, which is also what every failure of the pass
   * means.
   * @internal Supplied by createApp (#1053).
   */
  classifier?: TurnClassifier | null;
  /**
   * The pill labeller (#1004). Absent or disabled means no labels: pills
   * print their fallbacks, and nothing else changes.
   */
  labeller?: Labeller | null;
  /**
   * The scratch prune a bridge tool runs after writing into the scratch area
   * (#310): the host's own periodic pass, so the policy stays in core's CLI.
   * Absent means bridge tools do not prune.
   */
  scratchPrune?: () => Promise<void>;
  /** Display name used in connection/status copy. */
  appName?: string;
  /** Per-turn timeout in ms (default 10 minutes). */
  turnTimeoutMs?: number;
  /**
   * Cap on concurrent RUNNING sessions. Each running turn is roughly one CLI
   * subprocess, so this bounds memory/CPU. A function so an embedder can make
   * it dynamic; createApp passes the resolved config value.
   */
  maxConcurrentSessions?: () => number;
  /**
   * Where this coordinator reports. Injected rather than reached for, so two
   * apps in one process report separately and a test can assert on what the
   * socket layer actually said. Defaults to silence: an embedder that never
   * passes one gets no output, not a surprise stream on stdout.
   */
  observability?: Observability;
  /**
   * Inbound frame metering policy, per connection. Omitted (or a rate of 0)
   * means no metering — which is what a test wants, and what an embedder
   * fronting the socket with its own limiter wants.
   */
  wsRate?: { ratePerSecond: number; burst: number };
  /** Maximum WebSocket connections accepted by this host (default 32). */
  wsMaxConnections?: number;
  /**
   * Final synchronous check before a resolved principal becomes discoverable
   * to in-memory revocation. Production re-reads the principal row here; a
   * host without durable authentication (including focused tests) accepts the
   * already-resolved principal.
   */
  isPrincipalValid?: (principal: Principal) => boolean;
  /**
   * Activity recording (span store + live stream). Optional: a host without
   * one records nothing and never sends activity frames — which is also what
   * most existing tests want.
   * @internal Supplied by createApp (#1053).
   */
  activity?: ActivityRuntime;
  /**
   * The concrete durable stream; absent on hosts without durable inbox support.
   * @internal Supplied by createApp (#1053).
   */
  inbox?: InboxStream;
  /**
   * The user's remembered "always allow" tool grants. Optional: a host
   * without one never auto-answers and never persists an `always` approval —
   * every card stays per-use (what existing tests expect).
   * @internal Supplied by createApp (#1053).
   */
  toolPermissions?: ToolPermissions;
  /**
   * Live-conversation provider (#957). Absent means the host does not
   * advertise `liveConversation` and refuses every `conversation_*` frame.
   * @experimental Part of the LiveConversationProvider seam until 1.0.
   */
  conversationProvider?: LiveConversationProvider;
  /**
   * Host draft storage (#979). Present: `server_hello` advertises
   * `sessionDrafts` and an accepted `chat_message.draftRef` consumes its
   * revision. Absent: drafts are neither advertised nor touched.
   * @internal Supplied by createApp (#1053).
   */
  drafts?: DraftStore;
}

/** The remembered per-tool auto-allow store the ws layer consults. */
export interface ToolPermissions {
  /** Whether requests for this tool are answered "allow" without a card. */
  isAutoAllowed(toolName: string): boolean;
  /** Remember this tool as always allowed. */
  add(toolName: string): void;
}

/** Identity of one turn, as it appears on a log record. */
export interface TurnLogContext {
  sessionId?: string | null;
  turnId?: string | null;
  providerId?: string | null;
}

/**
 * Log attributes for one turn. Null fields are omitted rather than stringified
 * — a new session has no sessionId until `session_info` names it.
 */
export function turnLogAttributes(turn: TurnLogContext): Record<string, string> {
  return {
    ...(turn.sessionId ? { "session.id": turn.sessionId } : {}),
    ...(turn.turnId ? { "turn.id": turn.turnId } : {}),
    ...(turn.providerId ? { profile: turn.providerId } : {}),
  };
}

/**
 * Everything one WebSocket coordinator instance owns: turn state, the session
 * catalog, the backend registry, the attached client sockets, branding copy,
 * and the frame senders. Handlers receive this host explicitly — there is no
 * module-level default host, so two apps coexist without sharing state.
 *
 * An embedder meets it as `BrainUiApp.wsHost`, which `createApp` constructs.
 * Its supported surface is the resolved configuration (`brainPath`,
 * `askUserFormLimits`, `appName`, `turnTimeoutMs`, `maxConcurrentSessions`,
 * `observability`), the backend `registry` and `close()`. Every member tagged
 * `@internal` is wiring for the package's own connection, dispatch and route
 * modules (#1053; docs/decisions/public-export-boundary.md).
 */
export class WsHost {
  readonly brainPath?: string;
  /** @internal Host wiring (#1053). */
  readonly failureReplay: FailureReplay;
  readonly askUserFormLimits: AskUserFormLimits;
  /** @internal Turn bookkeeping shared with the package's own connection and dispatch modules. */
  readonly coordinator: TurnCoordinator = new TurnCoordinator();
  /** @internal Host wiring (#1053). */
  readonly clients: ClientSet;
  readonly registry: BackendRegistry;
  /** @internal Host wiring (#1053). */
  catalog: SessionCatalog;
  appName: string;
  turnTimeoutMs: number;
  maxConcurrentSessions: () => number;
  readonly observability: Observability;
  /** @internal Host wiring (#1053). */
  readonly wsRate: { ratePerSecond: number; burst: number } | null;
  /** @internal Host wiring (#1053). */
  readonly isPrincipalValid: (principal: Principal) => boolean;
  /** @internal Host wiring (#1053). */
  readonly activity: ActivityRuntime | null;
  /** @internal Host wiring (#1053). */
  readonly inbox: InboxStream | null;
  /** @internal Host wiring (#1053). */
  readonly drafts: DraftStore | null;
  /** @internal Host wiring (#1053). */
  readonly toolPermissions: ToolPermissions | null;
  /**
   * Live-conversation orchestration, when a provider is registered.
   * @internal Host wiring (#1053).
   */
  readonly conversations: ConversationHost | null;
  /** @internal Host wiring (#1053). */
  readonly classifier: TurnClassifier | null;
  /**
   * Where pill labels are asked for (#1004); null when the host labels nothing.
   * @internal Host wiring (#1053).
   */
  readonly labels: PillLabels | null;
  /** @internal Host wiring (#1053). */
  readonly scratchPrune?: () => Promise<void>;
  /**
   * Scoped instruments, resolved once — `[ws]` is the existing log prefix.
   * @internal Host wiring (#1053).
   */
  readonly log: ReturnType<Observability["logger"]>;
  private readonly framesDropped: ReturnType<
    ReturnType<Observability["meter"]>["createCounter"]
  >;
  private readonly turnsStarted: ReturnType<
    ReturnType<Observability["meter"]>["createCounter"]
  >;
  private readonly turnsCompleted: ReturnType<
    ReturnType<Observability["meter"]>["createCounter"]
  >;
  private readonly turnsFailed: ReturnType<
    ReturnType<Observability["meter"]>["createCounter"]
  >;
  private readonly wsErrors: ReturnType<
    ReturnType<Observability["meter"]>["createCounter"]
  >;
  private readonly connectionsRefused: ReturnType<
    ReturnType<Observability["meter"]>["createCounter"]
  >;
  private readonly authorizationExpiryTimer: ReturnType<typeof setInterval>;

  constructor(options: WsHostOptions) {
    this.brainPath = options.brainPath;
    this.askUserFormLimits = resolveAskUserFormLimits(options.askUserFormLimits);
    this.clients = new ClientSet(options.wsMaxConnections, (principalIds) => {
      this.coordinator.invalidateAuthorizations(principalIds);
    });
    this.registry = options.registry;
    this.catalog = options.catalog;
    this.appName = options.appName ?? "Brain UI";
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxConcurrentSessions =
      options.maxConcurrentSessions ?? (() => DEFAULT_MAX_CONCURRENT_SESSIONS);
    this.observability = options.observability ?? createSilentObservability();
    this.wsRate =
      options.wsRate && options.wsRate.ratePerSecond > 0 ? options.wsRate : null;
    this.isPrincipalValid = options.isPrincipalValid ?? (() => true);
    this.activity = options.activity ?? null;
    this.inbox = options.inbox ?? null;
    this.drafts = options.drafts ?? null;
    this.toolPermissions = options.toolPermissions ?? null;
    if (options.conversationProvider) assertLiveConversationProvider(options.conversationProvider);
    this.conversations = options.conversationProvider
      ? new ConversationHost(this, options.conversationProvider)
      : null;
    this.classifier = options.classifier ?? null;
    this.labels = options.labeller?.enabled
      ? createPillLabels({ labeller: options.labeller, catalog: this.catalog, coordinator: this.coordinator })
      : null;
    if (options.scratchPrune) this.scratchPrune = options.scratchPrune;
    this.log = this.observability.logger("ws");
    this.failureReplay = new FailureReplay(this.catalog, this.log);
    const meter = this.observability.meter("ws");
    this.framesDropped = meter.createCounter("ws.frames.dropped", {
      description: "Inbound frames refused before reaching a handler",
    });
    this.turnsStarted = meter.createCounter("turns.started", {
      description: "Turns handed to a backend",
    });
    this.turnsCompleted = meter.createCounter("turns.completed", {
      description: "Turns whose backend call resolved without throwing",
    });
    this.turnsFailed = meter.createCounter("turns.failed", {
      description: "Turn failures surfaced to the client, by error code",
    });
    this.wsErrors = meter.createCounter("ws.errors", {
      description: "Transport errors reported by the socket layer",
    });
    this.connectionsRefused = meter.createCounter("ws.connections.refused", {
      description: "WebSocket connections refused before admission",
    });
    this.coordinator.log = this.log;
    // Every settled permission request, by any path, reaches the connections
    // that asked for host outcomes (#957).
    this.coordinator.onApprovalSettled = (toolUseId, record) => {
      this.sendToCapable("toolResolution", {
        type: "tool_resolution",
        toolUseId,
        outcome: record.outcome,
        ...(record.sessionId ? { sessionId: record.sessionId } : {}),
        turnId: record.turnId,
        ...(record.channel ? { channel: record.channel } : {}),
        ...(record.reason ? { reason: record.reason } : {}),
      });
    };
    // Every change to a session's pending follow-ups reaches the connections
    // that asked for the queue (#1002).
    this.coordinator.onQueueChanged = (sessionId, change) => {
      this.sendToCapable(FOLLOW_UP_QUEUE_CAPABILITY, this.followUpQueueFrame(sessionId, change));
    };
    this.authorizationExpiryTimer = setInterval(
      () => this.expireAuthorizationContexts(),
      AUTHORIZATION_EXPIRY_SWEEP_MS
    );
    this.authorizationExpiryTimer.unref?.();
  }

  /**
   * A metering bucket for one new connection, or null when metering is off.
   * @internal Host wiring (#1053).
   */
  newRateLimiter(): FrameRateLimiter | null {
    return this.wsRate ? new FrameRateLimiter(this.wsRate) : null;
  }

  /**
   * Record a frame this server refused, and say so.
   *
   * Before this existed, every rejection answered the client and vanished:
   * `parseClientMessage` failures were never logged, so the validation we
   * already shipped had no observability at all. `reason` is a bounded token,
   * never the frame body — the payload is caller-supplied and can be 12 MB.
   * @internal Host wiring (#1053).
   */
  reportDroppedFrame(reason: string, detail?: string): void {
    this.framesDropped.add(1, { reason, direction: "inbound" });
    this.log.emit({
      severityText: "WARN",
      body: "inbound frame rejected",
      attributes: detail ? { reason, detail } : { reason },
    });
  }

  /**
   * Record a socket refused because this process has reached its connection cap.
   * @internal Host wiring (#1053).
   */
  reportRefusedConnection(): void {
    this.connectionsRefused.add(1, { reason: "connection_limit" });
    this.log.emit({
      severityText: "WARN",
      body: "websocket connection refused",
      attributes: {
        reason: "connection_limit",
        "connection.limit": this.clients.maxConnections,
      },
    });
  }

  /**
   * A turn began executing: counted, and logged with its correlation ids.
   * @internal Host wiring (#1053).
   */
  reportTurnStarted(turn: TurnLogContext): void {
    this.turnsStarted.add(1);
    this.log.emit({
      severityText: "INFO",
      body: "turn started",
      attributes: turnLogAttributes(turn),
    });
  }

  /**
   * Replayed history with its classified blocks joined on (D42); unchanged without a classifier.
   * @internal Host wiring (#1053).
   */
  attachMessageBlocks(sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[] {
    return this.classifier ? this.classifier.attach(sessionId, messages) : messages;
  }

  /**
   * Replayed history as the host sends it: each observed turn's id on the
   * answer that ended it (#964), the context blocks of locally
   * answered commands stripped from the prompts that carried them, each user
   * message's recorded source joined on, with or without a classifier, then
   * its classified blocks, and last the local exchanges put back in place
   * (#582). The exchanges go in last so the source join still counts only
   * the messages the backend replayed. A session without exchanges replays
   * exactly as it did before they existed.
   * @internal Host wiring (#1053).
   */
  prepareHistory(sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[] {
    // Turn ids first: boundaries were observed on the backend's own messages.
    messages = this.catalog.attachTurnBoundaries?.(sessionId, messages) ?? messages;
    messages = this.catalog.attachTurnFailures?.(sessionId, messages) ?? messages;
    const exchanges = this.catalog.loadLocalExchanges?.(sessionId) ?? [];
    const { messages: stripped, carriers } = stripLocalContext(messages, exchanges);
    const withSources = this.catalog.attachMessageSources?.(sessionId, stripped) ?? stripped;
    const joined = spliceLocalExchanges(this.attachMessageBlocks(sessionId, withSources), exchanges, carriers);
    return this.catalog.attachRetryRequest?.(sessionId, joined) ?? joined;
  }

  /**
   * A turn's backend call resolved: counted, and logged with its duration.
   * @internal Host wiring (#1053).
   */
  reportTurnCompleted(turn: TurnLogContext, durationMs: number): void {
    this.turnsCompleted.add(1);
    this.log.emit({
      severityText: "INFO",
      body: "turn completed",
      attributes: { ...turnLogAttributes(turn), "duration.ms": durationMs },
    });
  }

  /**
   * Record a turn failure the client is being told about. Before this existed
   * every such failure was an error FRAME only — visible on one phone screen,
   * absent from the server's own record.
   *
   * `code` is the bounded error-frame code (it feeds a counter attribute);
   * `error` is the thrown message and rides only on the log record — never a
   * caller-supplied frame body, per the reportDroppedFrame model.
   * @internal Host wiring (#1053).
   */
  reportTurnFailed(code: string, turn: TurnLogContext, error?: string): void {
    this.turnsFailed.add(1, { code });
    this.log.emit({
      // A busy session is the client racing itself; everything else is a
      // failure the operator should see.
      severityText: code === "SESSION_BUSY" ? "WARN" : "ERROR",
      body: "turn failed",
      attributes: {
        code,
        ...turnLogAttributes(turn),
        ...(error ? { error } : {}),
      },
    });
  }

  /**
   * Record a socket that closed abnormally. This is the transport-error signal
   * available on Bun: hono's Bun adapter dispatches only open/message/close
   * (never WSEvents.onError, and Bun's ServerWebSocket has no error callback),
   * so a transport failure surfaces as a close with an abnormal code.
   * @internal Host wiring (#1053).
   */
  reportAbnormalClose(code: number): void {
    this.wsErrors.add(1, { "close.code": code });
    this.log.emit({
      severityText: "WARN",
      body: "websocket closed abnormally",
      attributes: { "close.code": code },
    });
  }

  /**
   * Fan a frame out to every attached client (size-bounded per frame).
   * @internal Host wiring (#1053).
   */
  sendToClients(msg: ServerMessage): void {
    this.clients.broadcast(msg, () => {
      // Outbound counterpart of reportDroppedFrame: the peer never saw this
      // frame. Counted only — a dead socket would otherwise WARN per frame
      // until its onClose prunes it.
      this.framesDropped.add(1, {
        reason: "broadcast_send_failed",
        direction: "outbound",
      });
    });
  }

  /**
   * A session's pending follow-ups, whole, with what just changed (#1002).
   * @internal Host wiring (#1053).
   */
  followUpQueueFrame(sessionId: string, change: FollowUpQueueChange = {}): ServerSessionQueue {
    // A reason can be a backend's routing error; the SDK refuses the whole
    // frame over one longer than 500 characters.
    const why = change.dropped?.reason ?? "";
    const reason = why.length > 500 ? `${why.slice(0, 499)}…` : why;
    const dropped = change.dropped?.entries.map((entry) => ({
      id: entry.followUpId ?? "",
      ...(entry.requestId ? { requestId: entry.requestId } : {}),
      reason,
    })).filter((entry) => entry.id);
    return {
      type: "session_queue",
      sessionId,
      followUps: this.coordinator.pendingFollowUps(sessionId).map(followUpView).filter((view) => view.id),
      ...(change.started?.entry.followUpId
        ? { started: { ...followUpView(change.started.entry), turnId: change.started.turnId } }
        : {}),
      ...(dropped?.length ? { dropped } : {}),
    };
  }

  /**
   * Fan a negotiated frame out to the clients that declared `capability`.
   * @internal Host wiring (#1053).
   */
  sendToCapable(capability: string, msg: ServerMessage): void {
    this.clients.broadcast(
      msg,
      () => {
        this.framesDropped.add(1, { reason: "broadcast_send_failed", direction: "outbound" });
      },
      capability
    );
  }

  /**
   * Apply principal-store revocation to every in-memory authority boundary.
   * Running turns are marked but deliberately not aborted.
   * @internal Host wiring (#1053).
   */
  revokePrincipals(principalIds: readonly string[], code: number, reason: string): void {
    const revoked = new Set(principalIds);
    if (revoked.size === 0) return;
    const affectedRunning = this.coordinator.revokePrincipals(revoked);
    for (const principalId of revoked) {
      this.clients.closeFor(principalId, code, reason);
      this.activity?.stream.dropFor(principalId);
      this.inbox?.dropFor(principalId);
      this.activity?.pushSender?.unbindPrincipal(principalId);
    }
    for (const turn of affectedRunning) {
      turn.recorder?.recordPrincipalRevocation(turn.principalId);
    }
  }

  /**
   * Route expiry through the same full boundary as explicit revocation.
   * @internal Host wiring (#1053).
   */
  expireAuthorizationContexts(now: number = Date.now()): void {
    const expired = new Set<string>();
    this.coordinator.collectExpiredPrincipalIds(now, expired);
    this.revokePrincipals(
      [...expired],
      SESSION_EXPIRED_CLOSE_CODE,
      SESSION_EXPIRED_CLOSE_REASON
    );
  }

  /** Stop host-owned timers during application/test teardown. */
  close(): void {
    clearInterval(this.authorizationExpiryTimer);
    this.inbox?.close();
    this.conversations?.closeAll();
  }

  /**
   * Send a frame to one specific socket (size-bounded).
   * @internal Host wiring (#1053).
   */
  sendMessage(ws: WSContext, msg: ServerMessage): void {
    sendTo(ws, msg);
  }
}

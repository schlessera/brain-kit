import { resolveAskUserFormLimits, type AskUserFormLimits } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { TurnClassifier } from "../classification/classify-turn.js";
import { ClientSet, sendTo, type WSContext } from "./clients.js";
import { TurnCoordinator } from "./turns.js";
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
import { spliceLocalExchanges, stripLocalContext } from "./local-exchanges.js";

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
  askUserFormLimits?: Partial<AskUserFormLimits>;
  /** Backend registry resolving profiles/sessions to agent backends. */
  registry: BackendRegistry;
  /** Session persistence seam (SQLite catalog in production). */
  catalog: SessionCatalog;
  /**
   * The classification pass over finished turns (D42). Absent means no pass:
   * answers render as markdown, which is also what every failure of the pass
   * means.
   */
  classifier?: TurnClassifier | null;
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
   */
  activity?: ActivityRuntime;
  /** The concrete durable stream; absent on hosts without durable inbox support. */
  inbox?: InboxStream;
  /**
   * The user's remembered "always allow" tool grants. Optional: a host
   * without one never auto-answers and never persists an `always` approval —
   * every card stays per-use (what existing tests expect).
   */
  toolPermissions?: ToolPermissions;
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
 */
export class WsHost {
  readonly askUserFormLimits: AskUserFormLimits;
  readonly coordinator = new TurnCoordinator();
  readonly clients: ClientSet;
  readonly registry: BackendRegistry;
  catalog: SessionCatalog;
  appName: string;
  turnTimeoutMs: number;
  maxConcurrentSessions: () => number;
  readonly observability: Observability;
  readonly wsRate: { ratePerSecond: number; burst: number } | null;
  readonly isPrincipalValid: (principal: Principal) => boolean;
  readonly activity: ActivityRuntime | null;
  readonly inbox: InboxStream | null;
  readonly toolPermissions: ToolPermissions | null;
  readonly classifier: TurnClassifier | null;
  readonly scratchPrune?: () => Promise<void>;
  /** Scoped instruments, resolved once — `[ws]` is the existing log prefix. */
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
    this.toolPermissions = options.toolPermissions ?? null;
    this.classifier = options.classifier ?? null;
    if (options.scratchPrune) this.scratchPrune = options.scratchPrune;
    this.log = this.observability.logger("ws");
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
    this.authorizationExpiryTimer = setInterval(
      () => this.expireAuthorizationContexts(),
      AUTHORIZATION_EXPIRY_SWEEP_MS
    );
    this.authorizationExpiryTimer.unref?.();
  }

  /** A metering bucket for one new connection, or null when metering is off. */
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
   */
  reportDroppedFrame(reason: string, detail?: string): void {
    this.framesDropped.add(1, { reason, direction: "inbound" });
    this.log.emit({
      severityText: "WARN",
      body: "inbound frame rejected",
      attributes: detail ? { reason, detail } : { reason },
    });
  }

  /** Record a socket refused because this process has reached its connection cap. */
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

  /** A turn began executing: counted, and logged with its correlation ids. */
  reportTurnStarted(turn: TurnLogContext): void {
    this.turnsStarted.add(1);
    this.log.emit({
      severityText: "INFO",
      body: "turn started",
      attributes: turnLogAttributes(turn),
    });
  }

  /** Replayed history with its classified blocks joined on (D42); unchanged without a classifier. */
  attachMessageBlocks(sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[] {
    return this.classifier ? this.classifier.attach(sessionId, messages) : messages;
  }

  /**
   * Replayed history as the host sends it: the context blocks of locally
   * answered commands stripped from the prompts that carried them, each user
   * message's recorded source joined on, with or without a classifier, then
   * its classified blocks, and last the local exchanges put back in place
   * (#582). The exchanges go in last so the source join still counts only
   * the messages the backend replayed. A session without exchanges replays
   * exactly as it did before they existed.
   */
  prepareHistory(sessionId: string, messages: SessionHistoryMessage[]): SessionHistoryMessage[] {
    const exchanges = this.catalog.loadLocalExchanges?.(sessionId) ?? [];
    const { messages: stripped, carriers } = stripLocalContext(messages, exchanges);
    const withSources = this.catalog.attachMessageSources?.(sessionId, stripped) ?? stripped;
    const joined = spliceLocalExchanges(this.attachMessageBlocks(sessionId, withSources), exchanges, carriers);
    return this.catalog.attachRetryRequest?.(sessionId, joined) ?? joined;
  }

  /** A turn's backend call resolved: counted, and logged with its duration. */
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
   */
  reportAbnormalClose(code: number): void {
    this.wsErrors.add(1, { "close.code": code });
    this.log.emit({
      severityText: "WARN",
      body: "websocket closed abnormally",
      attributes: { "close.code": code },
    });
  }

  /** Fan a frame out to every attached client (size-bounded per frame). */
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
   * Apply principal-store revocation to every in-memory authority boundary.
   * Running turns are marked but deliberately not aborted.
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

  /** Route expiry through the same full boundary as explicit revocation. */
  expireAuthorizationContexts(now = Date.now()): void {
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
  }

  /** Send a frame to one specific socket (size-bounded). */
  sendMessage(ws: WSContext, msg: ServerMessage): void {
    sendTo(ws, msg);
  }
}

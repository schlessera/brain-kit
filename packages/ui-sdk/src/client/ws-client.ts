/**
 * `BrainUiClient` — the client half of the wire protocol, in the package that
 * owns the protocol (F3 / W2).
 *
 * It lived in `@schlessera/brain-ui-react` before this, which meant any
 * non-React consumer — a CLI, a mobile shell, an integration test that wants
 * to drive a real socket — reimplemented reconnection, framing and dispatch
 * from scratch and got no help from the SDK that defines the messages. The
 * socket lifecycle here is that implementation, moved: same 1s-doubling
 * backoff capped at 30s, same `reconnectNow` for when the network
 * demonstrably returns.
 *
 * What is new is everything the cast used to skip:
 *
 * - every inbound frame goes through `parseServerMessage`. A frame that fails
 *   is DROPPED and reported, never thrown — the protocol is additive, so a
 *   client that hard-fails an unrecognised frame turns every additive server
 *   change into a breaking one.
 * - `server_hello` is captured, so `protocolRev` and the capability flags are
 *   readable instead of advisory. This is the first client to read it.
 * - the current turn's `turnId` is remembered and stamped onto outbound
 *   turn-scoped frames, so the host's echo verification finally has something
 *   to verify.
 *
 * No React, no zustand, no DOM beyond `WebSocket` itself — which the browser,
 * Bun and Node 22+ all provide. State belongs to the consumer; this owns the
 * socket.
 */
import { ASK_RECEIPTS_CAPABILITY, FOLLOW_UP_QUEUE_CAPABILITY, LIVENESS_CAPABILITY, PROTOCOL_REV } from "../protocol.js";
import type { ClientMessage, ServerMessage } from "../protocol.js";
import { parseServerMessage } from "../schemas.js";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** Backoff schedule: 1s doubling to a 30s ceiling. */
const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;

/**
 * Liveness B (#910): while in the foreground, probe after 15 s without any
 * valid frame from the host, and replace the connection when no correlated
 * `pong` arrives within 5 s. These are targets: a frozen page runs no timers,
 * which is why `checkLiveness()` exists for the moment it thaws.
 */
export const LIVENESS_IDLE_MS = 15_000;
export const LIVENESS_RESPONSE_MS = 5_000;
/**
 * How long a connection attempt may stay CONNECTING. A handshake sent into a
 * dead path neither opens nor fails, and without this bound the client would
 * wait on it forever: no probe runs on a socket that never opened, and
 * `reconnectNow()` does nothing while one is connecting.
 */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Close code for a socket this client abandoned as half-open. */
export const STALE_SOCKET_CLOSE_CODE = 4000;

/** What the liveness checker did, for a consumer that measures it. */
export type LivenessEvent =
  | { type: "probe"; probeId: string; reason: "idle" | "check" }
  | { type: "pong"; probeId: string; latencyMs: number }
  | { type: "stale"; probeId: string };

/**
 * Whether this connection's host announced itself. `absent` means a frame
 * other than `server_hello` arrived first: a host that predates the
 * handshake, which cannot have receipt support either.
 */
export type HelloState = "pending" | "received" | "absent";

/**
 * One optional handler per frame type.
 *
 * Optional individually so a consumer implements only what it renders, and an
 * unhandled frame is a no-op rather than an error — the same additive posture
 * the parser takes.
 */
export type ServerFrameHandlers = {
  [K in ServerMessage["type"]]?: (frame: Extract<ServerMessage, { type: K }>) => void;
} & {
  /** Called for every valid frame, before the per-type handler. */
  onAny?: (frame: ServerMessage) => void;
};

/** Why a frame was discarded. A bounded token, never the payload. */
export interface ProtocolError {
  reason: "parse_error" | "unhandled";
  /** The parser's own message. Bounded; never the frame body. */
  detail: string;
  /** Frame type when it was recoverable, absent when the frame did not parse. */
  frameType?: string;
}

/** What the platform reported when one WebSocket connection attempt closed. */
export interface WebSocketClose {
  /** RFC 6455 close code, or the browser's synthetic 1006 for an abnormal close. */
  code: number;
  /** Server-provided close reason; empty when the handshake never upgraded. */
  reason: string;
  /** Whether this connection attempt reached `open` before it closed. */
  opened: boolean;
}

export interface BrainUiClientOptions {
  url: string;
  handlers?: ServerFrameHandlers;
  onStatusChange?: (status: ConnectionStatus) => void;
  /**
   * Called when a frame is dropped. This is the seam observability hangs on:
   * a browser console nobody is attached to is not a report, so a consumer
   * routes this wherever its reports go.
   */
  onProtocolError?: (error: ProtocolError) => void;
  /** Called for every socket close, before the disconnected status is reported. */
  onClose?: (close: WebSocketClose) => void;
  /** Called once per connection, when the server's hello arrives. */
  onHello?: (hello: { protocolRev: number; capabilities: Record<string, boolean>; principalKey?: string }) => void;
  /** Injected for tests; defaults to the platform WebSocket. */
  socketFactory?: (url: string) => WebSocket;
  /** Liveness timings; defaults to {@link LIVENESS_IDLE_MS}/{@link LIVENESS_RESPONSE_MS}. */
  liveness?: { idleMs?: number; responseMs?: number; connectMs?: number };
  /** Called for each probe, pong and stale verdict. */
  onLiveness?: (event: LivenessEvent) => void;
}

/**
 * Interactive request frames, and the field that correlates a reply to them.
 *
 * The turn id is remembered PER REQUEST, not per connection. Tracking only the
 * most recent turn looks right with one session and is wrong the moment two
 * run in parallel: a delta from session B arrives between session A's approval
 * request and the user answering it, the reply carries B's turn id, the host's
 * echo check fails, and A's turn waits for an approval that will never be
 * accepted. That failure is invisible until the ten-minute timeout.
 */
const REQUEST_KEYS: Readonly<Record<string, "toolUseId" | "requestId">> = {
  tool_approval_request: "toolUseId",
  ask_user_request: "requestId",
  ask_user_list_request: "requestId",
  ask_user_rank_request: "requestId",
  ask_user_form_request: "requestId",
  location_request: "requestId",
  mask_request: "requestId",
};

/** Reply frames, and the field naming the request they answer. */
const REPLY_KEYS: Readonly<Record<string, "toolUseId" | "requestId">> = {
  tool_approval: "toolUseId",
  tool_denial: "toolUseId",
  ask_user_response: "requestId",
  ask_user_list_response: "requestId",
  ask_user_rank_response: "requestId",
  ask_user_form_response: "requestId",
  ask_user_cancel: "requestId",
  location_response: "requestId",
  location_error: "requestId",
  mask_response: "requestId",
  mask_error: "requestId",
};

/**
 * Cap on remembered requests. A turn that raises thousands of approvals
 * without answering them must not grow this without bound; the oldest are
 * dropped, which costs an echo, not correctness.
 */
const MAX_TRACKED_REQUESTS = 256;

export class BrainUiClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** requestId/toolUseId → the turn id of the request that raised it. */
  private readonly turnByRequest = new Map<string, string>();
  /** When the current socket last delivered a valid frame. */
  private lastInboundAt = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private probe: { id: string; sentAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private probeCounter = 0;
  /** Sockets abandoned by `replace`; their late callbacks are ignored. */
  private readonly retired = new WeakSet<WebSocket>();
  private foreground = true;

  /** Whether the current connection's host sent `server_hello` first. */
  hello: HelloState = "pending";

  /** Protocol revision the server announced, or null before its hello. */
  protocolRev: number | null = null;
  /** Coarse capability flags from `server_hello`; empty before it arrives. */
  capabilities: Record<string, boolean> = {};
  /** The connection's opaque principal key (rev 5), or null before/without it. */
  principalKey: string | null = null;

  constructor(private readonly options: BrainUiClientOptions) {}

  get isConnected(): boolean {
    return this.ws?.readyState === 1;
  }

  /**
   * True once this connection's host said it takes ask answers with
   * receipts. False before its hello and for a host that never sends one.
   */
  get supportsAskReceipts(): boolean {
    return this.hello === "received" && this.capabilities[ASK_RECEIPTS_CAPABILITY] === true;
  }

  connect(): void {
    this.closed = false;
    this.options.onStatusChange?.("connecting");

    try {
      const ws = this.options.socketFactory
        ? this.options.socketFactory(this.options.url)
        : new WebSocket(this.options.url);
      this.ws = ws;
      this.hello = "pending";
      let opened = false;
      // A socket replaced as half-open can still deliver a late message or
      // close; it must not reset the replacement's hello, timers or turn map.
      const current = () => !this.retired.has(ws);
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (current() && this.ws === ws && ws.readyState === 0) this.abandon(ws, "Connection attempt timed out", false);
      }, this.options.liveness?.connectMs ?? CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (!current()) return;
        if (this.connectTimer) clearTimeout(this.connectTimer);
        // A host speaks first (its hello, or any frame from one too old to
        // send it). An open socket that delivers nothing at all within the
        // same bound is as dead as one that never opened.
        this.connectTimer = setTimeout(() => {
          this.connectTimer = null;
          // Through the backoff, like an attempt that never opened: a host
          // that accepts sockets and says nothing must not be retried at a
          // fixed ten-second rate forever.
          if (current() && this.ws === ws && this.hello === "pending") this.abandon(ws, "No frame after open", true, true);
        }, this.options.liveness?.connectMs ?? CONNECT_TIMEOUT_MS);
        opened = true;
        // The backoff resets on the first valid frame (see receive), not
        // here: an open that delivers nothing is not a recovered connection.
        this.lastInboundAt = Date.now();
        // Declare what we speak before anything else. A host uses this to
        // decide which revision's rules apply to this connection; a host that
        // does not understand the frame ignores it, since unknown frame types
        // are not errors in either direction.
        try {
          ws.send(
            JSON.stringify({
              type: "client_hello",
              protocolRev: PROTOCOL_REV,
              capabilities: { [ASK_RECEIPTS_CAPABILITY]: true, [FOLLOW_UP_QUEUE_CAPABILITY]: true },
            })
          );
        } catch {
          // A socket that cannot take the hello will surface via onclose.
        }
        this.options.onStatusChange?.("connected");
        this.scheduleIdleCheck();
      };
      ws.onmessage = (evt: MessageEvent) => {
        if (current()) this.receive(evt.data);
      };
      ws.onclose = (event) => {
        if (!current()) return;
        if (this.connectTimer && this.ws === ws) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        this.stopLiveness();
        this.hello = "pending";
        // A new connection re-negotiates: the old hello does not describe it.
        this.protocolRev = null;
        this.capabilities = {};
        this.principalKey = null;
        // Pending exchanges do not survive a reconnect; the host drains them.
        this.turnByRequest.clear();
        this.options.onClose?.({ code: event.code, reason: event.reason, opened });
        this.options.onStatusChange?.("disconnected");
        if (!this.closed) this.scheduleReconnect();
      };
      ws.onerror = () => {
        // onclose always follows; reconnecting here too would double-schedule.
      };
    } catch {
      this.options.onStatusChange?.("disconnected");
      if (!this.closed) this.scheduleReconnect();
    }
  }

  /** Validate one inbound frame and dispatch it, or drop and report it. */
  private receive(raw: unknown): void {
    const parsed = parseServerMessage(raw as string);
    if (!parsed.ok) {
      this.options.onProtocolError?.({ reason: "parse_error", detail: parsed.error });
      return;
    }
    const frame = parsed.message;
    // Any valid frame proves the path is open; the idle clock restarts.
    this.lastInboundAt = Date.now();
    this.scheduleIdleCheck();

    if (frame.type === "pong") {
      // Liveness is this client's own business, never the consumer's.
      if (this.probe && this.probe.id === frame.probeId) {
        clearTimeout(this.probe.timer);
        this.options.onLiveness?.({ type: "pong", probeId: frame.probeId, latencyMs: Date.now() - this.probe.sentAt });
        this.probe = null;
      }
      return;
    }

    if (this.hello === "pending") {
      this.reconnectAttempt = 0;
      this.hello = frame.type === "server_hello" ? "received" : "absent";
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    if (frame.type === "server_hello") {
      this.protocolRev = frame.protocolRev;
      this.capabilities = frame.capabilities ?? {};
      this.principalKey = frame.principalKey ?? null;
      this.options.onHello?.({
        protocolRev: this.protocolRev,
        capabilities: this.capabilities,
        ...(frame.principalKey ? { principalKey: frame.principalKey } : {}),
      });
    }

    // Remember which turn raised this request, so its reply echoes THAT turn.
    const requestKey = REQUEST_KEYS[frame.type];
    const turnId = (frame as { turnId?: string }).turnId;
    if (requestKey && typeof turnId === "string" && turnId) {
      const id = (frame as unknown as Record<string, unknown>)[requestKey];
      if (typeof id === "string" && id) {
        if (this.turnByRequest.size >= MAX_TRACKED_REQUESTS) {
          const oldest = this.turnByRequest.keys().next().value;
          if (oldest !== undefined) this.turnByRequest.delete(oldest);
        }
        this.turnByRequest.set(id, turnId);
      }
    }

    const handlers = this.options.handlers;
    const handler = handlers?.[frame.type] as ((f: ServerMessage) => void) | undefined;

    // `onAny` counts as handling. A consumer whose dispatch shares a preamble
    // across every frame type — resolving which session buffer a frame belongs
    // to, say — registers one handler rather than sixteen copies of it, and
    // must not be told its frames went nowhere.
    if (handlers?.onAny) handlers.onAny(frame);
    if (handler) handler(frame);
    if (handlers?.onAny || handler) return;

    // Neither: a consumer implements what it renders, so this is not an
    // error — but it is reported, so "ignored on purpose" and "we never
    // noticed" are distinguishable.
    this.options.onProtocolError?.({
      reason: "unhandled",
      detail: "no handler registered",
      frameType: frame.type,
    });
  }

  /**
   * Send a frame. Returns false when there is no open socket.
   *
   * The boolean matters: `send` on a closed socket drops silently, and a
   * caller that just staged an upload needs to know it did not go out.
   */
  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify(this.withTurnId(msg)));
    return true;
  }

  /** Stamp the turn id of the request this frame replies to, if known. */
  private withTurnId(msg: ClientMessage): ClientMessage {
    if ("turnId" in msg && msg.turnId) return msg; // an explicit id wins
    const replyKey = REPLY_KEYS[msg.type];
    if (!replyKey) return msg;
    const id = (msg as unknown as Record<string, unknown>)[replyKey];
    if (typeof id !== "string" || !id) return msg;
    const turnId = this.turnByRequest.get(id);
    if (!turnId) return msg;
    // The exchange is over; nothing else will reply to this request.
    this.turnByRequest.delete(id);
    return { ...msg, turnId } as ClientMessage;
  }

  close(): void {
    this.closed = true;
    this.stopLiveness();
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Skip the remaining backoff and reconnect now — for an `online` event or a
   * tab becoming visible again. No-op while open, connecting, or deliberately
   * closed: an OPEN socket may still be half-open, which only
   * `checkLiveness()` can tell.
   */
  reconnectNow(): void {
    if (this.closed) return;
    const state = this.ws?.readyState;
    if (state === 0 || state === 1) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.connect();
  }

  /**
   * Tell the client whether the page is in the foreground. Periodic probes
   * run only while it is; returning to it checks at once, because a page
   * that was hidden or frozen may be holding a socket that died meanwhile.
   */
  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    if (!foreground) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      return;
    }
    this.checkLiveness();
  }

  /**
   * Prove the connection now: reconnect if there is none, otherwise probe
   * the host and replace the socket if it does not answer in time. For a
   * return to the page, a resume, going online, or a reply that is overdue.
   * A host that does not advertise `liveness` is not probed.
   */
  checkLiveness(): void {
    if (this.closed) return;
    const state = this.ws?.readyState;
    if (state !== 0 && state !== 1) {
      this.reconnectNow();
      return;
    }
    if (state === 1) this.sendProbe("check");
  }

  private sendProbe(reason: "idle" | "check"): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || this.probe) return;
    if (this.capabilities[LIVENESS_CAPABILITY] !== true) return;
    const id = `probe-${Date.now().toString(36)}-${++this.probeCounter}`;
    try {
      ws.send(JSON.stringify({ type: "ping", probeId: id }));
    } catch {
      // A socket that cannot take the probe is as good as gone.
    }
    const responseMs = this.options.liveness?.responseMs ?? LIVENESS_RESPONSE_MS;
    this.probe = {
      id,
      sentAt: Date.now(),
      timer: setTimeout(() => {
        if (this.probe?.id !== id || this.ws !== ws) return;
        this.probe = null;
        this.options.onLiveness?.({ type: "stale", probeId: id });
        this.replace(ws);
      }, responseMs),
    };
    this.options.onLiveness?.({ type: "probe", probeId: id, reason });
  }

  /** Abandon a half-open socket and connect a new one at once. */
  private replace(stale: WebSocket): void {
    this.abandon(stale, "No reply to liveness probe", true);
  }

  /**
   * Retire a socket whose callbacks can no longer be trusted, report it as
   * closed, and connect again: at once after a failed probe, through the
   * normal backoff after a handshake that never completed.
   */
  private abandon(stale: WebSocket, reason: string, opened: boolean, backoff = !opened): void {
    if (this.ws !== stale) return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    this.stopLiveness();
    this.retired.add(stale);
    this.ws = null;
    this.protocolRev = null;
    this.capabilities = {};
    this.principalKey = null;
    this.hello = "pending";
    this.turnByRequest.clear();
    try {
      stale.close(STALE_SOCKET_CLOSE_CODE, reason);
    } catch {
      // Already closing; its callbacks are ignored either way.
    }
    this.options.onClose?.({ code: STALE_SOCKET_CLOSE_CODE, reason, opened });
    this.options.onStatusChange?.("disconnected");
    if (this.closed) return;
    if (backoff) {
      this.scheduleReconnect();
      return;
    }
    // A replacement that itself fails goes through the normal backoff, so a
    // dead network costs one immediate attempt, not a storm.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connect();
  }

  private scheduleIdleCheck(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.foreground || this.closed || this.ws?.readyState !== 1) return;
    const idleMs = this.options.liveness?.idleMs ?? LIVENESS_IDLE_MS;
    const wait = Math.max(0, this.lastInboundAt + idleMs - Date.now());
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.foreground) return;
      if (Date.now() - this.lastInboundAt >= idleMs) this.sendProbe("idle");
      else this.scheduleIdleCheck();
    }, wait);
  }

  private stopLiveness(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.probe) clearTimeout(this.probe.timer);
    this.probe = null;
  }

  private scheduleReconnect(): void {
    const delay = Math.min(BASE_RECONNECT_MS * 2 ** this.reconnectAttempt, MAX_RECONNECT_MS);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export function createBrainUiClient(options: BrainUiClientOptions): BrainUiClient {
  return new BrainUiClient(options);
}

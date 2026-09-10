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
import { PROTOCOL_REV } from "../protocol.js";
import type { ClientMessage, ServerMessage } from "../protocol.js";
import { parseServerMessage } from "../schemas.js";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** Backoff schedule: 1s doubling to a 30s ceiling. */
const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30_000;

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
  onHello?: (hello: { protocolRev: number; capabilities: Record<string, boolean> }) => void;
  /** Injected for tests; defaults to the platform WebSocket. */
  socketFactory?: (url: string) => WebSocket;
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
  location_request: "requestId",
  mask_request: "requestId",
};

/** Reply frames, and the field naming the request they answer. */
const REPLY_KEYS: Readonly<Record<string, "toolUseId" | "requestId">> = {
  tool_approval: "toolUseId",
  tool_denial: "toolUseId",
  ask_user_response: "requestId",
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

  /** Protocol revision the server announced, or null before its hello. */
  protocolRev: number | null = null;
  /** Coarse capability flags from `server_hello`; empty before it arrives. */
  capabilities: Record<string, boolean> = {};

  constructor(private readonly options: BrainUiClientOptions) {}

  get isConnected(): boolean {
    return this.ws?.readyState === 1;
  }

  connect(): void {
    this.closed = false;
    this.options.onStatusChange?.("connecting");

    try {
      const ws = this.options.socketFactory
        ? this.options.socketFactory(this.options.url)
        : new WebSocket(this.options.url);
      this.ws = ws;
      let opened = false;

      ws.onopen = () => {
        opened = true;
        this.reconnectAttempt = 0;
        // Declare what we speak before anything else. A host uses this to
        // decide which revision's rules apply to this connection; a host that
        // does not understand the frame ignores it, since unknown frame types
        // are not errors in either direction.
        try {
          ws.send(JSON.stringify({ type: "client_hello", protocolRev: PROTOCOL_REV }));
        } catch {
          // A socket that cannot take the hello will surface via onclose.
        }
        this.options.onStatusChange?.("connected");
      };
      ws.onmessage = (evt: MessageEvent) => this.receive(evt.data);
      ws.onclose = (event) => {
        // A new connection re-negotiates: the old hello does not describe it.
        this.protocolRev = null;
        this.capabilities = {};
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

    if (frame.type === "server_hello") {
      this.protocolRev = frame.protocolRev;
      this.capabilities = frame.capabilities ?? {};
      this.options.onHello?.({ protocolRev: this.protocolRev, capabilities: this.capabilities });
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
   * closed.
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

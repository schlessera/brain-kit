import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { ClientSet, sendTo, type WSContext } from "./clients.js";
import { TurnCoordinator } from "./turns.js";
import type { SessionCatalog } from "./session-catalog.js";
import type { BackendRegistry } from "../agent/backend.js";
import { createSilentObservability, type Observability } from "../observability/index.js";

/** Host-side turn timeout. The backend no longer times out — the host owns it. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Default cap on concurrently RUNNING sessions (MAX_CONCURRENT_SESSIONS). */
const DEFAULT_MAX_CONCURRENT_SESSIONS = 3;

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
  /** Backend registry resolving profiles/sessions to agent backends. */
  registry: BackendRegistry;
  /** Session persistence seam (SQLite catalog in production). */
  catalog: SessionCatalog;
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
}

/**
 * Everything one WebSocket coordinator instance owns: turn state, the session
 * catalog, the backend registry, the attached client sockets, branding copy,
 * and the frame senders. Handlers receive this host explicitly — there is no
 * module-level default host, so two apps coexist without sharing state.
 */
export class WsHost {
  readonly coordinator = new TurnCoordinator();
  readonly clients = new ClientSet();
  readonly registry: BackendRegistry;
  catalog: SessionCatalog;
  appName: string;
  turnTimeoutMs: number;
  maxConcurrentSessions: () => number;
  readonly observability: Observability;
  /** Scoped instruments, resolved once — `[ws]` is the existing log prefix. */
  readonly log: ReturnType<Observability["logger"]>;
  private readonly framesDropped: ReturnType<
    ReturnType<Observability["meter"]>["createCounter"]
  >;

  constructor(options: WsHostOptions) {
    this.registry = options.registry;
    this.catalog = options.catalog;
    this.appName = options.appName ?? "Brain UI";
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxConcurrentSessions =
      options.maxConcurrentSessions ?? (() => DEFAULT_MAX_CONCURRENT_SESSIONS);
    this.observability = options.observability ?? createSilentObservability();
    this.log = this.observability.logger("ws");
    this.framesDropped = this.observability
      .meter("ws")
      .createCounter("ws.frames.dropped", {
        description: "Inbound frames refused before reaching a handler",
      });
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

  /** Fan a frame out to every attached client (size-bounded per frame). */
  sendToClients(msg: ServerMessage): void {
    this.clients.broadcast(msg);
  }

  /** Send a frame to one specific socket (size-bounded). */
  sendMessage(ws: WSContext, msg: ServerMessage): void {
    sendTo(ws, msg);
  }
}

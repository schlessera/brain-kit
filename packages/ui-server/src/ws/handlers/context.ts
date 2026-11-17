import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { WSContext } from "../clients.js";
import type { AuthorizationContext } from "../turns.js";
import type { WsHost } from "../host.js";

/** Per-connection negotiation state, owned by the socket handler. */
export interface ConnectionState {
  /**
   * The transport is gone. Set by onClose, and separate from `authorization`
   * because a disconnect is not a revocation: work already underway keeps its
   * authority, but nothing may register new per-connection state afterwards.
   */
  closed?: boolean;
  /** Principal resolved once at the WebSocket upgrade boundary. */
  principal: import("../../db/principals.js").Principal;
  /** Mutable in-memory decision invalidated synchronously by revocation. */
  authorization: AuthorizationContext;
  /** Revision the client declared via `client_hello`; absent means rev 2. */
  protocolRev?: number;
  /** Opt-in flags the client declared via `client_hello`. */
  capabilities?: Readonly<Record<string, boolean>>;
}

/**
 * Everything a client message handler may use, passed explicitly instead of
 * captured from one shared closure. Built once per dispatched frame, after
 * the authorization check.
 */
export interface HandlerContext {
  readonly host: WsHost;
  /** The socket the frame arrived on; replies go here. */
  readonly ws: WSContext;
  readonly connection: ConnectionState;
  /**
   * The connection declared a protocol revision that promises to echo turn
   * ids, so a reply without one cannot be correlated (see `turnIdMatches`).
   * Read at dispatch: a `client_hello` changes it for later frames only.
   */
  readonly requireEcho: boolean;
}

export type ClientMessageType = ClientMessage["type"];

/** The client message whose `type` is `K`. */
export type ClientMessageOf<K extends ClientMessageType> = Extract<ClientMessage, { type: K }>;

/** Handles one or more client message kinds; a shared handler takes their union. */
export type ClientMessageHandler<K extends ClientMessageType> = (
  ctx: HandlerContext,
  msg: ClientMessageOf<K>
) => void | Promise<void>;

/**
 * One handler per client message kind. Mapped over every `type` in
 * `ClientMessage`, so a kind without an entry fails typecheck. The function
 * type is spelled out rather than reusing `ClientMessageHandler<K>`: through
 * the alias TypeScript compares `K` invariantly, which would refuse one
 * handler shared by several kinds.
 */
export type ClientMessageHandlers = {
  readonly [K in ClientMessageType]: (ctx: HandlerContext, msg: ClientMessageOf<K>) => void | Promise<void>;
};

/**
 * Does this reply's echoed turnId identify the turn that raised the request?
 *
 * A wrong id is always refused: a stale echo from before a reconnect or a
 * follow-up would resolve a different turn's pending promise.
 *
 * A MISSING id depends on who is speaking. A client that declared rev 3
 * promised to echo, so silence means the reply cannot be correlated and is
 * refused. A client that declared nothing is rev 2, where the field is
 * optional, and is still tolerated — that tolerance is the deprecation window,
 * and it is what lets this be enforced at all without breaking clients that
 * predate `client_hello`.
 */
export function turnIdMatches(
  pending: { turnId: string },
  echoed: string | undefined,
  requireEcho: boolean
): boolean {
  if (echoed === undefined) return !requireEcho;
  return echoed === pending.turnId;
}

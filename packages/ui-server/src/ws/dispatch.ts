import { PROTOCOL_REV_CLIENT_ECHO } from "@schlessera/brain-ui-sdk/protocol";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { WSContext } from "./clients.js";
import type { WsHost } from "./host.js";
import type { ClientMessageHandler, ClientMessageType, ConnectionState, HandlerContext } from "./handlers/context.js";
import { CLIENT_MESSAGE_HANDLERS } from "./handlers/index.js";

export type { ConnectionState } from "./handlers/context.js";
export { turnIdMatches } from "./handlers/context.js";

/**
 * Route one validated client frame to its handler in
 * `CLIENT_MESSAGE_HANDLERS` (one module per message family under
 * `./handlers/`).
 */
export async function handleClientMessage(
  host: WsHost,
  ws: WSContext,
  msg: ClientMessage,
  connection: ConnectionState
): Promise<void> {
  // The socket callback schedules dispatch on a microtask. Revocation may land
  // after parsing but before this function begins, so repeat the in-memory
  // check at the actual dispatch boundary.
  if (
    connection.authorization.valid &&
    connection.authorization.expiresAt <= Date.now()
  ) {
    host.expireAuthorizationContexts();
  }
  if (!connection.authorization.valid) {
    host.reportDroppedFrame("revoked_principal");
    return;
  }
  // Own keys only: a frame typed "constructor" must not reach Object.prototype.
  if (!Object.hasOwn(CLIENT_MESSAGE_HANDLERS, msg.type)) return;
  const handle = CLIENT_MESSAGE_HANDLERS[msg.type] as ClientMessageHandler<ClientMessageType>;
  const ctx: HandlerContext = {
    host,
    ws,
    connection,
    requireEcho: (connection.protocolRev ?? 2) >= PROTOCOL_REV_CLIENT_ECHO,
  };
  await handle(ctx, msg);
}

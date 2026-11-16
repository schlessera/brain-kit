import { BRAIN_MARKUP_CLOSED } from "@schlessera/brain-ui-sdk/server";
import { turnIdMatches, type ClientMessageHandler } from "./context.js";

/**
 * The browser closed the markup editor, or it could not run (#3975). Only the
 * turn's own principal may decline its request; the layer itself never
 * travels on the socket, it is uploaded to the markup route.
 */
export const handleMarkupError: ClientMessageHandler<"markup_error"> = ({ host, connection, requireEcho }, msg) => {
  host.coordinator
    .claimMarkup(msg.requestId, (p) => p.principalId === connection.principal.id && turnIdMatches(p, msg.turnId, requireEcho))
    ?.reject(new Error(msg.code === "cancelled" ? BRAIN_MARKUP_CLOSED : msg.message || "The markup editor failed"));
};

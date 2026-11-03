import { locationErrorText } from "../frames.js";
import { turnIdMatches, type ClientMessageHandler } from "./context.js";

export const handleLocationResponse: ClientMessageHandler<"location_response"> = ({ host, requireEcho }, msg) => {
  host.coordinator
    .claimLocation(msg.requestId, (p) => turnIdMatches(p, msg.turnId, requireEcho))
    ?.resolve({ coords: msg.coords, timestamp: msg.timestamp });
};

export const handleLocationError: ClientMessageHandler<"location_error"> = ({ host, requireEcho }, msg) => {
  host.coordinator
    .claimLocation(msg.requestId, (p) => turnIdMatches(p, msg.turnId, requireEcho))
    ?.reject(new Error(locationErrorText(msg.code, msg.message)));
};

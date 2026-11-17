import { turnIdMatches, type ClientMessageHandler } from "./context.js";

export const handleMaskResponse: ClientMessageHandler<"mask_response"> = ({ host, requireEcho }, msg) => {
  // Decoded here rather than in the tool: the boundary already validated
  // the base64 and its size, so the backend gets bytes it can trust.
  host.coordinator
    .claimMask(msg.requestId, (p) => turnIdMatches(p, msg.turnId, requireEcho))
    ?.resolve(Uint8Array.from(Buffer.from(msg.maskPng, "base64")));
};

export const handleMaskError: ClientMessageHandler<"mask_error"> = ({ host, requireEcho }, msg) => {
  host.coordinator
    .claimMask(msg.requestId, (p) => turnIdMatches(p, msg.turnId, requireEcho))
    ?.reject(
      new Error(
        msg.code === "cancelled"
          ? `The user did not mark an area${msg.message ? `: ${msg.message}` : ""}`
          : msg.message || "The mask editor failed"
      )
    );
};

import type { ClientMessage, ServerLocationRequest } from "@schlessera/brain-ui-sdk/protocol";

/**
 * The server asked the browser for its location (the agent called
 * `get_current_location`). Read `navigator.geolocation` and reply over the same
 * requestId. The browser shows its own permission prompt on first use; a denial,
 * timeout, or unavailable position comes back as a `location_error` that the
 * server turns into a tool error for the agent.
 *
 * `reply` is pinned to the socket that asked: an answer arriving after that
 * socket closed is dropped, never sent on its replacement.
 */
export function answerLocationRequest(msg: ServerLocationRequest, reply: (message: ClientMessage) => void): void {
  const { requestId } = msg;
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    reply({
      type: "location_error",
      requestId,
      code: 0,
      message: "Geolocation is not available in this browser.",
    });
    return;
  }
  const opts = msg.options ?? {};
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      reply({
        type: "location_response",
        requestId,
        coords: {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          altitude: pos.coords.altitude,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
        },
        timestamp: pos.timestamp,
      });
    },
    (err) => {
      reply({
        type: "location_error",
        requestId,
        code: err.code,
        message: err.message || "Failed to retrieve location.",
      });
    },
    {
      enableHighAccuracy: opts.enableHighAccuracy ?? false,
      timeout: opts.timeoutMs ?? 15000,
      maximumAge: opts.maximumAgeMs ?? 60000,
    }
  );
}

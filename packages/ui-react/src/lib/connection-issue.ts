import type { VpnStatus } from "../stores/connection-store.js";

// Three failed handshakes classify after the existing 1s + 2s backoffs: soon
// enough to diagnose a refusal, without flashing on one ordinary reconnect.
export const REFUSAL_ATTEMPTS = 3;

/** ws/connection.ts closes with this when ClientSet.add refuses the socket. */
export const CONNECTION_LIMIT_CLOSE_CODE = 4008;

export type ConnectionIssue =
  | "unauthorized"
  | "forbidden"
  | "unreachable"
  | "refused"
  | "capacity"
  | null;

/** Derive current connectivity copy from live facts; no conclusion is cached. */
export function deriveConnectionIssue({
  vpnStatus,
  handshakeFailures,
  lastCloseCode,
}: {
  vpnStatus: VpnStatus;
  handshakeFailures: number;
  lastCloseCode: number | null;
}): ConnectionIssue {
  if (vpnStatus === "unauthorized") return "unauthorized";
  if (vpnStatus === "forbidden") return "forbidden";
  if (vpnStatus === "unreachable") return "unreachable";
  if (vpnStatus !== "connected") return null;
  // The cap refusal is explicit, so it does not wait for the inferred
  // threshold: the server accepts the upgrade and closes with 4008, which
  // resets the never-opened counter that "refused" is inferred from.
  if (lastCloseCode === CONNECTION_LIMIT_CLOSE_CODE) return "capacity";
  return handshakeFailures >= REFUSAL_ATTEMPTS ? "refused" : null;
}

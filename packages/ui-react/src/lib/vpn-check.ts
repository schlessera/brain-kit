import type { BrainUiServices } from "../root.js";

/**
 * One answer of the reachability and account probe.
 *
 * `accountKey` is `undefined` when the response is not 2xx or its body is not
 * a readable JSON object, and otherwise the body's `accountKey` (`null` when
 * absent: an agent principal gets none). Callers validate the key themselves.
 */
interface VpnCheckReading {
  status: number;
  accountKey: unknown;
}

/** The probe's path; the root's request exempts exactly this path. */
export const VPN_CHECK_PATH = "/api/vpn-check";

/**
 * Ask `/api/vpn-check` through the root's request, which exempts exactly this
 * path from the signed-out abort and the 401 session expiry. A 401 or 403 is
 * an answer, not an error; a network failure or an abort still throws.
 */
export async function readVpnCheck(root: Pick<BrainUiServices, "request" | "backendUrl">, init?: RequestInit): Promise<VpnCheckReading> {
  const response = await root.request(root.backendUrl(VPN_CHECK_PATH), init);
  if (!response.ok) return { status: response.status, accountKey: undefined };
  const body = await response.json().catch(() => null) as { accountKey?: unknown } | null;
  if (typeof body !== "object" || body === null) return { status: response.status, accountKey: undefined };
  return { status: response.status, accountKey: body.accountKey ?? null };
}

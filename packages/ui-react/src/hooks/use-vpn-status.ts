import { defaultRoot } from "../default-root.js";
import { useBrainUiRoot } from "../root-context.js";
import type { BrainUiRoot } from "../root.js";
import { useEffect, useState } from "react";
import {
  type VpnStatus,
} from "../stores/connection-store.js";

const POLL_INTERVAL = 15_000;
// Tighter cadence while offline so recovery is near-immediate
const OFFLINE_POLL_INTERVAL = 3_000;
const TIMEOUT_MS = 5_000;

type VpnReading = { status: VpnStatus; accountKey?: string | null };

/** The host's account partition key (#1014): an opaque name, read defensively. */
async function readAccountKey(res: Response): Promise<string | null> {
  try {
    const body = await res.json() as { accountKey?: unknown } | null;
    const key = body?.accountKey;
    return typeof key === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

async function fetchVpnStatus(root: BrainUiRoot): Promise<VpnReading> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await root.request(root.backendUrl("/api/vpn-check"), {
      signal: controller.signal,
    });

    if (res.ok) return { status: "connected", accountKey: await readAccountKey(res) };
    if (res.status === 401) return { status: "unauthorized" };
    if (res.status === 403) return { status: "forbidden" };
    return { status: "unreachable" };
  } catch {
    return { status: "unreachable" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ask the mounted connectivity poller for a fresh reading. The poller remains
 * the only writer of vpnStatus and serializes this with its scheduled checks.
 */
export function recheckVpnStatus(): void {
  defaultRoot.recheckVpn?.();
}

export function useVpnStatus() {
  const root = useBrainUiRoot();
  const [successfulProbe, setSuccessfulProbe] = useState({ root, count: 0 });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let recheckRequested = false;
    let disposed = false;

    async function check() {
      if (disposed) return;
      if (inFlight) {
        recheckRequested = true;
        return;
      }
      inFlight = true;
      const epoch = root.authLock.epoch();
      const opensAtStart = root.stores.connection.getState().socketOpens;
      try {
        const { status, accountKey } = await fetchVpnStatus(root);
        // A socket that reached `open` while this probe was in flight is newer
        // reachability evidence than a failure the probe was started for.
        // Counting opens rather than sampling wsStatus twice also catches a
        // drop and a replacement open inside one probe, where both samples
        // read "connected".
        const socketOpenedDuringCheck =
          root.stores.connection.getState().socketOpens !== opensAtStart;
        if (!disposed && !(socketOpenedDuringCheck && status !== "connected")) {
          // A locked page is unlocked only by the explicit sign-in completion,
          // never by a background poll (including another tab signing in).
          if (epoch !== root.authLock.epoch() || root.authLock.state.getState().phase !== "active") return;
          if (status === "unauthorized") {
            await root.authLock.expire();
            if (disposed || root.authLock.state.getState().phase !== "active") return;
          }
          root.stores.connection.getState().setVpnStatus(status, accountKey);
          if (status === "connected") {
            setSuccessfulProbe((previous) => ({ root, count: previous.root === root ? previous.count + 1 : 1 }));
          }
        }
      } finally {
        inFlight = false;
        if (!disposed) {
          clearTimeout(timer);
          if (recheckRequested) {
            recheckRequested = false;
            void check();
          } else {
            const status = root.stores.connection.getState().vpnStatus;
            // Auth required but no valid session is still a reachable server.
            const reachable = status === "connected" || status === "unauthorized";
            timer = setTimeout(
              check,
              reachable ? POLL_INTERVAL : OFFLINE_POLL_INTERVAL
            );
          }
        }
      }
    }

    // Re-check immediately when the network returns or the PWA is foregrounded
    // instead of waiting out the poll interval.
    const recheckNow = () => void check();
    const removeRecheck = root.registerVpnRecheck(recheckNow);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("online", recheckNow);
    document.addEventListener("visibilitychange", onVisible);

    void check();

    return () => {
      disposed = true;
      clearTimeout(timer);
      removeRecheck();
      window.removeEventListener("online", recheckNow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [root]);

  return successfulProbe.root === root ? successfulProbe.count : 0;
}

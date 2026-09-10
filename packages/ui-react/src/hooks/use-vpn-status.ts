import { useEffect } from "react";
import {
  useConnectionStore,
  type VpnStatus,
} from "../stores/connection-store.js";
import { getBackendUrl } from "../lib/backend.js";

const POLL_INTERVAL = 15_000;
// Tighter cadence while offline so recovery is near-immediate
const OFFLINE_POLL_INTERVAL = 3_000;
const TIMEOUT_MS = 5_000;
let activeRecheck: (() => void) | null = null;

async function fetchVpnStatus(): Promise<VpnStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(getBackendUrl("/api/vpn-check"), {
      signal: controller.signal,
    });

    if (res.ok) return "connected";
    if (res.status === 401) return "unauthorized";
    if (res.status === 403) return "forbidden";
    return "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ask the mounted connectivity poller for a fresh reading. The poller remains
 * the only writer of vpnStatus and serializes this with its scheduled checks.
 */
export function recheckVpnStatus(): void {
  activeRecheck?.();
}

export function useVpnStatus() {
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
      const opensAtStart = useConnectionStore.getState().socketOpens;
      try {
        const status = await fetchVpnStatus();
        // A socket that reached `open` while this probe was in flight is newer
        // reachability evidence than a failure the probe was started for.
        // Counting opens rather than sampling wsStatus twice also catches a
        // drop and a replacement open inside one probe, where both samples
        // read "connected".
        const socketOpenedDuringCheck =
          useConnectionStore.getState().socketOpens !== opensAtStart;
        if (!disposed && !(socketOpenedDuringCheck && status !== "connected")) {
          useConnectionStore.getState().setVpnStatus(status);
        }
      } finally {
        inFlight = false;
        if (!disposed) {
          clearTimeout(timer);
          if (recheckRequested) {
            recheckRequested = false;
            void check();
          } else {
            const status = useConnectionStore.getState().vpnStatus;
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
    activeRecheck = recheckNow;
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("online", recheckNow);
    document.addEventListener("visibilitychange", onVisible);

    void check();

    return () => {
      disposed = true;
      clearTimeout(timer);
      if (activeRecheck === recheckNow) activeRecheck = null;
      window.removeEventListener("online", recheckNow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}

import { useEffect } from "react";
import { useConnectionStore } from "../stores/connection-store.js";
import { getBackendUrl } from "../lib/backend.js";

const POLL_INTERVAL = 15_000;
// Tighter cadence while offline so recovery is near-immediate
const OFFLINE_POLL_INTERVAL = 3_000;
const TIMEOUT_MS = 5_000;

export function useVpnStatus() {
  const setVpnStatus = useConnectionStore((s) => s.setVpnStatus);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let disposed = false;

    async function check() {
      if (inFlight || disposed) return;
      inFlight = true;
      let connected = false;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const res = await fetch(getBackendUrl("/api/vpn-check"), {
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          setVpnStatus("connected");
          connected = true;
        } else if (res.status === 401) {
          // Auth required (password / proxy mode) but no valid session yet.
          setVpnStatus("unauthorized");
          connected = true; // reachable — poll at the relaxed cadence
        } else if (res.status === 403) {
          setVpnStatus("forbidden");
        } else {
          setVpnStatus("unreachable");
        }
      } catch {
        setVpnStatus("unreachable");
      } finally {
        inFlight = false;
        if (!disposed) {
          clearTimeout(timer);
          timer = setTimeout(
            check,
            connected ? POLL_INTERVAL : OFFLINE_POLL_INTERVAL
          );
        }
      }
    }

    // Re-check immediately when the network returns or the PWA is foregrounded
    // instead of waiting out the poll interval.
    const recheckNow = () => void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("online", recheckNow);
    document.addEventListener("visibilitychange", onVisible);

    void check();

    return () => {
      disposed = true;
      clearTimeout(timer);
      window.removeEventListener("online", recheckNow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [setVpnStatus]);
}

import { useEffect, useRef } from "react";

import type { BrainApi } from "../lib/api-client.js";
import { createZoneRefresher, reportNotificationZone } from "../lib/push-registration.js";

export interface NotificationZoneSignals {
  /** Successful authenticated probes so far (boot, poll, foreground, online). */
  successfulProbeCount: number;
  /** True while the latest probe reached an authenticated server. */
  connected: boolean;
  /** Completed WebSocket opens; a later open is a reconnection. */
  socketOpens: number;
}

/**
 * Keep this client's reported IANA zone fresh for client-local Action notice
 * timing. Lifecycle events always report: the first authenticated probe,
 * reconnection (after an unreachable probe or a new socket) and foreground
 * return. Any other successful probe reports only a detected zone change.
 * The server stamps its own clock; nothing here sends a client time.
 */
export function useNotificationZoneRefresh(api: BrainApi, signals: NotificationZoneSignals): void {
  const current = useRef<{ refresher: ReturnType<typeof createZoneRefresher>; controller: AbortController } | null>(null);
  const latest = useRef(signals);
  latest.current = signals;

  useEffect(() => {
    const controller = new AbortController();
    const refresher = createZoneRefresher((signal) => reportNotificationZone(api, signal));
    current.current = { refresher, controller };
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        refresher.markLifecycle();
        // The connectivity poller also re-probes on foreground; reporting
        // here as well covers a server it already considers connected.
        if (latest.current.connected && latest.current.successfulProbeCount > 0) {
          void refresher.refresh(controller.signal);
        }
      }
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      current.current = null;
    };
  }, [api]);

  const { successfulProbeCount, connected, socketOpens } = signals;

  useEffect(() => {
    const entry = current.current;
    if (!entry) return;
    // An unreachable or unauthenticated reading makes the next success a
    // reconnection, which always reports.
    if (!connected) {
      entry.refresher.markLifecycle();
      return;
    }
    if (successfulProbeCount === 0) return;
    void entry.refresher.refresh(entry.controller.signal);
  }, [successfulProbeCount, connected]);

  const firstSocket = useRef(true);
  useEffect(() => {
    const entry = current.current;
    if (!entry || socketOpens === 0) return;
    if (firstSocket.current) {
      firstSocket.current = false;
      return;
    }
    entry.refresher.markLifecycle();
    if (latest.current.connected && latest.current.successfulProbeCount > 0) {
      void entry.refresher.refresh(entry.controller.signal);
    }
  }, [socketOpens]);
}

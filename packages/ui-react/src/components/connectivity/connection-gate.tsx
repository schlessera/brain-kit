import type { BrainUiRoot } from "../../root.js";
import { useBrainUiRoot } from "../../root-context.js";
import { Brain, WifiOff, ShieldAlert } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoginScreen } from "./login-screen.js";
import { useVpnStatus } from "../../hooks/use-vpn-status.js";
import {
  deriveConnectionIssue,
  type ConnectionIssue,
} from "./connection-state.js";
import { rebindPushSubscriptionAfterLogin } from "../../lib/push-registration.js";

const INITIAL_PUSH_REBIND_BACKOFF_MS = 1_000;
const MAX_PUSH_REBIND_BACKOFF_MS = 60_000;

function newPushRebind() {
  return {
    pending: true,
    inFlight: false,
    retryReady: true,
    backoffMs: INITIAL_PUSH_REBIND_BACKOFF_MS,
    retryTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    controller: new AbortController(),
  };
}

export function ConnectionGate({ children }: { children: ReactNode }) {
  const root = useBrainUiRoot();
  // The gate owns its connectivity probe — composing <ConnectionGate> is all
  // an embedder needs; the store would otherwise sit on "checking" forever.
  const successfulProbeCount = useVpnStatus();
  const vpnStatus = useConnectionStore((s) => s.vpnStatus);
  const handshakeFailures = useConnectionStore((s) => s.handshakeFailures);
  const lastCloseCode = useConnectionStore((s) => s.lastCloseCode);
  const reportError = useConnectionStore((s) => s.reportError);
  const issue = deriveConnectionIssue({
    vpnStatus,
    handshakeFailures,
    lastCloseCode,
  });

  // Once the app has connected, never unmount the UI again — an intermittent
  // drop must not destroy rendered chat state. Show a banner instead.
  const [connectedRoot, setConnectedRoot] = useState<BrainUiRoot | null>(null);
  const everConnected = connectedRoot === root;
  useEffect(() => {
    if (vpnStatus === "connected") setConnectedRoot(root);
  }, [vpnStatus, root]);

  const pushRebind = useRef(newPushRebind());

  useEffect(() => {
    const state = newPushRebind();
    pushRebind.current = state;
    return () => {
      state.controller.abort();
      clearTimeout(state.retryTimer);
    };
  }, [root]);

  // A successful authenticated probe follows a login reload (and is also the
  // boot path for ambient auth modes). Re-assert any browser-held subscription
  // so legacy/unbound rows acquire the current principal. A failed request
  // stays pending: later successful probes, including foreground-triggered
  // probes, retry it once the exponential backoff has elapsed.
  useEffect(() => {
    const state = pushRebind.current;
    if (
      successfulProbeCount === 0 ||
      vpnStatus !== "connected" ||
      !state.pending ||
      state.inFlight ||
      !state.retryReady
    ) {
      return;
    }

    state.inFlight = true;
    void rebindPushSubscriptionAfterLogin(root.api, state.controller.signal).then(
      () => {
        if (state.controller.signal.aborted) return;
        state.inFlight = false;
        state.pending = false;
      },
      () => {
        if (state.controller.signal.aborted) return;
        state.inFlight = false;
        state.retryReady = false;
        const delay = state.backoffMs;
        state.backoffMs = Math.min(
          state.backoffMs * 2,
          MAX_PUSH_REBIND_BACKOFF_MS
        );
        state.retryTimer = setTimeout(() => {
          state.retryReady = true;
          state.retryTimer = undefined;
        }, delay);
      }
    );
  }, [successfulProbeCount, vpnStatus, root]);

  const refused = issue === "refused" || issue === "capacity";
  const wasRefused = useRef(false);
  useEffect(() => {
    if (!refused) {
      wasRefused.current = false;
      return;
    }
    if (wasRefused.current) return;
    wasRefused.current = true;
    if (issue === "capacity") {
      reportError(
        "WEBSOCKET_CAPACITY",
        "The server refused the WebSocket because its connection limit was reached (close code 4008)."
      );
    } else {
      reportError(
        "WEBSOCKET_REFUSED",
        `The server is reachable and the session is valid, but it refused the WebSocket connection (close code ${lastCloseCode ?? 1006}).`
      );
    }
  }, [issue, refused, lastCloseCode, reportError]);

  // Auth required (password mode) and no valid session: show the login screen,
  // even if we were connected before (an expired session must re-prompt).
  if (issue === "unauthorized") {
    return <LoginScreen />;
  }

  if (vpnStatus === "connected" || everConnected) {
    return (
      <>
        <OfflineBanner
          show={refused || (everConnected && vpnStatus !== "connected")}
          issue={issue}
        />
        {children}
      </>
    );
  }

  return (
    <div className="flex h-[100dvh] items-center justify-center bg-background">
      <AnimatePresence mode="wait">
        <motion.div
          key={vpnStatus}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.3 }}
          className="flex flex-col items-center gap-6 text-center px-6"
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface">
            <Brain
              className="h-8 w-8 text-primary"
              style={
                vpnStatus === "checking"
                  ? { animation: "breathe 3s ease-in-out infinite" }
                  : undefined
              }
            />
          </div>

          {vpnStatus === "checking" && (
            <p className="text-sm text-muted-foreground">Connecting...</p>
          )}

          {vpnStatus === "forbidden" && (
            <>
              <h1 className="font-[family-name:var(--font-display)] text-2xl text-foreground">
                VPN Required
              </h1>
              <p className="text-sm text-muted-foreground max-w-xs">
                Connect to the Tailscale VPN to access Brain.
              </p>
            </>
          )}

          {vpnStatus === "unreachable" && (
            <>
              <h1 className="font-[family-name:var(--font-display)] text-2xl text-foreground">
                Unable to reach server
              </h1>
              <p className="text-sm text-muted-foreground max-w-xs">
                Check your connection and try again. Retrying automatically...
              </p>
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/**
 * Slim overlay banner for connection drops after the app is up. The UI below
 * stays mounted and interactive; reconnection is automatic (VPN poll + WS
 * backoff both tighten while offline).
 */
function OfflineBanner({
  show,
  issue,
}: {
  show: boolean;
  issue: ConnectionIssue;
}) {
  const root = useBrainUiRoot();
  const message =
    issue === "forbidden"
      ? "VPN required — reconnect Tailscale"
      : issue === "unreachable"
        ? "Connection lost — reconnecting…"
        : issue === "capacity"
          ? "Server connection limit reached"
          : issue === "refused"
            ? "Server refused the live connection"
            : "Connection lost — reconnecting…";

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: -24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -24 }}
          transition={{ duration: 0.2 }}
          className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center px-4 pt-3"
        >
          <div
            role="status"
            className="pointer-events-auto flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-950/90 px-4 py-1.5 text-xs text-amber-200 shadow-lg backdrop-blur"
          >
            {issue === "forbidden" ? (
              <ShieldAlert className="h-3.5 w-3.5" />
            ) : (
              <WifiOff className="h-3.5 w-3.5" />
            )}
            <span>{message}</span>
            {(issue === "refused" || issue === "capacity") && (
              <button
                type="button"
                onClick={root.connection.reconnectNow}
                className="font-medium underline underline-offset-2 hover:text-amber-100"
              >
                Retry now
              </button>
            )}
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400"
              style={{ animation: "breathe 2s ease-in-out infinite" }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

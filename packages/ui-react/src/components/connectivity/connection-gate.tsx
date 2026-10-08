import type { BrainUiRoot } from "../../root.js";
import { useBrainUiRoot } from "../../root-context.js";
import { Brain, WifiOff, ShieldAlert } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { LocalCaptureScreen, LOCAL_CAPTURE_UNSUPPORTED } from "./local-capture-screen.js";
import { useLocalCaptureSupport } from "../../voice/use-local-capture.js";
import { AssociateRecordings } from "../voice/associate-recordings.js";
import { LoginScreen } from "./login-screen.js";
import { useVpnStatus } from "../../hooks/use-vpn-status.js";
import {
  deriveConnectionIssue,
  type ConnectionIssue,
} from "./connection-state.js";
import { rebindPushSubscriptionAfterLogin } from "../../lib/push-registration.js";
import { useNotificationZoneRefresh } from "../../hooks/use-notification-zone.js";

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
  const vpnStatus = useConnectionStore((s) => s.vpnStatus);
  const handshakeFailures = useConnectionStore((s) => s.handshakeFailures);
  const lastCloseCode = useConnectionStore((s) => s.lastCloseCode);
  const reportError = useConnectionStore((s) => s.reportError);
  const socketOpens = useConnectionStore((s) => s.socketOpens);
  const auth = useStore(root.authLock.state);
  useEffect(() => root.localWorkFlow.attachGate(), [root]);
  const workFlow = useStore(root.localWorkFlow.state);
  const account = useConnectionStore(s => s.accountKey);
  const [association, setAssociation] = useState(false);
  useEffect(() => {
    if (!account || vpnStatus !== "connected" || auth.phase !== "active" || workFlow.signingOut || workFlow.signingIn) return;
    if (!root.localWorkFlow.hasSignIn()) return;
    let live = true;
    void (async () => {
      await root.partitions?.allowWritesAfterSignIn(account);
      const rows = await root.recordings?.list("unassigned");
      if (live && root.stores.connection.getState().accountKey === account) {
        root.localWorkFlow.consumeSignIn(); if (rows?.some(r => r.state !== "recording")) setAssociation(true);
      }
    })().catch(() => {});
    return () => { live = false; };
  }, [root, account, vpnStatus, auth.phase, workFlow.association, workFlow.signingOut, workFlow.signingIn]);
  useLayoutEffect(() => { if (auth.phase === "locked") root.authLock.dropContext(); }, [root, auth.phase]);
  const issue = deriveConnectionIssue({
    vpnStatus,
    handshakeFailures,
    lastCloseCode,
  });

  // Once the app has connected, never unmount the UI again — an intermittent
  // drop must not destroy rendered chat state. Show a banner instead.
  const [connectedRoot, setConnectedRoot] = useState<BrainUiRoot | null>(null);
  const everConnected = connectedRoot === root;

  const supported = useLocalCaptureSupport();
  const [captureRoot, setCaptureRoot] = useState<BrainUiRoot | null>(null);
  const [controlled, setControlled] = useState(() => typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller);
  useEffect(() => {
    const workers = navigator.serviceWorker;
    const update = () => setControlled(!!workers?.controller);
    update();
    workers?.addEventListener?.("controllerchange", update);
    return () => workers?.removeEventListener?.("controllerchange", update);
  }, [root]);
  useEffect(() => {
    if (vpnStatus === "connected" && captureRoot !== root) setConnectedRoot(root);
  }, [vpnStatus, root, captureRoot]);
  const canCapture = supported === true && root.partitions !== null && root.localCapture?.durable === true;
  const localMode = captureRoot === root || (!everConnected && vpnStatus === "unreachable" && controlled && canCapture);
  const { successfulProbeCount, localStatus } = useVpnStatus(localMode);
  useEffect(() => { if (localMode) setCaptureRoot(root); }, [root, localMode]);

  const pushRebind = useRef(newPushRebind());

  // Client-local Action notice timing follows this client's reported zone.
  useNotificationZoneRefresh(root.api, {
    successfulProbeCount,
    connected: vpnStatus === "connected" && !localMode,
    socketOpens,
  });

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
      localMode ||
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
  }, [successfulProbeCount, vpnStatus, root, localMode]);

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

  if (localMode) {
    return <LocalCaptureScreen reachable={localStatus === "connected" || localStatus === "unauthorized" || localStatus === "forbidden"} onContinue={() => {
      setCaptureRoot(null);
      root.recheckVpn();
      // Leaving the local screen is explicit. The next probe selects auth/chat.
      root.stores.connection.getState().setVpnStatus("checking");
    }} />;
  }

  // Auth required (password mode) and no valid session: show the login screen,
  // even if we were connected before (an expired session must re-prompt).
  if (workFlow.signingOut) return <div role="status" className="flex h-[100dvh] items-center justify-center bg-background text-foreground">Signing out…</div>;
  if (workFlow.signingIn) return <LoginScreen {...(workFlow.signInWarm ? { reauth: auth } : {})} />;
  if (auth.phase === "locked" || auth.phase === "restoring") {
    return <LoginScreen reauth={auth} onLocalCapture={canCapture ? () => { if (root.authLock.state.getState().phase === "locked") setCaptureRoot(root); } : undefined} />;
  }
  if (issue === "unauthorized" && auth.phase !== "saving") {
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
        {workFlow.notice && <p role="status" className="p-3 text-sm text-foreground">{workFlow.notice}</p>}
        <div className="sr-only" aria-live="polite">{workFlow.associationNotice}</div>
        <LockedRecordingSize />
        {association && <AssociateRecordings onClose={() => setAssociation(false)} />}
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
          {workFlow.notice && <p role="status" className="max-w-xs text-sm text-foreground">{workFlow.notice}</p>}

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
              {supported === false && <p className="text-sm text-muted-foreground max-w-xs">{LOCAL_CAPTURE_UNSUPPORTED}</p>}
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
            className="pointer-events-auto flex items-center gap-2 rounded-full border border-primary/30 bg-surface-raised/90 px-4 py-1.5 text-xs text-primary shadow-lg backdrop-blur"
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
                className="font-medium underline underline-offset-2 hover:text-foreground"
              >
                Retry now
              </button>
            )}
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-primary-mark"
              style={{ animation: "breathe 2s ease-in-out infinite" }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Capacity honesty only: never opens a locked partition or returns its metadata. */
function LockedRecordingSize() {
  const root = useBrainUiRoot();
  const key = useConnectionStore((s) => s.accountKey);
  const [bytes, setBytes] = useState(0);
  useEffect(() => {
    let current = true;
    void root.partitions?.sizes("recording:chunk:").then((sizes) => {
      if (current) setBytes(sizes.filter((s) => s.partition !== "unassigned" && s.partition !== `account:${key}`).reduce((n, s) => n + s.bytes, 0));
    }).catch(() => {});
    return () => { current = false; };
  }, [root, key]);
  return bytes > 0 ? <p data-locked-recordings className="text-xs text-muted-foreground">Locked recordings from another account · {(bytes / (1024 * 1024)).toFixed(1)} MB</p> : null;
}

import { Brain, WifiOff, ShieldAlert } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useConnectionStore } from "../../stores/connection-store.js";
import { useEffect, useState, type ReactNode } from "react";
import { LoginScreen } from "./login-screen.js";

export function ConnectionGate({ children }: { children: ReactNode }) {
  const vpnStatus = useConnectionStore((s) => s.vpnStatus);

  // Once the app has connected, never unmount the UI again — an intermittent
  // drop must not destroy rendered chat state. Show a banner instead.
  const [everConnected, setEverConnected] = useState(false);
  useEffect(() => {
    if (vpnStatus === "connected") setEverConnected(true);
  }, [vpnStatus]);

  // Auth required (password mode) and no valid session: show the login screen,
  // even if we were connected before (an expired session must re-prompt).
  if (vpnStatus === "unauthorized") {
    return <LoginScreen />;
  }

  if (vpnStatus === "connected" || everConnected) {
    return (
      <>
        <OfflineBanner
          show={everConnected && vpnStatus !== "connected"}
          forbidden={vpnStatus === "forbidden"}
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
  forbidden,
}: {
  show: boolean;
  forbidden: boolean;
}) {
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
            className="flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-950/90 px-4 py-1.5 text-xs text-amber-200 shadow-lg backdrop-blur"
          >
            {forbidden ? (
              <ShieldAlert className="h-3.5 w-3.5" />
            ) : (
              <WifiOff className="h-3.5 w-3.5" />
            )}
            <span>
              {forbidden
                ? "VPN required — reconnect Tailscale"
                : "Connection lost — reconnecting…"}
            </span>
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

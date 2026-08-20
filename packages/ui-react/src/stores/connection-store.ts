import { create } from "zustand";

type WsStatus = "connecting" | "connected" | "disconnected";
type VpnStatus =
  | "connected"
  | "forbidden"
  | "unauthorized"
  | "unreachable"
  | "checking";

/**
 * The last thing that went wrong, whether or not a turn was running.
 *
 * Before this existed, a `error` frame was only surfaced when a message was
 * mid-stream: it was appended to the streaming transcript, and outside a turn
 * it went nowhere at all — no console, no store, no UI. A PARSE_ERROR between
 * turns was dropped on the client as silently as it was on the server.
 * Protocol-level drops from the SDK client land here too.
 */
export interface ConnectionError {
  code: string;
  message: string;
  /** Epoch millis, so a view can decide whether this is still interesting. */
  at: number;
}

interface ConnectionState {
  wsStatus: WsStatus;
  vpnStatus: VpnStatus;
  lastError: ConnectionError | null;
  setWsStatus: (status: WsStatus) => void;
  setVpnStatus: (status: VpnStatus) => void;
  reportError: (code: string, message: string) => void;
  clearError: () => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  wsStatus: "disconnected",
  vpnStatus: "checking",
  lastError: null,
  setWsStatus: (wsStatus) => set({ wsStatus }),
  setVpnStatus: (vpnStatus) => set({ vpnStatus }),
  reportError: (code, message) => set({ lastError: { code, message, at: Date.now() } }),
  clearError: () => set({ lastError: null }),
}));

import { createStore } from "zustand/vanilla";

export type WsStatus = "connecting" | "connected" | "disconnected";
export type VpnStatus =
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

export interface ConnectionState {
  wsStatus: WsStatus;
  vpnStatus: VpnStatus;
  handshakeFailures: number;
  lastCloseCode: number | null;
  /**
   * Monotonic count of sockets that reached `open`. A probe started before a
   * socket opened compares this to decide whether its answer is still the
   * newest evidence — comparing wsStatus twice cannot see a drop and a
   * replacement open that both land inside one probe.
   */
  socketOpens: number;
  lastError: ConnectionError | null;
  setWsStatus: (status: WsStatus) => void;
  setVpnStatus: (status: VpnStatus) => void;
  recordWsClose: (opened: boolean, code: number) => void;
  /** A socket reached `open`: the refusal evidence so far is spent. */
  noteSocketOpen: () => void;
  reportError: (code: string, message: string) => void;
  clearError: () => void;
}

export function createConnectionStore() {
  return createStore<ConnectionState>((set) => ({
    wsStatus: "disconnected",
    vpnStatus: "checking",
    handshakeFailures: 0,
    lastCloseCode: null,
    socketOpens: 0,
    lastError: null,
    setWsStatus: (wsStatus) => set({ wsStatus }),
    setVpnStatus: (vpnStatus) => set({ vpnStatus }),
    recordWsClose: (opened, lastCloseCode) =>
      set((state) => ({
        lastCloseCode,
        handshakeFailures: opened
          ? state.handshakeFailures
          : state.handshakeFailures + 1,
      })),
    noteSocketOpen: () =>
      set((state) => ({
        handshakeFailures: 0,
        // Cleared here, not on the next close: the server accepts the upgrade and
        // THEN closes with 4008 when it is at its connection cap, so the code
        // must survive an open to be read, and must not outlive the next one.
        lastCloseCode: null,
        socketOpens: state.socketOpens + 1,
      })),
    reportError: (code, message) => set({ lastError: { code, message, at: Date.now() } }),
    clearError: () => set({ lastError: null }),
  }));
}

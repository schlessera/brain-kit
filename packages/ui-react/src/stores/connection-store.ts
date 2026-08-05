import { create } from "zustand";

type WsStatus = "connecting" | "connected" | "disconnected";
type VpnStatus =
  | "connected"
  | "forbidden"
  | "unauthorized"
  | "unreachable"
  | "checking";

interface ConnectionState {
  wsStatus: WsStatus;
  vpnStatus: VpnStatus;
  setWsStatus: (status: WsStatus) => void;
  setVpnStatus: (status: VpnStatus) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  wsStatus: "disconnected",
  vpnStatus: "checking",
  setWsStatus: (wsStatus) => set({ wsStatus }),
  setVpnStatus: (vpnStatus) => set({ vpnStatus }),
}));

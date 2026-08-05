import { describe, test, expect, beforeEach } from "bun:test";
import { useConnectionStore } from "../src/stores/connection-store";

beforeEach(() => {
  useConnectionStore.setState({
    wsStatus: "disconnected",
    vpnStatus: "checking",
  });
});

describe("connection store", () => {
  test("initial state", () => {
    const state = useConnectionStore.getState();
    expect(state.wsStatus).toBe("disconnected");
    expect(state.vpnStatus).toBe("checking");
  });

  test("setWsStatus updates WebSocket status", () => {
    useConnectionStore.getState().setWsStatus("connected");
    expect(useConnectionStore.getState().wsStatus).toBe("connected");
  });

  test("setWsStatus to connecting", () => {
    useConnectionStore.getState().setWsStatus("connecting");
    expect(useConnectionStore.getState().wsStatus).toBe("connecting");
  });

  test("setVpnStatus to connected", () => {
    useConnectionStore.getState().setVpnStatus("connected");
    expect(useConnectionStore.getState().vpnStatus).toBe("connected");
  });

  test("setVpnStatus to disconnected", () => {
    useConnectionStore.getState().setVpnStatus("unreachable");
    expect(useConnectionStore.getState().vpnStatus).toBe("unreachable");
  });

  test("ws and vpn status are independent", () => {
    useConnectionStore.getState().setWsStatus("connected");
    useConnectionStore.getState().setVpnStatus("unreachable");
    const state = useConnectionStore.getState();
    expect(state.wsStatus).toBe("connected");
    expect(state.vpnStatus).toBe("unreachable");
  });
});

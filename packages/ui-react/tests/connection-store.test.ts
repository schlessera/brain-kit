import { describe, test, expect, beforeEach } from "bun:test";
import { useConnectionStore } from "../src/stores/connection-store";

beforeEach(() => {
  useConnectionStore.setState({
    wsStatus: "disconnected",
    vpnStatus: "checking",
    handshakeFailures: 0,
    lastCloseCode: null,
    lastError: null,
  });
});

describe("connection store", () => {
  test("initial state", () => {
    const state = useConnectionStore.getState();
    expect(state.wsStatus).toBe("disconnected");
    expect(state.vpnStatus).toBe("checking");
    expect(state.handshakeFailures).toBe(0);
    expect(state.lastCloseCode).toBeNull();
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

  test("records close facts and resets only consecutive handshake failures", () => {
    useConnectionStore.getState().recordWsClose(false, 1006);
    useConnectionStore.getState().recordWsClose(false, 4008);
    expect(useConnectionStore.getState().handshakeFailures).toBe(2);
    expect(useConnectionStore.getState().lastCloseCode).toBe(4008);

    // A socket reaching `open` spends the refusal evidence: the failure count
    // AND the close code, because the server's cap refusal arrives as a close
    // AFTER the upgrade is accepted and must not outlive the next open.
    useConnectionStore.getState().noteSocketOpen();
    expect(useConnectionStore.getState().handshakeFailures).toBe(0);
    expect(useConnectionStore.getState().lastCloseCode).toBeNull();
    expect(useConnectionStore.getState().socketOpens).toBe(1);

    useConnectionStore.getState().recordWsClose(true, 1000);
    expect(useConnectionStore.getState().handshakeFailures).toBe(0);
    expect(useConnectionStore.getState().lastCloseCode).toBe(1000);
    expect(useConnectionStore.getState().socketOpens).toBe(1);
  });

  test("an opened socket closed at the connection cap still records 4008", () => {
    useConnectionStore.getState().noteSocketOpen();
    useConnectionStore.getState().recordWsClose(true, 4008);
    const state = useConnectionStore.getState();
    // The server accepts the upgrade and then closes, so the handshake counter
    // stays at zero — which is exactly why the capacity branch cannot be
    // gated on it.
    expect(state.handshakeFailures).toBe(0);
    expect(state.lastCloseCode).toBe(4008);
  });
});

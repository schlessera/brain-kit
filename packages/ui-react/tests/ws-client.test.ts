import { describe, test, expect } from "bun:test";
import { WSClient } from "../src/lib/ws-client";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";

describe("WSClient", () => {
  test("constructs without connecting", () => {
    const messages: ServerMessage[] = [];
    const statuses: string[] = [];
    const client = new WSClient(
      "ws://localhost:9999",
      (msg) => messages.push(msg),
      (status) => statuses.push(status)
    );
    expect(client.isConnected).toBe(false);
  });

  test("reports disconnected initially", () => {
    const client = new WSClient("ws://localhost:9999", () => {}, () => {});
    expect(client.isConnected).toBe(false);
  });

  test("close is safe to call before connect", () => {
    const client = new WSClient("ws://localhost:9999", () => {}, () => {});
    client.close(); // Should not throw
    expect(client.isConnected).toBe(false);
  });

  test("send is safe when not connected", () => {
    const client = new WSClient("ws://localhost:9999", () => {}, () => {});
    // Should not throw even when not connected
    client.send({ type: "cancel" });
    expect(client.isConnected).toBe(false);
  });

  test("connect calls status callback with 'connecting'", async () => {
    const statuses: string[] = [];
    const client = new WSClient(
      "ws://localhost:9999", // unreachable port
      () => {},
      (status) => statuses.push(status)
    );
    client.connect();
    // Should immediately report "connecting"
    expect(statuses).toContain("connecting");
    client.close();
  });
});

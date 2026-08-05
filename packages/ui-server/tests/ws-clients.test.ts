import { describe, test, expect, beforeEach } from "bun:test";
import {
  addClient,
  removeClient,
  broadcast,
  sendTo,
  hasClients,
  clientCount,
  resetClientsForTests,
  type WSContext,
} from "../src/ws/clients";
import { MAX_WS_MESSAGE_BYTES } from "../src/ws/shrink";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";

function fakeSocket() {
  const sent: string[] = [];
  const ws: WSContext & { sent: string[] } = {
    sent,
    send(data: string) {
      sent.push(data);
    },
  };
  return ws;
}

const IDLE: ServerMessage = { type: "status", status: "idle" };

beforeEach(() => {
  resetClientsForTests();
});

describe("ws client registry", () => {
  test("broadcast reaches every attached client", () => {
    const a = fakeSocket();
    const b = fakeSocket();
    addClient(a);
    addClient(b);
    expect(clientCount()).toBe(2);

    broadcast(IDLE);

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[0])).toEqual(IDLE);
    expect(JSON.parse(b.sent[0])).toEqual(IDLE);
  });

  test("a second connection does not orphan the first (both receive output)", () => {
    const first = fakeSocket();
    addClient(first);
    const second = fakeSocket();
    addClient(second);

    broadcast({ type: "text_delta", text: "shared stream" });

    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
  });

  test("removeClient prunes; broadcast skips the departed socket", () => {
    const a = fakeSocket();
    const b = fakeSocket();
    addClient(a);
    addClient(b);
    removeClient(a);
    expect(clientCount()).toBe(1);
    expect(hasClients()).toBe(true);

    broadcast(IDLE);
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
  });

  test("hasClients is false once the last client leaves", () => {
    const a = fakeSocket();
    addClient(a);
    removeClient(a);
    expect(hasClients()).toBe(false);
    expect(clientCount()).toBe(0);
    // Broadcasting with no clients is a no-op, not a throw.
    expect(() => broadcast(IDLE)).not.toThrow();
  });

  test("a throwing socket does not block delivery to the others", () => {
    const bad: WSContext = {
      send() {
        throw new Error("socket closed");
      },
    };
    const good = fakeSocket();
    addClient(bad);
    addClient(good);

    expect(() => broadcast(IDLE)).not.toThrow();
    expect(good.sent).toHaveLength(1);
  });

  test("sendTo size-bounds an oversized frame", () => {
    const ws = fakeSocket();
    sendTo(ws, {
      type: "tool_result",
      toolUseId: "t1",
      output: "q".repeat(5_000_000),
      isError: false,
    });
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].length).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
    const frame = JSON.parse(ws.sent[0]);
    expect(frame.toolUseId).toBe("t1");
  });

  test("broadcast size-bounds oversized frames for every client", () => {
    const a = fakeSocket();
    const b = fakeSocket();
    addClient(a);
    addClient(b);
    broadcast({
      type: "tool_result",
      toolUseId: "t2",
      output: "w".repeat(5_000_000),
      isError: false,
    });
    expect(a.sent[0].length).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
    expect(b.sent[0].length).toBeLessThanOrEqual(MAX_WS_MESSAGE_BYTES);
  });
});

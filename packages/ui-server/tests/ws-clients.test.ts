import { describe, test, expect, beforeEach } from "bun:test";
import { ClientSet, sendTo, type WSContext } from "../src/ws/clients";
// Independent default frame budget, so the cap cannot drift with its oracle.
const FRAME_BUDGET_BYTES = 512_000;
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

let clients: ClientSet;

beforeEach(() => {
  clients = new ClientSet();
});

const addClient = (ws: WSContext) => clients.add(ws, "test-principal");
const removeClient = (ws: WSContext) => clients.remove(ws);
const broadcast = (msg: ServerMessage) => clients.broadcast(msg);
const hasClients = () => clients.hasClients();
const clientCount = () => clients.count();

describe("ws client registry", () => {
  test("the default cap accepts 32 clients and refuses the 33rd", () => {
    const sockets = Array.from({ length: 33 }, () => fakeSocket());
    for (const ws of sockets) addClient(ws);

    expect(clientCount()).toBe(32);
  });

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

  test("closeAll closes every client with the supplied reason and clears the set", () => {
    const closed: Array<[number | undefined, string | undefined]> = [];
    const a: WSContext = {
      send() {},
      close(code, reason) {
        closed.push([code, reason]);
      },
    };
    const b: WSContext = {
      send() {},
      close(code, reason) {
        closed.push([code, reason]);
      },
    };
    addClient(a);
    addClient(b);

    clients.closeAll(1008, "Sessions invalidated");

    expect(closed).toEqual([
      [1008, "Sessions invalidated"],
      [1008, "Sessions invalidated"],
    ]);
    expect(clientCount()).toBe(0);
  });

  test("closeFor closes exactly one principal's sockets and leaves the others attached", () => {
    const closedA: string[] = [];
    const closedB: string[] = [];
    const sentB: string[] = [];
    const a1: WSContext = {
      send() {},
      close: (_code, reason) => closedA.push(`a1:${reason}`),
    };
    const a2: WSContext = {
      send() {},
      close: (_code, reason) => closedA.push(`a2:${reason}`),
    };
    const b: WSContext = {
      send: (data) => sentB.push(data),
      close: (_code, reason) => closedB.push(`b:${reason}`),
    };
    clients.add(a1, "principal-a");
    clients.add(a2, "principal-a");
    clients.add(b, "principal-b");

    clients.closeFor("principal-a", 1008, "revoked");
    clients.broadcast(IDLE);

    expect(closedA).toEqual(["a1:revoked", "a2:revoked"]);
    expect(closedB).toEqual([]);
    expect(sentB).toHaveLength(1);
    expect(clientCount()).toBe(1);
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
      output: "q".repeat(600_000),
      isError: false,
    });
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0].length).toBeLessThanOrEqual(FRAME_BUDGET_BYTES);
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
      output: "w".repeat(600_000),
      isError: false,
    });
    expect(a.sent[0].length).toBeLessThanOrEqual(FRAME_BUDGET_BYTES);
    expect(b.sent[0].length).toBeLessThanOrEqual(FRAME_BUDGET_BYTES);
  });
});

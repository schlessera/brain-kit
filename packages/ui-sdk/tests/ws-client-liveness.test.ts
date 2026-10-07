/**
 * Liveness B and receipt negotiation in `BrainUiClient` (#910).
 *
 * A phone that comes back from the background can hold a socket that reads
 * OPEN and delivers nothing. `reconnectNow()` is a no-op on an OPEN socket,
 * so the client has to ask the host. These drive the real client over a fake
 * socket with shortened timings; the browser/server harness measures the
 * real 15/5 s profile.
 */
import { describe, expect, test } from "bun:test";

import { BrainUiClient, type LivenessEvent } from "../src/client/index.js";


class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  closedWith: number | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close(code = 1000, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = code;
    // Like a real socket, the close event arrives later, not inside close().
    queueMicrotask(() => this.onclose?.({ code, reason } as CloseEvent));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
  frames(type: string) {
    return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === type);
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(capabilities: Record<string, boolean> = { liveness: true, askReceipts: true }) {
  const sockets: FakeSocket[] = [];
  const statuses: string[] = [];
  const events: LivenessEvent[] = [];
  const hellos: number[] = [];
  const client = new BrainUiClient({
    url: "ws://test/ws",
    liveness: { idleMs: 40, responseMs: 30 },
    onStatusChange: (s) => statuses.push(s),
    onLiveness: (e) => events.push(e),
    onHello: (h) => hellos.push(h.protocolRev),
    handlers: { onAny: () => {} },
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const openWithHello = (socket: FakeSocket) => {
    socket.open();
    socket.deliver({ type: "server_hello", protocolRev: 5, capabilities });
  };
  client.connect();
  openWithHello(sockets[0]!);
  return { client, sockets, statuses, events, hellos, openWithHello };
}

describe("the client hello", () => {
  test("declares receipt support", () => {
    const { sockets, client } = harness();
    expect(sockets[0]!.frames("client_hello")[0].capabilities).toEqual({ askReceipts: true, followUpQueue: true });
    client.close();
  });
});

describe("receipt negotiation", () => {
  test("a host that advertises askReceipts in its hello supports them", () => {
    const { client } = harness();
    expect(client.hello).toBe("received");
    expect(client.supportsAskReceipts).toBe(true);
    client.close();
  });

  test("a hello without the flag does not", () => {
    const { client } = harness({ liveness: true });
    expect(client.supportsAskReceipts).toBe(false);
    client.close();
  });

  test("a host whose first frame is not a hello is a legacy peer", () => {
    const sockets: FakeSocket[] = [];
    const client = new BrainUiClient({
      url: "ws://test/ws",
      handlers: { onAny: () => {} },
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    client.connect();
    sockets[0]!.open();
    expect(client.hello).toBe("pending");
    sockets[0]!.deliver({ type: "status", status: "idle" });
    expect(client.hello).toBe("absent");
    expect(client.supportsAskReceipts).toBe(false);
    client.close();
  });
});

describe("idle probes", () => {
  test("a probe goes out after the idle interval without host traffic", async () => {
    const { sockets, events, client } = harness();
    await wait(60);
    expect(sockets[0]!.frames("ping")).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "probe", reason: "idle" });
    client.close();
  });

  test("host traffic restarts the idle clock", async () => {
    const { sockets, client } = harness();
    for (let i = 0; i < 4; i++) {
      await wait(20);
      sockets[0]!.deliver({ type: "status", status: "idle" });
    }
    expect(sockets[0]!.frames("ping")).toHaveLength(0);
    client.close();
  });

  test("a host without the liveness capability is never probed", async () => {
    const { sockets, client } = harness({ askReceipts: true });
    await wait(60);
    client.checkLiveness();
    expect(sockets[0]!.frames("ping")).toHaveLength(0);
    client.close();
  });

  test("a correlated pong keeps the connection", async () => {
    const { sockets, events, client } = harness();
    await wait(50);
    const ping = sockets[0]!.frames("ping")[0];
    sockets[0]!.deliver({ type: "pong", probeId: ping.probeId });
    await wait(40);
    expect(sockets).toHaveLength(1);
    expect(events.find((e) => e.type === "pong")).toMatchObject({ type: "pong", probeId: ping.probeId });
    expect(events.some((e) => e.type === "stale")).toBe(false);
    client.close();
  });

  test("a pong for another probe does not count as the reply", async () => {
    const { sockets, events, client } = harness();
    client.checkLiveness();
    sockets[0]!.deliver({ type: "pong", probeId: "probe-someone-else" });
    await wait(40);
    expect(events.some((e) => e.type === "stale")).toBe(true);
    expect(sockets).toHaveLength(2);
    client.close();
  });
});

describe("a half-open socket", () => {
  test("is replaced when the probe goes unanswered", async () => {
    const { sockets, statuses, events, client } = harness();
    client.checkLiveness();
    await wait(40);
    expect(events.map((e) => e.type)).toEqual(["probe", "stale"]);
    expect(sockets[0]!.closedWith).toBe(4000);
    expect(sockets).toHaveLength(2);
    expect(statuses.slice(-2)).toEqual(["disconnected", "connecting"]);
    client.close();
  });

  test("its late callbacks cannot touch the replacement", async () => {
    const { sockets, statuses, client, openWithHello, hellos } = harness();
    client.checkLiveness();
    await wait(40);
    openWithHello(sockets[1]!);
    expect(client.supportsAskReceipts).toBe(true);
    const before = statuses.length;
    // The abandoned socket finally speaks, then closes.
    sockets[0]!.deliver({ type: "server_hello", protocolRev: 2, capabilities: {} });
    sockets[0]!.onclose?.({ code: 1006, reason: "" } as CloseEvent);
    await wait(5);
    expect(client.protocolRev).toBe(5);
    expect(client.supportsAskReceipts).toBe(true);
    expect(hellos).toEqual([5, 5]);
    expect(statuses.length).toBe(before);
    expect(sockets).toHaveLength(2);
    client.close();
  });
});

describe("foreground", () => {
  test("periodic probes pause in the background", async () => {
    const { sockets, client } = harness();
    client.setForeground(false);
    await wait(70);
    expect(sockets[0]!.frames("ping")).toHaveLength(0);
    client.close();
  });

  test("returning to the foreground checks at once", () => {
    const { sockets, events, client } = harness();
    client.setForeground(false);
    client.setForeground(true);
    expect(sockets[0]!.frames("ping")).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "probe", reason: "check" });
    client.close();
  });

  test("checking with no open socket reconnects instead", async () => {
    const { sockets, client } = harness();
    sockets[0]!.close(1006);
    await wait(1);
    client.checkLiveness();
    expect(sockets).toHaveLength(2);
    client.close();
  });
});

describe("an open socket that says nothing", () => {
  test("is abandoned and retried through the backoff, not at once", async () => {
    const sockets: FakeSocket[] = [];
    const client = new BrainUiClient({
      url: "ws://test/ws",
      liveness: { connectMs: 20 },
      handlers: { onAny: () => {} },
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    client.connect();
    sockets[0]!.open();
    await wait(60);
    expect(sockets[0]!.closedWith).toBe(4000);
    // The first backoff step is one second: no second attempt yet.
    expect(sockets).toHaveLength(1);
    await wait(1100);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    await wait(60);
    // Still silent: the next step is two seconds, not one.
    await wait(1100);
    expect(sockets).toHaveLength(2);
    client.close();
  });
});

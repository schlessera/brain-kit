import { expect, spyOn, test } from "bun:test";
import * as http from "node:http";
import type { Socket } from "node:net";
import { startEgressProxy, type EgressRecord } from "../src/server/egress-proxy.js";

function get(socketPath: string, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: target }, response => {
      response.resume();
      response.once("end", () => resolve(response.statusCode!));
      response.once("error", reject);
    });
    request.once("error", reject); request.end();
  });
}

// Delay only the first proxy response's close notification. Its upstream
// response has completed and the agent can lend the real socket to a peer.
test("completed HTTP cleanup cannot destroy a socket already lent to a same-origin peer", async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const records: EgressRecord[] = [];
  const closeReady = Promise.withResolvers<void>(), peerEntered = Promise.withResolvers<void>(), releasePeer = Promise.withResolvers<void>();
  let delayedClose: (() => void) | undefined;
  const sockets: Socket[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/peer") { peerEntered.resolve(); await releasePeer.promise; }
    return new Response("Ithaca");
  } });
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], maxBytes: 8192, outwardHosts: [], observe: row => records.push(row) });
  const originalRequest = http.request, originalEmit = http.ServerResponse.prototype.emit;
  const requestSpy = spyOn(http, "request").mockImplementation(((...args: Parameters<typeof http.request>) => {
    if (args[0] instanceof URL && args[0].port === String(origin.port)) {
      const options = args[1] as http.RequestOptions;
      // Exercise actual pooling even on transports that honor Connection: close.
      const request = originalRequest(args[0], { ...options, agent, headers: { ...options.headers, connection: "keep-alive" } }, args[2] as (response: http.IncomingMessage) => void);
      request.once("socket", socket => sockets.push(socket));
      return request;
    }
    return Reflect.apply(originalRequest, http, args);
  }) as typeof http.request);
  const closeSpy = spyOn(http.ServerResponse.prototype, "emit").mockImplementation(function(this: http.ServerResponse, event: string | symbol, ...args: unknown[]) {
    if (event === "close" && this.req.url === `${origin.url}first` && !delayedClose) {
      let delivered = false;
      delayedClose = () => { if (!delivered) { delivered = true; Reflect.apply(originalEmit, this, [event, ...args]); } };
      closeReady.resolve(); return true;
    }
    return Reflect.apply(originalEmit, this, [event, ...args]);
  });
  let peer: Promise<number> | undefined;
  try {
    expect(await get(proxy.socketPath, `${origin.url}first`)).toBe(200);
    await closeReady.promise;
    peer = get(proxy.socketPath, `${origin.url}peer`);
    await peerEntered.promise;
    expect(sockets).toHaveLength(2);
    expect(sockets[1], "PEER_REUSES_THE_FIRST_REAL_TCP_SOCKET").toBe(sockets[0]);
    delayedClose!();
    releasePeer.resolve();
    expect(await peer, "COMPLETED_OPERATION_NEVER_RESETS_REUSED_SOCKET").toBe(200);
    expect(records[0]).toMatchObject({ outcome: "completed", dispatched: true });
  } finally {
    releasePeer.resolve(); delayedClose?.(); proxy.stop();
    await peer?.catch(() => {});
    closeSpy.mockRestore(); requestSpy.mockRestore(); agent.destroy(); origin.stop(true);
  }
});

test("cancelling HTTP still destroys the in-flight operation's owned socket", async () => {
  const entered = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const records: EgressRecord[] = [];
  const origin = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch() { entered.resolve(); await release.promise; return new Response("Ithaca"); } });
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], maxBytes: 8192, outwardHosts: [], observe: row => records.push(row) });
  const originalRequest = http.request;
  let socket: Socket | undefined;
  const requestSpy = spyOn(http, "request").mockImplementation(((...args: Parameters<typeof http.request>) => {
    const request = Reflect.apply(originalRequest, http, args);
    if (args[0] instanceof URL && args[0].port === String(origin.port)) request.once("socket", value => { socket = value; value.once("close", closed.resolve); });
    return request;
  }) as typeof http.request);
  const pending = get(proxy.socketPath, origin.url.href).catch(() => 0);
  try {
    await entered.promise;
    proxy.stop(); await closed.promise;
    expect(socket?.destroyed, "CANCELLATION_DESTROYS_ONLY_ITS_OWN_IN_FLIGHT_SOCKET").toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "cancelled", reason: "turn_cancelled", dispatched: true });
  } finally { release.resolve(); proxy.stop(); await pending; requestSpy.mockRestore(); origin.stop(true); }
});

test("a stale pooled upstream socket cannot turn the next same-origin operation into 502", async () => {
  const { createServer } = await import("node:net");
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const free = Promise.withResolvers<Socket>(), finSent = Promise.withResolvers<void>();
  const peers = new Set<Socket>();
  let firstPeer: Socket | undefined;
  const origin = createServer(socket => {
    peers.add(socket); socket.on("error", () => {}); socket.once("close", () => peers.delete(socket));
    socket.on("data", () => {
      firstPeer ??= socket;
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nIthaca");
    });
  });
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as { port: number }).port;
  const target = `http://127.0.0.1:${port}/`;
  agent.once("free", socket => {
    // Retain the writable half until the test delivers the real FIN event.
    // This pins the scheduling gap between pooling and processing origin close.
    socket.allowHalfOpen = true; free.resolve(socket);
  });
  const records: EgressRecord[] = [];
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], maxBytes: 8192, outwardHosts: [], observe: row => records.push(row) });
  const original = http.request;
  let firstSocket: Socket | undefined, secondSocket: Socket | undefined, pooled = false, reused = false;
  const assigned = Promise.withResolvers<void>(), flushed = Promise.withResolvers<void>();
  const requestSpy = spyOn(http, "request").mockImplementation(((...args: Parameters<typeof http.request>) => {
    if (args[0] instanceof URL && args[0].port === String(port)) {
      const options = args[1] as http.RequestOptions;
      // Install a controlled global-pool equivalent only when the production
      // request has not explicitly opted out. Preserve an explicit agent:false.
      const chosen = options.agent === undefined ? agent : options.agent;
      pooled = chosen === agent;
      const request = original(args[0], { ...options, agent: chosen,
        headers: pooled ? { ...options.headers, connection: "keep-alive" } : options.headers }, args[2] as (response: http.IncomingMessage) => void);
      request.once("socket", socket => {
        if (!firstSocket) firstSocket = socket;
        else { secondSocket = socket; reused = request.reusedSocket; request.once("finish", flushed.resolve); assigned.resolve(); }
      });
      return request;
    }
    return Reflect.apply(original, http, args);
  }) as typeof http.request);
  let second: Promise<number> | undefined, restoreEnd: (() => void) | undefined;
  try {
    expect(await get(proxy.socketPath, `${target}first`)).toBe(200);
    let deliverEnd: (() => void) | undefined;
    if (pooled) {
      const socket = await free.promise, ended = Promise.withResolvers<void>();
      const descriptor = Object.getOwnPropertyDescriptor(socket, "emit"), emit = socket.emit;
      restoreEnd = () => { if (descriptor) Object.defineProperty(socket, "emit", descriptor); else delete (socket as Partial<Socket>).emit; };
      socket.emit = function(event: string | symbol, ...args: unknown[]) {
        if (event === "end") { deliverEnd = () => { Reflect.apply(emit, socket, [event, ...args]); }; ended.resolve(); return true; }
        return Reflect.apply(emit, socket, [event, ...args]);
      };
      firstPeer!.end(finSent.resolve); await finSent.promise; await ended.promise;
    } else if (!firstPeer!.destroyed) {
      firstPeer!.end(finSent.resolve); await finSent.promise;
    }
    second = get(proxy.socketPath, `${target}peer`);
    await assigned.promise;
    if (pooled) {
      expect(secondSocket === firstSocket, "STALE_PROBE_REUSES_EXACT_REAL_SOCKET").toBe(true);
      expect(reused).toBe(true);
      await flushed.promise; restoreEnd!(); deliverEnd!();
    }
    expect(await second, "STALE_UPSTREAM_SOCKET_NEVER_BREAKS_NEXT_OPERATION").toBe(200);
    expect(secondSocket === firstSocket, "INDEPENDENT_OPERATIONS_HAVE_DISTINCT_UPSTREAM_SOCKETS").toBe(false);
    expect(reused).toBe(false);
  } finally {
    restoreEnd?.(); proxy.stop(); agent.destroy();
    await second?.catch(() => {}); requestSpy.mockRestore();
    for (const socket of peers) socket.destroy();
    await new Promise<void>(resolve => origin.close(() => resolve()));
  }
});

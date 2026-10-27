import { expect, test } from "bun:test";
import { globalAgent } from "node:http";
import { Socket } from "node:net";
import type { HttpContractApp } from "./helpers/http-contract-app";
import { closeHttpMountFixture, httpMountAgentKey } from "./helpers/http-mount-pool";

test("mount disposal joins a destroyed socket until native close completes", async () => {
  const fixture = {
    app: { config: { nativeBrain: { socketPath: `/tmp/odysseus-delayed-close-${process.pid}.sock` } } },
    async close() {},
  } as unknown as HttpContractApp;
  const key = httpMountAgentKey(fixture);
  expect(Object.getOwnPropertyDescriptor(globalAgent.sockets, key)).toBeUndefined();
  class DeferredSocket extends Socket {
    override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
      setImmediate(() => super._destroy(error, callback));
    }
  }
  const socket = new DeferredSocket();
  const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
  Object.defineProperty(globalAgent.sockets, key, { configurable: true, value: [socket] });
  try {
    socket.destroy();
    expect(socket.destroyed).toBe(true);
    expect(socket.closed).toBe(false);
    await closeHttpMountFixture(fixture);
    expect(socket.closed, "MOUNT_DISPOSAL_JOINS_NATIVE_CLOSE").toBe(true);
  } finally {
    socket.destroy();
    await closed;
    Reflect.deleteProperty(globalAgent.sockets, key);
  }
});

for (const rejectClose of [false, true]) test(`mount disposal joins real owned Unix HTTP connections created during ${rejectClose ? "rejected" : "successful"} fixture close`, async () => {
  const closeFailure = new Error("controlled close refusal after native stop");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { request } = await import("node:http");
  const { observeMountTimers } = await import("./helpers/http-mount-timers");
  const root = mkdtempSync(join(tmpdir(), "odysseus-late-mount-"));
  const socketPath = join(root, "native.sock");
  const server = Bun.serve({ unix: socketPath, fetch: () => new Response("ready") });
  const owned = new Set<Socket>();
  const closed: Promise<void>[] = [];
  const timers = observeMountTimers();
  const fixture = { app: { config: { nativeBrain: { socketPath } } }, async close() {
    await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
      const req = request({ socketPath, path: "/" }, res => { res.resume(); res.once("end", resolve); });
      req.once("socket", socket => {
        owned.add(socket);
        closed.push(new Promise<void>(done => socket.once("close", () => done())));
      });
      req.once("error", reject); req.end();
    })));
    // This is actual native cancellation, not an artificial delayed close.
    // Even its returned server-stop promise does not join client close events.
    await server.stop(true);
    if (rejectClose) throw closeFailure;
  } } as unknown as HttpContractApp;
  timers.own(fixture);
  try {
    expect(globalAgent.sockets[httpMountAgentKey(fixture)] ?? []).toHaveLength(0);
    let failure: unknown;
    try { await closeHttpMountFixture(fixture); } catch (error) { failure = error; }
    expect(failure).toBe(rejectClose ? closeFailure : undefined);
    expect(owned.size).toBe(6);
    timers.expectEmpty("late-owned-connections-after-fixture-close");
    expect([...owned].every(socket => socket.closed), "LATE_OWNED_NATIVE_SOCKETS_CLOSED_AT_DISPOSAL_BOUNDARY").toBe(true);
  } finally {
    try { await server.stop(true); }
    finally {
      try {
        for (const socket of owned) socket.destroy();
        await Promise.all(closed);
      } finally {
        try { timers.restore(); }
        finally { rmSync(root, { recursive: true, force: true }); }
      }
    }
  }
});

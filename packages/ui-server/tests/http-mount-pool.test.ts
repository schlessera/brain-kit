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

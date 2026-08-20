/**
 * The SDK client against a real `createApp()`, over a real socket (F3 / W4).
 *
 * ROADMAP has carried "no end-to-end test drives the auth boot refusal through
 * a real socket" as a known gap since the security review. It stayed open
 * because the only client was a React hook: exercising the protocol meant
 * standing up a browser. `BrainUiClient` runs on the platform WebSocket, which
 * Bun has, so this is now an ordinary test.
 *
 * It is also the first thing that would catch a client/server protocol drift.
 * Every other test in this repo asserts one side against a fixture of what the
 * other side is believed to send; this one puts the two shipped
 * implementations on opposite ends of a socket.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { BrainUiClient, type ServerMessage } from "@schlessera/brain-ui-sdk/client";

import { createApp } from "../../src/app";
import { createRecordingObservability } from "../../src/observability/index";
import { resolveServerConfig } from "../../src/config/env";
import { createStaticBackendRegistry } from "../../src/agent/backend";
import { makeFakeBackend } from "../helpers/fake-backend";

interface Running {
  server: ReturnType<typeof Bun.serve>;
  app: ReturnType<typeof createApp>;
  url: string;
}

const running: Running[] = [];
afterEach(() => {
  while (running.length) {
    const r = running.pop()!;
    r.server.stop(true);
    r.app.close();
  }
});

/** Boot a real app on an ephemeral port, loopback so AUTH_MODE=none is legal. */
function start(env: Record<string, string> = {}) {
  const observability = createRecordingObservability();
  const backend = makeFakeBackend({ id: "fake" });
  const config = resolveServerConfig({
    AUTH_MODE: "none",
    HOST: "127.0.0.1",
    DB_PATH: ":memory:",
    BRAIN_PATH: "/tmp/brain-real-socket-test",
    ...env,
  });
  const app = createApp({
    config,
    dbPath: ":memory:",
    observability,
    registry: createStaticBackendRegistry([backend], backend.id),
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: app.fetch,
    websocket: app.websocket,
  });
  const entry: Running = {
    server,
    app,
    url: `ws://127.0.0.1:${server.port}/ws`,
  };
  running.push(entry);
  return { ...entry, observability };
}

/** Connect and collect frames until `until` is satisfied or the budget lapses. */
function connect(url: string) {
  const frames: ServerMessage[] = [];
  const client = new BrainUiClient({
    url,
    handlers: { onAny: (f) => frames.push(f) },
  });
  client.connect();

  return {
    client,
    frames,
    async waitFor(predicate: (frames: ServerMessage[]) => boolean, budgetMs = 3000) {
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline) {
        if (predicate(frames)) return true;
        await Bun.sleep(20);
      }
      return false;
    },
  };
}

describe("a real client on a real socket", () => {
  test("completes the rev-2 handshake the client half now reads", async () => {
    const { url } = start();
    const { client, waitFor } = connect(url);

    const arrived = await waitFor((f) => f.some((m) => m.type === "server_hello"));
    expect(arrived).toBe(true);

    // The whole point of W2: protocolRev stops being advisory.
    expect(client.protocolRev).toBe(2);
    expect(typeof client.capabilities).toBe("object");
    client.close();
  });

  test("every frame the server sends passes the client's own validation", async () => {
    // The drift check. If the server emits a shape the schemas do not allow,
    // it lands as a protocol error rather than a frame.
    const errors: string[] = [];
    const { url } = start();
    const frames: ServerMessage[] = [];
    const client = new BrainUiClient({
      url,
      handlers: { onAny: (f) => frames.push(f) },
      onProtocolError: (e) => errors.push(`${e.reason}: ${e.detail}`),
    });
    client.connect();

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && frames.length === 0) await Bun.sleep(20);

    expect(frames.length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    client.close();
  });

  test("a malformed client frame is refused, answered, and counted", async () => {
    // The server-side loop, end to end: the rejection reaches the client as an
    // error frame AND lands on the counter /api/status serves.
    const { url, observability } = start();
    const frames: ServerMessage[] = [];
    const client = new BrainUiClient({ url, handlers: { onAny: (f) => frames.push(f) } });
    client.connect();

    const open = Date.now() + 3000;
    while (Date.now() < open && !client.isConnected) await Bun.sleep(20);
    expect(client.isConnected).toBe(true);

    // Bypass `send`, which would only accept a well-formed ClientMessage.
    (client as unknown as { ws: WebSocket }).ws.send("{not json");

    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline &&
      !frames.some((f) => f.type === "error" && f.code === "PARSE_ERROR")
    ) {
      await Bun.sleep(20);
    }

    expect(frames.some((f) => f.type === "error" && f.code === "PARSE_ERROR")).toBe(true);
    expect(
      observability.metrics.value("ws.frames.dropped", {
        reason: "parse_error",
        direction: "inbound",
      })
    ).toBe(1);
    client.close();
  });
});

describe("auth refuses to boot through a real socket", () => {
  test("AUTH_MODE=none on a non-loopback host refuses to start", () => {
    // The ROADMAP gap. Previously asserted only against the validator; this
    // drives the same path createApp takes on a real deployment.
    expect(() =>
      start({ HOST: "0.0.0.0", AUTH_MODE: "none" })
    ).toThrow(/refuses to start/);
  });

  test("the refusal is bypassable only by the documented escape hatch", () => {
    const { observability } = start({
      HOST: "0.0.0.0",
      AUTH_MODE: "none",
      BRAIN_UI_DANGEROUSLY_DISABLE_AUTH: "1",
    });

    // And when bypassed, it says so loudly enough that a log threshold cannot
    // hide it — ERROR, not WARN.
    expect(
      observability.logs.count({ scope: "auth", severity: "ERROR" })
    ).toBe(1);
  });
});

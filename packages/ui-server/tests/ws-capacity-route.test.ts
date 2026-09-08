import { afterEach, describe, expect, test } from "bun:test";

import { createStaticBackendRegistry } from "../src/agent/backend";
import { createApp, type BrainUiApp } from "../src/app";
import { resolveServerConfig } from "../src/config/env";
import { createRecordingObservability } from "../src/observability/index";
import type { WSContext } from "../src/ws/clients";
import { makeFakeBackend } from "./helpers/fake-backend";

let app: BrainUiApp | undefined;

afterEach(() => {
  app?.close();
  app = undefined;
});

describe("the /ws route at connection capacity", () => {
  test("refuses over HTTP before asking Bun to upgrade the connection", async () => {
    const observability = createRecordingObservability();
    const backend = makeFakeBackend({ id: "fake" });
    const config = resolveServerConfig({
      AUTH_MODE: "none",
      HOST: "127.0.0.1",
      DB_PATH: ":memory:",
      BRAIN_PATH: "/tmp/brain-ws-capacity-route-test",
      BRAIN_UI_MODEL_DISCOVERY: "0",
      BRAIN_UI_PRICING_DISCOVERY: "0",
      BRAIN_UI_WS_MAX_CONNECTIONS: "1",
    });
    app = createApp({
      config,
      observability,
      registry: createStaticBackendRegistry([backend], backend.id),
    });
    const admitted: WSContext = { send() {} };
    expect(app.wsHost.clients.add(admitted)).toBe(true);

    let upgradeCalled = false;
    const response = await app.fetch(
      new Request("http://localhost/ws", {
        headers: {
          connection: "Upgrade",
          host: "localhost",
          origin: "http://localhost",
          upgrade: "websocket",
        },
      }),
      {
        server: {
          upgrade() {
            upgradeCalled = true;
            return true;
          },
        },
      }
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toStartWith("text/plain");
    expect(await response.text()).toBe("WebSocket connection limit reached");
    expect(upgradeCalled).toBe(false);
    expect(
      observability.metrics.value("ws.connections.refused", {
        reason: "connection_limit",
      })
    ).toBe(1);
    expect(
      observability.logs.count({
        scope: "ws",
        severity: "WARN",
        body: "websocket connection refused",
      })
    ).toBe(1);
  });
});

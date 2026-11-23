/** Keyless turn path: real socket parser, host/coordinator, lifecycle and receipt storage. */
import { workerHostBoundary } from "../../../ui-sdk/src/server/worker-launcher.js";
// The fixture backend has no worker process; native containment has its own proof.
workerHostBoundary.probe = () => ({ ok: true });
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteWriter } from "../../../ui-server/src/db/write-worker.js";
import { createModelPricing } from "../../../ui-server/src/pricing/model-pricing.js";
import { createUiDb } from "../../../ui-server/src/db/client.js";
import { createActivityRuntime } from "../../../ui-server/src/activity/runtime.js";
import { createStaticBackendRegistry } from "../../../ui-server/src/agent/backend.js";
import { createSessionCatalog } from "../../../ui-server/src/ws/session-catalog.js";
import { createWsHandlers } from "../../../ui-server/src/ws/connection.js";
import { WsHost } from "../../../ui-server/src/ws/host.js";
import type { WSContext } from "../../../ui-server/src/ws/clients.js";
import { makeFakeBackend } from "../../../ui-server/tests/helpers/fake-backend.js";
import { testPrincipal } from "../../../ui-server/tests/helpers/principal.js";
import type { Logger } from "@opentelemetry/api-logs";

const temporary = mkdtempSync(join(tmpdir(), "client-turn-ithaca-"));
const db = createUiDb(join(temporary, "ui.db"));
const writer = openSqliteWriter(db);
const pricingConfig = { brainPath: temporary, enabled: false };
const pricing = createModelPricing(pricingConfig);
const log = { emit() {} } as unknown as Logger;
const activity = createActivityRuntime(db, { log, writer, pricing, pricingConfig });
let release: (() => void) | undefined;
let earlyIdleHeld = false, reportsReceived = 0;
const drained = new Set<string>();
const backend = makeFakeBackend({ id: "odyssey", startTurn: async request => {
  const sessionId = request.sessionId ?? "ithaca";
  request.bridge.emit({ type: "session_info", sessionId, isNew: !request.sessionId, providerId: "odyssey" });
  if (request.prompt === "Hold the voyage") await new Promise<void>(resolve => { release = resolve; });
  else await Bun.sleep(250); // Deliberate product-input delay, observed in the client's frame-arrival pair.
  request.bridge.emit({ type: "thinking_delta", text: "Check the winds", sessionId });
  request.bridge.emit({ type: "text_delta", text: "Sail at dawn", sessionId });
  // Both production backends emit an early idle; a backend cannot spoof host completion.
  request.bridge.emit({ type: "status", status: "idle", hostTurnComplete: true, sessionId });
  request.bridge.emit({ type: "result", sessionId, outcome: "success", costUsd: 0, durationMs: 250, numTurns: 1, isError: false });
  if (request.prompt === "Delay host idle") {
    earlyIdleHeld = true;
    await new Promise<void>(resolve => { release = resolve; });
    earlyIdleHeld = false;
  }
} });
const host = new WsHost({ registry: createStaticBackendRegistry([backend], backend.id), catalog: createSessionCatalog(() => db, log, undefined, { pricing, store: activity.store, governance: activity.governanceWrites, writer, pricingConfig }), activity });
type SocketData = { handlers: ReturnType<typeof createWsHandlers>; context: WSContext };
const server = Bun.serve<SocketData>({ hostname: "127.0.0.1", port: 0,
  async fetch(request, server) {
    if (new URL(request.url).pathname === "/ws") {
      const handlers = createWsHandlers(host, testPrincipal("odysseus"));
      if (server.upgrade(request, { data: { handlers } as SocketData })) return;
      return new Response(null, { status: 400 });
    }
    if (request.method === "POST") { release?.(); release = undefined; }
    return Response.json({ lifecycles: activity.store.lifecycles(), held: !!release, earlyIdleHeld, reportsReceived, drained: [...drained] });
  },
  websocket: {
    open(socket) {
      const context: WSContext = { send: data => socket.send(data), close: (code, reason) => socket.close(code, reason), raw: socket };
      socket.data.context = context;
      void socket.data.handlers.onOpen(undefined as never, context);
    },
    message(socket, data) {
      const message = JSON.parse(String(data));
      if (message.type === "client_turn_receipt") reportsReceived++;
      if (message.type === "ping" && typeof message.probeId === "string") drained.add(message.probeId);
      socket.data.handlers.onMessage({ data: String(data) } as MessageEvent, socket.data.context); },
    close(socket, code, reason) { socket.data.handlers.onClose({ code, reason } as CloseEvent, socket.data.context); },
  },
});
process.on("SIGTERM", async () => {
  release?.(); await host.close(); await activity.close(); await writer.close(); db.close(); server.stop(true); rmSync(temporary, { recursive: true, force: true }); process.exit(0);
});
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));

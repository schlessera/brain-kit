import { workerHostBoundary } from "../../../ui-sdk/src/server/worker-launcher.js";
/** Real GPT-Live adapter/host with a loopback upstream and in-process fake agent. */
import { createGptLiveConversationProvider } from "../../../ui-server/src/voice/gpt-live-conversation.js";
import { createStaticBackendRegistry } from "../../../ui-server/src/agent/backend.js";
import { createUiDb } from "../../../ui-server/src/db/client.js";
import { createWsHandlers } from "../../../ui-server/src/ws/connection.js";
import { WsHost } from "../../../ui-server/src/ws/host.js";
import { createSessionCatalog } from "../../../ui-server/src/ws/session-catalog.js";
import { makeFakeBackend } from "../../../ui-server/tests/helpers/fake-backend.js";
import { testPrincipal } from "../../../ui-server/tests/helpers/principal.js";
import type { WSContext } from "../../../ui-server/src/ws/clients.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
const sent: Record<string, unknown>[] = [];
let remote: Bun.ServerWebSocket<undefined> | undefined;
let silence: ReturnType<typeof setInterval> | undefined;
const upstream = Bun.serve<undefined>({ hostname: "127.0.0.1", port: 0,
  fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); },
  websocket: { open(ws) { remote = ws; }, message(ws, bytes) {
    const frame = JSON.parse(String(bytes)); sent.push(frame);
    if (frame.type === "session.start") {
      ws.send(JSON.stringify({ type: "session.started", session: { id: "ithaca-live", model: "gpt-live-1", store: false } }));
      // GPT-Live keeps transporting silence between replies, without output-done.
      // Paced 100 ms PCM chunks share the adapter's one output ID for the epoch.
      silence = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "session.output_audio.delta", delta: Buffer.alloc(4800).toString("base64") })); }, 100);
    }
    if (frame.type === "session.close") { clearInterval(silence); ws.send(JSON.stringify({ type: "session.closed", reason: "close_requested" })); }
  }, close() { clearInterval(silence); } },
});
const NativeWebSocket = WebSocket as unknown as new (url: string, options?: Bun.WebSocketOptions) => WebSocket;
Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class extends NativeWebSocket {
  constructor(_url: string, options?: Bun.WebSocketOptions) { super(`ws://127.0.0.1:${upstream.port}`, options); }
} });
// The fake backend runs in-process; replace only the external-worker probe.
// This proves conversation transport/lifecycle, never worker containment.
workerHostBoundary.probe = () => ({ ok: true });
const db = createUiDb(":memory:");
const backend = makeFakeBackend({ id: "fake", startTurn: async req => {
  req.bridge.emit({ type: "session_info", sessionId: "odysseus-ithaca", isNew: true });
  req.bridge.emit({ type: "text_delta", text: "The departure note is ready." });
  req.bridge.emit({ type: "result", sessionId: "odysseus-ithaca", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
} });
const reviewedProvider = createGptLiveConversationProvider("keyless-odyssey-placeholder");
reviewedProvider.capabilities = { ...reviewedProvider.capabilities, contextualTasks: "unsupported" };
// This is a known-chat / missing-native-task-ID control, not a stale chat.
const catalog = createSessionCatalog(() => db);
catalog.persistSessionStub("odysseus-ithaca", "Odysseus prepares the voyage.", null, backend.id);
await catalog.settled?.();
if (!catalog.hasSession!("odysseus-ithaca")) throw new Error("Known-chat fixture was not registered");
const host = new WsHost({ registry: createStaticBackendRegistry([backend], "fake"), catalog, conversationProvider: reviewedProvider });
const handlers = createWsHandlers(host, testPrincipal());
const frames: ServerMessage[] = [];
const ws = { send: (data: string) => frames.push(JSON.parse(data)) } as WSContext;
await handlers.onOpen(undefined as never, ws);
frames.length = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const body = await req.json() as { client: unknown[]; provider: unknown[] };
  for (const frame of body.client) handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);
  // Let the real adapter receive the preceding microphone commands first.
  await Bun.sleep(20);
  for (const frame of body.provider) remote!.send(JSON.stringify(frame));
  await Bun.sleep(20);
  return Response.json({ frames: frames.splice(0), sent: sent.splice(0) });
} });
process.on("SIGTERM", () => { clearInterval(silence); host.coordinator.reset(); host.close(); db.close(); remote?.close(); upstream.stop(true); server.stop(true); process.exit(0); });
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));

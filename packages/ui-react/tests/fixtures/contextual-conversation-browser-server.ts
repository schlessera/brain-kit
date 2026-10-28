/** #3070: real adapters/host/application policy with scripted inference and synthetic PCM.
 * A release barrier, not elapsed time, keeps the actual backend task pending. */
import { workerHostBoundary } from "../../../ui-sdk/src/server/worker-launcher.js";
// In-process scripted inference has no external worker; containment is separate proof.
workerHostBoundary.probe = () => ({ ok: true });
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGeminiConversationProvider } from "../../../ui-server/src/voice/gemini-conversation.js";
import { createGptLiveConversationProvider } from "../../../ui-server/src/voice/gpt-live-conversation.js";
import { createClaudeBackend } from "../../../ui-backend-claude/src/backend.js";
import { createStaticBackendRegistry } from "../../../ui-server/src/agent/backend.js";
import { createUiDb } from "../../../ui-server/src/db/client.js";
import { createWsHandlers } from "../../../ui-server/src/ws/connection.js";
import { WsHost } from "../../../ui-server/src/ws/host.js";
import { createSessionCatalog } from "../../../ui-server/src/ws/session-catalog.js";
import { boundaryPlanner } from "../../../ui-server/src/brain/application.js";
import { createNativeAppFixture } from "../../../ui-server/tests/helpers/native-app-fixture.js";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createHostBoundary } from "../../../ui-server/src/brain/host-boundary.js";
import { makeFakeBackend } from "../../../ui-server/tests/helpers/fake-backend.js";
import { testPrincipal } from "../../../ui-server/tests/helpers/principal.js";
import type { WSContext } from "../../../ui-server/src/ws/clients.js";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
const engine = process.argv[2] === "gemini" ? "gemini" : "gpt";
const action = process.argv[3] ?? "permitted";
const root = mkdtempSync(join(tmpdir(), "odysseus-context-task-"));
cpSync(resolve("packages/core/fixtures/corpus"), root, { recursive: true });
writeFileSync(join(root, "brain.config.ts"), readFileSync(join(root, "brain.config.ts"), "utf8").replace('"@schlessera/brain"', JSON.stringify(resolve("packages/core/src/index.ts"))));
writeFileSync(join(root, "notes/departure-signal.md"), "---\ntitle: Departure signal\ntype: note\n---\nThe departure signal is a bronze owl.\n");
let released = false;
let release!: () => void;
const barrier = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
const tasks: Array<{ prompt: string; started: boolean; completed: boolean; read?: string; captured?: unknown; applied?: unknown }> = [];
const sent: Record<string, any>[] = [];
let remote: Bun.ServerWebSocket<undefined> | undefined;
const upstream = Bun.serve<undefined>({ hostname: "127.0.0.1", port: 0,
  fetch(req, server) { if (server.upgrade(req)) return; return new Response(null, { status: 400 }); },
  websocket: { open(ws) { remote = ws; }, message(ws, bytes) {
    const m = JSON.parse(String(bytes)); sent.push(m);
    if (m.setup) ws.send(JSON.stringify({ setupComplete: {} }));
    if (m.type === "session.start") ws.send(JSON.stringify({ type: "session.started", session: { id: "ithaca-live", model: "gpt-live-1", store: false, delegation: { type: "client" } } }));
    if (m.type === "session.thinking.append" || m.type === "session.commentary.append") {
      ws.send(JSON.stringify({ type: m.type + "ed", event_id: crypto.randomUUID(), client_event_id: m.event_id, start_ms: 3000, end_ms: 3000 }));
    }
    if (m.type === "session.close") ws.send(JSON.stringify({ type: "session.closed", reason: "close_requested" }));
  } },
});
const NativeWebSocket = WebSocket as unknown as new (url: string, options?: Bun.WebSocketOptions) => WebSocket;
Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class extends NativeWebSocket {
  constructor(_url: string, options?: Bun.WebSocketOptions) { super(`ws://127.0.0.1:${upstream.port}`, options); }
} });
const state = mkdtempSync(join(tmpdir(), "odysseus-context-state-"));
const db = createUiDb(":memory:");
const native = createNativeAppFixture(root);
const production = createClaudeBackend({ brainPath: root, allowedTools: ["Read", "mcp__brain-ui__brain_add", ...(action === "permitted" ? ["mcp__brain-ui__write_file"] : [])] });
const backend = makeFakeBackend({ id: "fake", capabilities: { permissions: true }, startTurn: async req => {
  const task: typeof tasks[number] = { prompt: req.prompt, started: true, completed: false }; tasks.push(task);
  req.bridge.emit({ type: "session_info", sessionId: "odysseus-ithaca", isNew: !req.sessionId });
  // The same bridge and production policy as a typed task, never a voice executor.
  task.read = (await req.bridge.readBrainBase!("notes/departure-signal.md")).content;
  await barrier;
  if (req.signal.aborted) return;
  task.applied = await req.bridge.applyBrain!({ operation: "write", path: tasks.length === 1 ? "notes/contextual-raft.md" : `notes/contextual-raft-${tasks.length}.md`, content: "Odysseus repairs the raft.\n", expectedBaseHash: null });
  req.bridge.emit({ type: "text_delta", text: task.read + " The host task has finished." });
  req.bridge.emit({ type: "result", sessionId: "odysseus-ithaca", outcome: "success", isError: false, durationMs: 1, numTurns: 1 });
  task.completed = true;
} });
backend.brainApplicationPolicy = production.brainApplicationPolicy;
const host = new WsHost({ brainPath: root, registry: createStaticBackendRegistry([backend], "fake"), catalog: createSessionCatalog(() => db),
  applicationPlanner: boundaryPlanner(createHostBoundary({ brainPath: root, dbPath: join(state, "ui.db"), nativeManager: createNativeBrainManagerClient(native.nativeBrain) })), isPrincipalAuthorized: () => true,
  conversationProvider: engine === "gemini" ? createGeminiConversationProvider("keyless-odyssey-placeholder") : createGptLiveConversationProvider("keyless-odyssey-placeholder") });
const handlers = createWsHandlers(host, testPrincipal());
const frames: ServerMessage[] = [];
const ws = { send: (data: string) => frames.push(JSON.parse(data)) } as WSContext;
await handlers.onOpen(undefined as never, ws); frames.length = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  const body = await req.json() as { client: unknown[]; provider: unknown[]; release?: boolean };
  for (const frame of body.client) handlers.onMessage({ data: JSON.stringify(frame) } as MessageEvent, ws);
  await Bun.sleep(10); // transport drain only; task completion requires the explicit barrier
  for (const frame of body.provider) remote!.send(JSON.stringify(frame));
  if (body.release) release();
  await Bun.sleep(10);
  return Response.json({ frames: frames.splice(0), sent: sent.splice(0), tasks, released, effect: existsSync(join(root, "notes/contextual-raft.md")) });
} });
process.on("SIGTERM", async () => { release(); host.coordinator.reset(); host.close(); db.close(); await native.close(); remote?.close(); upstream.stop(true); server.stop(true); rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); process.exit(0); });
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));

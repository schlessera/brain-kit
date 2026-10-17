/** Real managed-server admission and native SDK turn; explicit fictional API profile. */
import { expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../../ui-server/src/app.js";
import { resolveServerConfig } from "../../../ui-server/src/config/env.js";
import { createStaticBackendRegistry } from "../../../ui-server/src/agent/backend.js";
import { createRecordingObservability } from "../../../ui-server/src/observability/index.js";
import { createPrincipal } from "../../../ui-server/src/db/principals.js";
import { createClaudeBackend } from "../../../ui-backend-claude/src/backend.js";
import { nativeModelReply } from "../../../ui-backend-claude/tests/helpers/native-model-reply.js";
import { serializeSigned } from "hono/utils/cookie";

const profile = new URL(import.meta.url).searchParams.get("profile") === "strict" ? "strict" : "governed";
const brain = "/brain-fixture/brain", root = profile === "strict" ? "/identity-server-private/server-ws-strict" : "/identity-server-private/server-ws";
const home = join(root, "home"), config = join(home, ".claude"), data = root;
mkdirSync(data, { mode: 0o700 }); mkdirSync(config, { recursive: true, mode: 0o700 });
const requests: Array<{ model: string; history: number; apiCredential: boolean }> = [];
// Native worker calls this loopback provider directly. The outer Docker network
// namespace has no external route; no fetch implementation or native SDK is mocked.
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json() as { model: string; messages: unknown[] };
  requests.push({ model: body.model, history: body.messages.length, apiCredential: request.headers.get("x-api-key") === "odysseus-fictional-api-key" });
  return nativeModelReply();
} });
const backend = createClaudeBackend({ brainPath: brain, profiles: [{ id: "odysseus-haiku", label: "Odysseus Haiku", billing: "api",
  requiredEnvKeys: [], model: "claude-haiku-4-5", buildEnv: () => ({ ANTHROPIC_BASE_URL: provider.url.origin,
    ANTHROPIC_API_KEY: "odysseus-fictional-api-key", HOME: home, CLAUDE_CONFIG_DIR: config, PATH: "/usr/local/bin:/usr/bin:/bin",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" }) }], log() {} });
const backendProfiles: Array<string | undefined> = [];
const observedBackend = { ...backend, startTurn(request: Parameters<typeof backend.startTurn>[0]) {
  backendProfiles.push(request.workerSandbox?.profile);
  return backend.startTurn(request);
} };
const observability = createRecordingObservability(), secret = "odysseus-fixture-cookie-secret-0123456789";
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let socket: WebSocket | undefined;
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 30000;
  while (!check()) { if (Date.now() > deadline) throw Error(label); await Bun.sleep(10); }
}
try {
  if (profile === "governed") {
    const { captureMaintenanceStage } = await import("../maintenance-stage-provenance.native.js");
    await captureMaintenanceStage(brain);
  }
  app = await createApp({ workerProfile: profile, config: resolveServerConfig({ AUTH_MODE: "password", BRAIN_UI_PASSWORD_HASH: "fixture-hash", COOKIE_SECRET: secret,
    HOST: "127.0.0.1", DB_PATH: join(data, "ui.db"), BRAIN_PATH: brain, NODE_ENV: "test", AGENT_BACKEND: "claude",
    BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_COASTLINE: "0", BRAIN_UI_TURN_TIMEOUT_MS: "30000",
    BRAIN_UI_NATIVE_BRAIN_SOCKET: "/native-runtime/server-ws-manager.sock" }), registry: createStaticBackendRegistry([observedBackend], "claude"), observability });
  const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus inference", ttlSeconds: 3600 });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
  const cookie = await serializeSigned("brain_ui_session", principal.id, secret), frames: Array<Record<string, unknown>> = [];
  const NativeWebSocket = WebSocket as unknown as { new(url: string, options: { headers: Record<string, string> }): WebSocket };
  socket = new NativeWebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie, origin: `http://127.0.0.1:${server.port}` } });
  socket.addEventListener("message", event => frames.push(JSON.parse(String(event.data))));
  await until(() => frames.some(frame => frame.type === "server_hello"), "REAL_SERVER_HELLO");
  socket.send(JSON.stringify({ type: "client_hello", protocolRev: 3, capabilities: { followUpQueue: true } }));
  socket.send(JSON.stringify({ type: "chat_message", text: "Plan the return to Ithaca.", providerId: "odysseus-haiku", requestId: "ithaca-ordinary" }));
  await until(() => frames.some(frame => frame.type === "result" || frame.type === "error"), "REAL_SERVER_NATIVE_TERMINAL");
  await until(() => !app!.wsHost.coordinator.isTurnActive(), "REAL_SERVER_RELEASED_TURN");
  const admittedProfiles = app.db.query("SELECT profile FROM turn_governance_policy").all();
  // #2300 currently refuses governed maintenance qualification, so the real
  // requested-governed app admits strict. Keep that residual explicit rather
  // than claiming the requested profile proves actual governed admission.
  expect(admittedProfiles, "ACTUAL_MANAGED_WS_SELECTED_PROFILE").toEqual([{ profile: "strict" }]);
  expect(backendProfiles, "ACTUAL_MANAGED_WS_BACKEND_SANDBOX").toEqual(["strict"]);
  if (profile === "governed") expect(observability.logs.records().some(log => String(log.body).includes("credential-free maintenance worker could not start")), "KNOWN_2300_GOVERNED_FALLBACK_DISCLOSED").toBe(true);
  console.log(JSON.stringify({ profile, admittedProfiles, backendProfiles, requests, terminal: frames.filter(frame => frame.type === "result" || frame.type === "error"),
    limitations: observability.logs.records().filter(log => log.severity === "WARN" || String(log.body).includes("governed profile is unavailable")).map(log => log.body) }));
  expect(requests, "ACTUAL_MANAGED_WS_NATIVE_REQUEST").toEqual([{ model: "claude-haiku-4-5", history: 1, apiCredential: true }]);
  expect(frames.some(frame => frame.type === "result" && frame.outcome === "success"), "ACTUAL_MANAGED_WS_NATIVE_RESULT").toBe(true);
  expect(frames.some(frame => frame.type === "error"), "ACTUAL_MANAGED_WS_ADMISSION_NO_ERROR").toBe(false);
  const unavailable = observability.logs.records().filter(log => String(log.body).includes("the governed profile is unavailable"));
  if (profile === "governed") expect(unavailable, "ACTUAL_MANAGED_GOVERNED_MAINTENANCE_STAGE_READY").toEqual([]);
} finally { socket?.close(); server?.stop(true); await app?.close(); provider.stop(true); }

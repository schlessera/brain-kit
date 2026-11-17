/**
 * A raw, unclassified shell connection to GitHub's API keeps its `Network`
 * approval card (#3791 ruling 2, #3799). The card must reach the client and
 * name what is waiting; allowing admits the held connection, declining
 * refuses it with a reason the tool sees, and stopping the turn cancels it.
 * A card raised while no client is connected is held and delivered to the
 * next client that connects.
 *
 * Every case runs the real app: the WebSocket handlers a browser reaches,
 * governed admission and the turn's own egress proxy. The fixture backend
 * stands in for the agent and opens the worker's `CONNECT` on the proxy
 * socket, where the proxy cannot tell it from a worker's curl. The command
 * is the hosted report's compound shape, which the classifier reads as
 * opaque, so no visible read covers the connection.
 *
 * Keyless and offline: the proxy's dial of `api.github.com:443` is routed to
 * a loopback stand-in at `Socket.prototype.connect`, the shared method the
 * network guard instruments, installed after it and restored in teardown.
 */
import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, Socket } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { observeOutwardPlan, prepareOutwardPlan } from "@schlessera/brain-ui-sdk/internal";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import * as startup from "../../ui-sdk/src/server/worker-startup-view.js";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createFixtureApp as createApp } from "./helpers/native-app-fixture.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createPrincipal } from "../src/db/principals.js";
import { queryGovernanceEvents } from "../src/governance/events.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";

/** The hosted report's command: a compound shell line ending in a raw API read. */
const COMMAND = "cd /srv/ithaca && curl -s https://api.github.com/repos/odysseus/ithaca/issues?per_page=1";
const GITHUB_API = "api.github.com:443";
type Frame = Record<string, unknown> & { type?: string; toolName?: string; toolUseId?: string; turnId?: string };

async function until(check: () => boolean, diagnostic: () => unknown, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error(JSON.stringify(diagnostic())); await Bun.sleep(5); }
}

/** A worker's CONNECT through the turn proxy: the status line it got, or "" when the tunnel closed without one. */
function tunnel(socketPath: string, target: string): Promise<string> {
  return new Promise((done, reject) => {
    const socket = connect(socketPath); let text = "";
    socket.on("connect", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on("data", data => { text += data; if (text.startsWith("HTTP/1.1 200")) socket.destroy(); });
    socket.on("close", () => done(text)); socket.on("error", reject);
  });
}

/** Route the proxy's dial of GitHub's API to a loopback stand-in that counts the tunnels it receives. */
function githubStandIn() {
  let reached = 0;
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() { reached++; }, data() {} } });
  const descriptor = Object.getOwnPropertyDescriptor(Socket.prototype, "connect")!;
  const original = descriptor.value as (...args: unknown[]) => Socket;
  Object.defineProperty(Socket.prototype, "connect", { ...descriptor, value: function routedConnect(this: Socket, ...args: unknown[]) {
    // Bun's factories pass a marked, normalized [options, callback] array; a
    // copy loses the mark, so the options the proxy built are rewritten in place.
    const values = (Array.isArray(args[0]) ? args[0] : args) as unknown[];
    const first = values[0] as { host?: string; port?: unknown } | undefined;
    if (first && typeof first === "object" && first.host === "api.github.com" && Number(first.port) === 443) Object.assign(first, { host: "127.0.0.1", port: server.port });
    return Reflect.apply(original, this, args);
  } });
  return { reached: () => reached, stop() { Object.defineProperty(Socket.prototype, "connect", descriptor); server.stop(true); } };
}

interface TurnSeen { request: StartTurnRequest; head: string }

/** A governed app whose fixture turn opens the raw GitHub API connection once `release` resolves. */
async function hostedApp(release: () => Promise<void> = async () => {}) {
  const storage = spyOn(startup, "isManagedWorkerStartupView").mockReturnValue(true);
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-github-network-")), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  await mkdir(resolve(brain, "context/policies"), { recursive: true });
  await writeFile(resolve(brain, "context/policies/governance.md"), "---\nschema_version: 1\nprofiles: { interactive: governed, voice: governed }\n---\nAthena reviews outward calls.\n");
  const github = githubStandIn(), seen: TurnSeen[] = [];
  const backend = makeFakeBackend({ id: "claude", startTurn: async request => {
    await request.bridge.inputSafety!.ready("claude", 1);
    const sessionId = request.sessionId ?? `ithaca-${seen.length}`, toolUseId = `curl-${seen.length}`;
    request.bridge.emit({ type: "session_info", sessionId, isNew: !request.sessionId });
    request.bridge.emit({ type: "tool_use_start", sessionId, toolUseId, toolName: "Bash" });
    request.bridge.emit({ type: "tool_use_complete", sessionId, toolUseId, toolName: "Bash", input: { command: COMMAND } });
    // The backend's own classification of the call, as each runtime reports it.
    const plan = prepareOutwardPlan({ toolName: "Bash", shellToolName: "Bash", input: { command: COMMAND } });
    expect(plan.classification, "GITHUB_NETWORK_COMMAND_UNCLASSIFIED").toMatchObject({ kind: "unknown", opaque: true });
    observeOutwardPlan(plan, { bridge: request.bridge, toolName: "Bash", toolUseId, input: { command: COMMAND }, decision: { behavior: "allow" } });
    // A real turn's first model request passes the inference relay, which
    // settles the session's safety binding before any tool can run
    // (`settleOperation`, src/brain/turn-egress.ts). This fixture sends no
    // model request, so it waits for the same committed binding.
    await until(() => !!app.db.query("SELECT 1 FROM safety_collections c JOIN safety_sessions s ON s.session_id=c.session_id WHERE c.turn_id=? AND c.session_id=?")
      .get(request.turnId!, sessionId), () => "the session's safety binding never committed");
    await release();
    const head = await tunnel(request.workerSandbox!.egress!.socketPath, GITHUB_API);
    // The connection's record lands when its tunnel closes; the turn ends after it.
    await until(() => records().length === seen.length + 1, () => "the connection was never recorded");
    seen.push({ request, head });
    request.bridge.emit({ type: "tool_result", sessionId, toolUseId, output: head, isError: !head.startsWith("HTTP/1.1 200") });
    request.bridge.emit({ type: "result", sessionId, outcome: "success", durationMs: 1, numTurns: 1, isError: false });
  } });
  const observability = createRecordingObservability();
  const app = await createApp({ config: resolveServerConfig({ BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1", AUTH_MODE: "none", NODE_ENV: "test",
    BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }), registry: createStaticBackendRegistry([backend], backend.id), observability });
  const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus network", ttlSeconds: 60 });
  /** One browser connection through the real WebSocket handlers. */
  const client = async () => {
    const handlers = createWsHandlers(app.wsHost, principal), frames: Frame[] = [];
    const ws = { send: (text: string) => { frames.push(JSON.parse(text) as Frame); }, close() {}, readyState: 1 } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    const send = (message: Record<string, unknown>) => handlers.onMessage({ data: JSON.stringify(message) } as MessageEvent, ws);
    const card = () => frames.find(frame => frame.type === "tool_approval_request" && frame.toolName === "Network");
    return { frames, send, card, close: () => handlers.onClose({ code: 1000 } as CloseEvent, ws),
      answer: (answer: Record<string, unknown>) => { const shown = card()!; send({ toolUseId: shown.toolUseId, turnId: shown.turnId, channel: "card", ...answer }); } };
  };
  const records = () => queryGovernanceEvents(app.db, { kinds: ["egress_connection"], limit: 20 })
    .map(event => event.payload as Record<string, unknown>).filter(payload => payload.host === "api.github.com");
  const finished = (count: number) => until(() => seen.length === count && !app.wsHost.coordinator.isTurnActive(), () => ({ seen, records: records() }));
  return { app, github, seen, client, records, finished, observability,
    async close() { storage.mockRestore(); github.stop(); await app.close(); await rm(root, { recursive: true, force: true }); } };
}

/** The card the client must see: the Network tool, the method and the host, before anything is contacted. */
function expectCard(card: Frame | undefined, reached: number) {
  expect(card, "GITHUB_NETWORK_CARD_REACHES_CLIENT").toBeDefined();
  expect(card, "GITHUB_NETWORK_CARD_NAMES_METHOD_AND_HOST").toMatchObject({ toolName: "Network", kind: "command",
    input: { host: "api.github.com", port: 443, method: "CONNECT" }, description: "CONNECT to api.github.com:443" });
  expect(reached, "GITHUB_NETWORK_CARD_HOLDS_CONNECTION").toBe(0);
}

test("an unclassified api.github.com connection raises the Network card at the live client; allowing admits it", async () => {
  const hosted = await hostedApp();
  try {
    const browser = await hosted.client();
    browser.send({ type: "chat_message", text: "Odysseus counts the open issues.", requestId: "network-allow" });
    await until(() => browser.card() !== undefined || hosted.seen.length > 0, () => browser.frames);
    expectCard(browser.card(), hosted.github.reached());
    expect(browser.frames, "GITHUB_NETWORK_CARD_NAMES_WHAT_WAITS").toContainEqual(expect.objectContaining({ type: "status", status: "tool_executing", detail: "Waiting for approval: Network" }));
    browser.answer({ type: "tool_approval" });
    await hosted.finished(1);
    expect(hosted.seen[0]!.head, "GITHUB_NETWORK_ALLOW_ADMITS").toStartWith("HTTP/1.1 200");
    expect(hosted.github.reached(), "GITHUB_NETWORK_ALLOW_REACHES_GITHUB").toBe(1);
    expect(hosted.records(), "GITHUB_NETWORK_ALLOW_RECORDED").toMatchObject([{ method: "CONNECT", host: "api.github.com", port: 443, outcome: "completed" }]);
  } finally { await hosted.close(); }
}, 60_000);

test("declining the Network card refuses the connection with a reason the tool sees and contacts nothing", async () => {
  const hosted = await hostedApp();
  try {
    const browser = await hosted.client();
    browser.send({ type: "chat_message", text: "Odysseus counts the open issues.", requestId: "network-deny" });
    await until(() => browser.card() !== undefined || hosted.seen.length > 0, () => browser.frames);
    expectCard(browser.card(), hosted.github.reached());
    browser.answer({ type: "tool_denial", message: "Penelope declines." });
    await hosted.finished(1);
    expect(hosted.seen[0]!.head, "GITHUB_NETWORK_DENY_REFUSES").toStartWith("HTTP/1.1 403 Forbidden - outward connection not approved\r\n");
    expect(hosted.seen[0]!.head, "GITHUB_NETWORK_DENY_REASON_VISIBLE").toContain("Blocked: a connection to api.github.com acts outside the brain in the user's name, and it was not approved.");
    expect(hosted.github.reached(), "GITHUB_NETWORK_DENY_NO_CONTACT").toBe(0);
    expect(hosted.records(), "GITHUB_NETWORK_DENY_RECORDED").toMatchObject([{ method: "CONNECT", host: "api.github.com", outcome: "denied", reason: "outward_not_approved", bytes: 0 }]);
  } finally { await hosted.close(); }
}, 60_000);

test("stopping the turn while the Network card waits cancels the connection, withdraws the card and contacts nothing", async () => {
  const hosted = await hostedApp();
  try {
    const browser = await hosted.client();
    browser.send({ type: "chat_message", text: "Odysseus counts the open issues.", requestId: "network-stop" });
    await until(() => browser.card() !== undefined || hosted.seen.length > 0, () => browser.frames);
    expectCard(browser.card(), hosted.github.reached());
    const sessionId = browser.frames.find(frame => frame.type === "session_info")?.sessionId;
    browser.send({ type: "cancel", ...(typeof sessionId === "string" ? { sessionId } : {}) });
    await hosted.finished(1);
    expect(hosted.seen[0]!.head, "GITHUB_NETWORK_STOP_CANCELS").not.toStartWith("HTTP/1.1 200");
    expect(hosted.app.wsHost.coordinator.pendingApprovals.size, "GITHUB_NETWORK_STOP_WITHDRAWS_CARD").toBe(0);
    // A late answer to the withdrawn card admits nothing.
    browser.answer({ type: "tool_approval" });
    // Negative window, kept real time: a dial the late answer started would
    // reach the loopback stand-in after the refusal, and no frame on that
    // path can mark its absence. 50 ms gives such a connection its chance.
    await Bun.sleep(50);
    expect(hosted.github.reached(), "GITHUB_NETWORK_STOP_NO_CONTACT").toBe(0);
    expect(hosted.records(), "GITHUB_NETWORK_STOP_RECORDED").toMatchObject([{ method: "CONNECT", host: "api.github.com", outcome: "cancelled", bytes: 0 }]);
  } finally { await hosted.close(); }
}, 60_000);

test("a Network card raised while no client is connected is held and delivered to the next client that connects", async () => {
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const hosted = await hostedApp(() => gate);
  try {
    const away = await hosted.client();
    away.send({ type: "chat_message", text: "Odysseus counts the open issues.", requestId: "network-away" });
    await until(() => away.frames.some(frame => frame.type === "session_info"), () => away.frames);
    // The phone locks: the only client leaves before the connection is opened.
    away.close();
    open();
    const held = () => [...hosted.app.wsHost.coordinator.pendingApprovals.values()].some(pending => pending.request.toolName === "Network");
    await until(() => held() || hosted.seen.length > 0, () => ({ seen: hosted.seen, records: hosted.records() }));
    expect(held(), "GITHUB_NETWORK_AWAY_CARD_HELD").toBe(true);
    expect(away.card(), "GITHUB_NETWORK_AWAY_CLIENT_SAW_NOTHING").toBeUndefined();
    expect(hosted.observability.logs.records().map(record => record.body), "GITHUB_NETWORK_AWAY_HOLD_LOGGED")
      .toContain("approval requested with no client connected; holding for reconnect");
    const back = await hosted.client();
    await until(() => back.card() !== undefined || hosted.seen.length > 0, () => back.frames, 5_000).catch(() => {});
    expectCard(back.card(), hosted.github.reached());
    back.answer({ type: "tool_approval" });
    await hosted.finished(1);
    expect(hosted.seen[0]!.head, "GITHUB_NETWORK_RECONNECT_ALLOW_ADMITS").toStartWith("HTTP/1.1 200");
    expect(hosted.github.reached()).toBe(1);
  } finally { open(); await hosted.close(); }
}, 60_000);

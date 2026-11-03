import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
/**
 * Hosted external compute through the real host route (#3108), for both
 * first-party backend ids: a governed turn's bridge reaches the compute host,
 * which binds the turn's identity, shows a per-use command card to the
 * connected client, reserves against the turn's frozen budget, and records an
 * Activity run. A normal turn end keeps the job for the next turn of the
 * conversation; a cancelled turn cancels it. Fake Boat transport, keyless.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { AgentBackend } from "@schlessera/brain-ui-sdk/server";
import type { ComputeToolResult } from "@schlessera/brain-ui-sdk/tool-contracts";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createBoatProvider } from "../../compute-boat/src/provider.js";
import { fakeBoat } from "../../compute-boat/tests/helpers/fake-boat.js";
import { createApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { createPrincipal } from "../src/db/principals.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { SENTINEL, summary } from "./helpers/compute-host-fixture.js";

type Script = (bridge: Parameters<AgentBackend["startTurn"]>[0]["bridge"], signal: AbortSignal, turn: number) => Promise<void>;

async function hosted(backendId: "claude" | "pi", scripts: Script[]) {
  const root = await mkdtemp(resolve(tmpdir(), `odysseus-hosted-compute-${backendId}-`)), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  const session = `sess-ithaca-${backendId}`;
  let turn = 0;
  const backend = makeFakeBackend({ id: backendId, startTurn: async ({ bridge, signal }) => {
    const index = turn++;
    bridge.emit({ type: "session_info", sessionId: session, isNew: index === 0 });
    await scripts[index]!(bridge, signal, index);
    bridge.emit({ type: "result", sessionId: session, outcome: signal.aborted ? "cancelled" : "success", durationMs: 1, numTurns: 1, isError: false });
  } });
  const vendor = { now: Date.now() };
  const fake = fakeBoat({ apiKey: SENTINEL, now: () => vendor.now });
  const provider = createBoatProvider({ now: () => vendor.now, sleep: async ms => { vendor.now += ms; } });
  const native = createNativeJournalFixture(brain, root), broker = native.serve();
  const app = await createApp({ config: resolveServerConfig({ BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1",
    AUTH_MODE: "password", NODE_ENV: "test", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash("the bow only Odysseus can string"),
    COOKIE_SECRET: "odysseus-compute-cookie-secret-0123456789", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0",
    BRAIN_UI_COMPUTE_KEYS: "boat=BOAT_CI_KEY" }),
    registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability(),
    computeOverrides: {
      readConfig: async () => ({ ok: true, config: summary() }),
      credential: name => (name === "BOAT_CI_KEY" ? SENTINEL : undefined),
      serviceOptions: { registry: { boat: { load: async () => ({ provider, keyEnv: "BRAIN_COMPUTE_BOAT_API_KEY" }) } }, fetch: fake.fetch, callTimeoutMs: 5_000, lockWaitMs: 2_000,
        clock: { now: () => vendor.now } },
      driver: { initialDelayMs: 5, maxDelayMs: 20 },
    } });
  const principal = createPrincipal(app.db, { authMethod: "password", label: `Odysseus compute ${backendId}`, ttlSeconds: 60 });
  const handlers = createWsHandlers(app.wsHost, principal), sent: string[] = [];
  const ws = { send: (text: string) => sent.push(text), close() {}, readyState: 1 } as WSContext;
  await handlers.onOpen(undefined as never, ws);
  const frames = (): ServerMessage[] => sent.flatMap(text => { const parsed = parseServerMessage(text); return parsed.ok ? [parsed.message] : []; });
  const send = (message: unknown) => handlers.onMessage({ data: JSON.stringify(message) } as MessageEvent, ws);
  const until = async (check: () => boolean, what: string, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!check()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(frames().map(f => f.type))}`); await Bun.sleep(5); }
  };
  return { app, fake, vendor, session, frames, send, until, sent,
    async close() { await app.close(); broker.close(); await native.close(); await rm(root, { recursive: true, force: true }); } };
}

for (const backendId of ["claude", "pi"] as const) {
  const runTool = backendId === "claude" ? "mcp__brain-ui__brain_compute_run" : "brain_compute_run";

  test(`${backendId}: a governed turn runs a job behind a per-use card under the turn's identity; a later turn collects it`, async () => {
    const results: ComputeToolResult[] = [];
    let jobId = "";
    const h = await hosted(backendId, [
      async bridge => {
        results.push(await bridge.compute!({ tool: "brain_compute_run", input: { provider: "boat-small", argv: ["write", "out/log.txt", "Ithaca in sight"], artifacts: [{ path: "out/log.txt" }] }, toolUseId: "toolu_ithaca_run" }));
        if (results[0]!.ok) jobId = (results[0] as unknown as { job: { id: string } }).job.id;
      },
      async bridge => {
        results.push(await bridge.compute!({ tool: "brain_compute_collect", input: { job: jobId }, toolUseId: "toolu_ithaca_collect" }));
      },
    ]);
    try {
      h.send({ type: "chat_message", text: "Build the charts remotely", requestId: "compute-run" });
      await h.until(() => h.frames().some(f => f.type === "tool_approval_request"), "the approval card");
      const card = h.frames().find(f => f.type === "tool_approval_request") as Extract<ServerMessage, { type: "tool_approval_request" }>;
      expect(card, `${backendId.toUpperCase()}_COMPUTE_CARD_PER_USE`).toMatchObject({ toolName: runTool, toolUseId: "toolu_ithaca_run", kind: "command" });
      expect(JSON.stringify(card)).not.toContain(SENTINEL);
      h.send({ type: "tool_approval", toolUseId: card.toolUseId, always: true });
      await h.until(() => results.length === 1 && !h.app.wsHost.coordinator.isTurnActive(), "the first turn to end");
      expect(results[0], `${backendId.toUpperCase()}_COMPUTE_RUN_STARTS`).toMatchObject({ ok: true, job: { instance: "boat-small" } });
      const row = h.app.db.query("SELECT principal_id, session_id, turn_id, tool_use_id FROM compute_hosted_jobs WHERE job_id = ?").get(jobId) as Record<string, string>;
      expect({ session: row.session_id, toolUse: row.tool_use_id }, `${backendId.toUpperCase()}_COMPUTE_HOST_IDENTITY`).toEqual({ session: h.session, toolUse: "toolu_ithaca_run" });
      expect(h.app.db.query("SELECT COUNT(*) AS n FROM compute_budget_reservations WHERE job_id = ?").get(jobId), "RESERVED_AGAINST_TURN").toEqual({ n: 1 });
      const span = h.app.wsHost.activity!.store.getSpan(`compute:${jobId}`)!;
      expect(span, "COMPUTE_ACTIVITY_ROOT_RUN").toMatchObject({ origin: "compute", sessionId: h.session, jobName: "boat-small" });
      expect(span.attrs["brain.compute.turn"]).toBe(row.turn_id);
      // An "always" answer to a command card is never remembered: the next run asks again.
      expect(h.app.wsHost.toolPermissions?.isAutoAllowed(runTool) ?? false, "COMPUTE_CARD_NEVER_REMEMBERED").toBe(false);

      h.send({ type: "chat_message", text: "Collect the charts", requestId: "compute-collect", sessionId: h.session });
      await h.until(() => results.length === 2 && !h.app.wsHost.coordinator.isTurnActive(), "the second turn to end");
      expect(results[1], `${backendId.toUpperCase()}_LATER_TURN_COLLECTS`).toMatchObject({ ok: true, artifacts: [{ path: "out/log.txt", status: "collected" }] });
      expect(JSON.stringify(results)).not.toContain(SENTINEL);
      const events = h.app.db.query("SELECT kind, payload FROM governance_events WHERE kind IN ('outward_action', 'taint')").all() as Array<{ kind: string; payload: string }>;
      expect(events.find(event => event.kind === "outward_action")!.payload, "COMPUTE_OUTWARD_ACTION").toContain('"action":"compute_run"');
    } finally { await h.close(); }
  }, 60_000);

  test(`${backendId}: cancelling a turn cancels the job it started and records the release`, async () => {
    let jobId = "";
    const h = await hosted(backendId, [
      async (bridge, signal) => {
        const result = await bridge.compute!({ tool: "brain_compute_run", input: { provider: "boat-small", argv: ["sleep", "600"] }, toolUseId: "toolu_ithaca_sleep" });
        if (result.ok) jobId = (result as unknown as { job: { id: string } }).job.id;
        await new Promise<void>(done => { if (signal.aborted) done(); else signal.addEventListener("abort", () => done(), { once: true }); });
      },
    ]);
    try {
      h.send({ type: "chat_message", text: "Run the long survey", requestId: "compute-cancel" });
      await h.until(() => h.frames().some(f => f.type === "tool_approval_request"), "the approval card");
      const card = h.frames().find(f => f.type === "tool_approval_request") as { toolUseId: string };
      h.send({ type: "tool_approval", toolUseId: card.toolUseId });
      await h.until(() => jobId !== "", "the job to start");
      expect(h.fake.liveSandboxes()).toBe(1);
      h.send({ type: "cancel", sessionId: h.session });
      await h.until(() => h.app.wsHost.activity!.store.getSpan(`compute:${jobId}`)?.outcome != null, "the job's run to end");
      const span = h.app.wsHost.activity!.store.getSpan(`compute:${jobId}`)!;
      expect({ outcome: span.outcome, cleanup: span.attrs["brain.compute.cleanup"] }, `${backendId.toUpperCase()}_ABORT_CANCELS_JOB`).toEqual({ outcome: "cancelled", cleanup: "released" });
      expect(h.fake.liveSandboxes()).toBe(0);
    } finally { await h.close(); }
  }, 60_000);
}

test("readiness reports hosted compute on /api/status runtime", async () => {
  const h = await hosted("claude", []);
  try {
    const status = h.app.wsHost.computeTools!.status();
    expect(status, "READINESS_ON_HOST").toMatchObject({ enabled: true, stateMasked: true, core: "present" });
    expect(status.stateDir).toEndWith("ui.db.compute");
  } finally { await h.close(); }
}, 60_000);

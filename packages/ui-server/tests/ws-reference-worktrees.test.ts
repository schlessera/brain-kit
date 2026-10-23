import { installFixtureNativeStartupViews } from "./helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";
import { createApp } from "../src/app.js";
import { resolveServerConfig } from "../src/config/env.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { createRecordingObservability } from "../src/observability/index.js";
import { createWsHandlers } from "../src/ws/connection.js";
import type { WSContext } from "../src/ws/clients.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { createPrincipal } from "../src/db/principals.js";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import type { ReferenceWorktrees } from "../src/brain/reference-worktrees.js";

test("a turn binds its worktree generation and retires it before the final observation, then closes it", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "odysseus-host-worktrees-")), brain = resolve(root, "brain");
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  const order: string[] = [];
  let sandbox: { worktrees?: { source: string } } | undefined;
  const backend = makeFakeBackend({ id: "worktree-fixture", startTurn: async ({ bridge, workerSandbox }) => {
    sandbox = workerSandbox as typeof sandbox;
    bridge.emit({ type: "session_info", sessionId: "sess-ithaca", isNew: true });
    bridge.emit({ type: "text_delta", text: "Ithaca is in sight." });
    bridge.emit({ type: "result", sessionId: "sess-ithaca", outcome: "success", durationMs: 1, numTurns: 1, isError: false });
  } });
  const native = createNativeJournalFixture(brain, root), broker = native.serve();
  const app = await createApp({ config: resolveServerConfig({ BRAIN_UI_NATIVE_BRAIN_SOCKET: broker.socketPath, BRAIN_PATH: brain, DB_PATH: resolve(root, "ui.db"), HOST: "127.0.0.1",
    AUTH_MODE: "password", NODE_ENV: "test", BRAIN_UI_PASSWORD_HASH: await Bun.password.hash("the bow only Odysseus can string"),
    COOKIE_SECRET: "odysseus-worktree-cookie-secret-0123456789", BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0" }),
    registry: createStaticBackendRegistry([backend], backend.id), observability: createRecordingObservability() });
  try {
    // The fixture has no reference pool: stand in for the service the host wires when one exists.
    const service = {
      async openGeneration(input: { turnId: string }) { order.push(`open:${input.turnId}`); return { id: "generation-ithaca", path: "/usr", principalId: "", turnId: input.turnId, profile: "governed" as const }; },
      async retireGeneration(id: string) { order.push(`retire:${id}`); },
      async closeGeneration(id: string) { order.push(`close:${id}`); },
      async reconcile() { order.push("reconcile"); return { expired: [], recovered: [], retained: [] }; },
    } as unknown as ReferenceWorktrees;
    Object.assign(app.wsHost, { referenceWorktrees: service, referenceWorktreeAccess: true });
    const finish = app.wsHost.journal!.finish.bind(app.wsHost.journal!);
    app.wsHost.journal!.finish = async (turnId: string) => { order.push("finish"); return finish(turnId); };
    const principal = createPrincipal(app.db, { authMethod: "password", label: "Odysseus worktrees", ttlSeconds: 60 });
    const handlers = createWsHandlers(app.wsHost, principal), sent: string[] = [], ws = { send: (text: string) => sent.push(text), close() {}, readyState: 1 } as WSContext;
    await handlers.onOpen(undefined as never, ws);
    handlers.onMessage({ data: JSON.stringify({ type: "chat_message", text: "Sight Ithaca", requestId: "worktree-request" }) } as MessageEvent, ws);
    const frames = () => sent.flatMap(text => { const parsed = parseServerMessage(text); return parsed.ok ? [parsed.message] : []; });
    const until = Date.now() + 10_000;
    while (!order.includes("reconcile")) { if (Date.now() > until) throw new Error(JSON.stringify({ order, frames: frames() })); await Bun.sleep(5); }
    expect(sandbox?.worktrees, "REFERENCE_WORKTREE_SANDBOX_BINDS_GENERATION").toEqual({ source: "/usr" });
    const firstFinish = order.indexOf("finish"), retire = order.indexOf("retire:generation-ithaca"), close = order.indexOf("close:generation-ithaca");
    expect({ retireBeforeFinish: retire >= 0 && retire < firstFinish, closeAfterFinish: close > firstFinish }, "REFERENCE_WORKTREE_RETIRE_BEFORE_FINAL_OBSERVATION")
      .toEqual({ retireBeforeFinish: true, closeAfterFinish: true });
    expect(app.wsHost.referenceWorktreeGenerations.size, "REFERENCE_WORKTREE_GENERATION_FORGOTTEN_AFTER_TURN").toBe(0);
  } finally { await app.close(); broker.close(); await native.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);

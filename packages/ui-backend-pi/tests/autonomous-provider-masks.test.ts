/**
 * The restricted autonomous envelope prepares its own sandbox; host-admitted
 * provider masks must join it, or the worker would see the masked folders
 * (#2691). The launch is captured before any process starts.
 */
import { tmpdir } from "node:os";
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import { openPiWorkerSession } from "../src/worker-session.js";
import { createPiTurnRunner } from "../src/turn-runner.js";
import { createSessionPool } from "../src/session-pool.js";
import { createFixtureWorkerStartupView } from "../../ui-sdk/tests/helpers/worker-startup-view-fixture.js";

test("pi restricted autonomous launch carries the host-admitted provider masks into its sandbox and note", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-pi-autonomous-masks-")), brain = join(root, "brain");
  mkdirSync(brain);
  const view = createFixtureWorkerStartupView(brain);
  const masks = Object.freeze({ folders: Object.freeze(["me"]), index: join(tmpdir(), "brain-private-index-odysseus") });
  const probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
  const oldKey = process.env.ANTHROPIC_API_KEY, oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
  process.env.ANTHROPIC_API_KEY = "sk-odysseus-offline";
  let captured: Parameters<typeof worker.launchAgentWorker>[0] | undefined;
  const launch = spyOn(worker, "launchAgentWorkerAsync").mockImplementation(async options => { captured = options; throw new Error("LAUNCH_CAPTURED"); });
  try {
    await expect(openPiWorkerSession({ brainPath: brain, model: "anthropic/claude-sonnet-4-6" }, join(root, "sessions"), {
      workerStartupView: view, workerProviderMasks: masks,
      autonomous: { origin: "autonomous", persistence: "none", containment: "restricted", allowedTools: [], systemPromptAppend: "Odysseus offline fixture." },
      caps: { askUser: false, askUserList: false, askUserRank: false, location: false, activity: false, mask: false },
    })).rejects.toThrow("LAUNCH_CAPTURED");
    expect(captured?.restricted, "RESTRICTED_ENVELOPE_LAUNCH").toBeDefined();
    expect(captured?.sandbox?.restricted).toBe(true);
    expect(captured?.sandbox?.providerMasks, "RESTRICTED_SANDBOX_CARRIES_PROVIDER_MASKS").toEqual(masks);
  } finally {
    launch.mockRestore(); probe.mockRestore();
    if (oldKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = oldKey;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await view.cleanup(); rmSync(root, { recursive: true, force: true });
  }
});

test("the pi session pool hands a turn's provider masks to the session it opens", async () => {
  const masks = Object.freeze({ folders: Object.freeze(["me"]), index: join(tmpdir(), "brain-private-index-odysseus") });
  let opened: unknown;
  const pool = createSessionPool({ newSession: async (_profile, env) => { opened = env?.workerProviderMasks; throw new Error("SESSION_CAPTURED"); },
    openSession: async () => { throw new Error("fixture cannot resume"); } });
  await expect(createPiTurnRunner(pool, { brainPath: "/brain" })({ prompt: "Odysseus", signal: new AbortController().signal, enforceAllowedTools: true, noGrantSurface: true,
    workerProviderMasks: masks, autonomous: { origin: "autonomous", persistence: "none", containment: "restricted", allowedTools: [], systemPromptAppend: "" },
    bridge: { emit: () => {}, checkpointPermission: () => {}, requestPermission: async () => ({ behavior: "deny", message: "Fixture denial" }) } })).rejects.toThrow("SESSION_CAPTURED");
  expect(opened, "POOL_PASSES_PROVIDER_MASKS").toEqual(masks);
});

/**
 * The asynchronous worker checks leave the server's event loop free (#2416).
 * A synchronous probe, sandbox check or launch blocks every other request
 * (`/health`, WebSocket pings) for as long as a loaded host takes to start a
 * worker. A 1 ms timer cannot fire during synchronous work, so each test
 * counts its ticks while the real check runs, and compares the answer with
 * the synchronous form's.
 */
import { createFixtureMaintenanceHost, createFixtureWorkerStartupView } from "./helpers/worker-startup-view-fixture.js";
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchAgentWorkerAsync, prepareWorkerSandbox, prepareWorkerSandboxAsync, probeWorkerHost, probeWorkerHostAsync,
  requireWorkerHostAsync, workerHostBoundary, WorkerHostError } from "../src/server/worker-launcher";

const ROOT = resolve(import.meta.dir, "../../..");

function fixture() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/worker-steps-"));
  const brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  return { root, brain, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function ticksDuring<T>(work: () => Promise<T>): Promise<{ result: T; ticks: number }> {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  try { return { result: await work(), ticks }; } finally { clearInterval(timer); }
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  for await (const chunk of stream as AsyncIterable<Buffer>) output += chunk.toString();
  return output;
}

test("the asynchronous probe runs the real launcher with the event loop free and answers as the synchronous one", async () => {
  const f = fixture();
  try {
    const { result, ticks } = await ticksDuring(() => probeWorkerHostAsync(f.brain));
    expect(ticks, "ASYNC_PROBE_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
    expect(result, "ASYNC_PROBE_SAME_ANSWER").toEqual(probeWorkerHost(f.brain));
    expect(result.ok).toBe(true);
    // A refusal is the same refusal, by the same requirement.
    const missing = join(f.root, "absent");
    expect(await probeWorkerHostAsync(missing), "ASYNC_PROBE_SAME_REFUSAL").toEqual(probeWorkerHost(missing));
  } finally { f.cleanup(); }
});

test("a replaced probe answers the asynchronous gate too", async () => {
  const probe = spyOn(workerHostBoundary, "probe").mockReturnValue({ ok: false, requirement: "bubblewrap is missing" });
  try {
    expect(await workerHostBoundary.probeAsync("/odysseus")).toEqual({ ok: false, requirement: "bubblewrap is missing" });
    const refusal = await requireWorkerHostAsync("/odysseus").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(WorkerHostError);
    expect((refusal as WorkerHostError).requirement).toBe("bubblewrap is missing");
    expect(probe).toHaveBeenCalledTimes(2);
  } finally { probe.mockRestore(); }
});

test("the asynchronous sandbox runs its scratch git check with the event loop free and resolves the same areas", async () => {
  const f = fixture();
  const maintenance = createFixtureMaintenanceHost(f.brain);
  try {
    const { result, ticks } = await ticksDuring(() => prepareWorkerSandboxAsync(f.brain, { maintenance }));
    expect(ticks, "ASYNC_SANDBOX_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
    expect(result.areas.find(area => area.name === "scratch")?.mount.writable, "ASYNC_SANDBOX_SCRATCH_CHECKED").toBe(true);
    expect(result, "ASYNC_SANDBOX_SAME_AREAS").toEqual(prepareWorkerSandbox(f.brain, { maintenance }));
  } finally { maintenance.cleanup(); f.cleanup(); }
});

test("the asynchronous launch waits for bubblewrap's setup with the event loop free and runs the command once released", async () => {
  const f = fixture();
  const startupView = createFixtureWorkerStartupView(f.brain);
  let ticks = 0;
  try {
    const launched = await ticksDuring(() => launchAgentWorkerAsync({ brainPath: f.brain, startupView, turnTempBytes: 1024 * 1024,
      command: ["/bin/sh", "-c", "printf ithaca"], env: {} }));
    ticks = launched.ticks;
    const worker = launched.result;
    worker.stdin.end();
    const [code, output] = await Promise.all([worker.exited, collect(worker.stdout)]);
    expect(code).toBe(0);
    expect(output, "ASYNC_LAUNCH_RUNS_COMMAND").toBe("ithaca");
    worker.turnTemp?.close();
  } finally { f.cleanup(); }
  expect(ticks, "ASYNC_LAUNCH_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
});

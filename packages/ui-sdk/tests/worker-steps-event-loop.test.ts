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
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { identityWorkerExit, launchAgentWorkerAsync, prepareWorkerSandbox, prepareWorkerSandboxAsync, probeWorkerHost, probeWorkerHostAsync,
  requireWorkerHostAsync, workerHostBoundary, WorkerHostError, type IdentityWorkerStatus, type LaunchedWorker } from "../src/server/worker-launcher";
import * as launcher from "../src/server/worker-launcher";
import * as identity from "../src/server/worker-identity";
import { launchMaintenanceWorkerAsync, runMaintenanceWorker } from "../src/server/maintenance-worker";
import { claudeMaskFilename, claudeReportedMaskPath, handleRequestImageMask } from "../src/server/bridge-tools/mask";
import type { BackendBridge } from "../src/server/backend";
import { workerStep } from "../src/server/worker-steps";

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

// #2790: the remaining sites that waited on a worker synchronously.

test("a scratch mask's ignore check runs its real maintenance worker with the event loop free and refuses as before", async () => {
  const f = fixture();
  try {
    Bun.spawnSync(["git", "-C", f.brain, "init", "-q"]);
    mkdirSync(join(f.brain, ".brain/scratch"), { recursive: true });
    writeFileSync(join(f.brain, ".brain/scratch/draft.png"), "png");
    // The maintenance host copies the brain's input when it is created.
    const request = async () => {
      const maintenance = createFixtureMaintenanceHost(f.brain);
      try { return await handleRequestImageMask({ imagePath: ".brain/scratch/draft.png", instruction: "the sea" },
        { requestMask: async () => new Uint8Array([1, 2, 3]) } as unknown as BackendBridge,
        { brainPath: f.brain, maskFilename: claudeMaskFilename, reportMaskPath: claudeReportedMaskPath, maintenance }); }
      finally { maintenance.cleanup(); }
    };
    // Not yet ignored: the same refusal, after the worker answered.
    const refused = await ticksDuring(() => request().catch((error: unknown) => error));
    expect(refused.ticks, "ASYNC_SCRATCH_CHECK_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
    expect((refused.result as Error).message, "ASYNC_SCRATCH_CHECK_SAME_REFUSAL").toMatch(/not gitignored as a directory.*brain doctor --fix/s);
    expect(existsSync(join(f.brain, ".brain/scratch/draft-mask.png"))).toBe(false);
    writeFileSync(join(f.brain, ".gitignore"), ".brain/scratch/\n");
    const { result, ticks } = await ticksDuring(request);
    expect(ticks, "ASYNC_SCRATCH_CHECK_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
    expect(result.maskPath).toBe(".brain/scratch/draft-mask.png");
    expect(readFileSync(join(f.brain, ".brain/scratch/draft-mask.png"))).toEqual(Buffer.from([1, 2, 3]));
  } finally { f.cleanup(); }
});

/** A supervisor request that takes `ms`, counting the ticks that fire while it is outstanding. */
function statusRequests(replies: IdentityWorkerStatus[], ms: number) {
  const seen = { requests: 0, ticksDuringRequests: 0 };
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  const status = () => workerStep<IdentityWorkerStatus>(() => {
    const before = ticks; Bun.sleepSync(ms); seen.ticksDuringRequests += ticks - before;
    return replies[Math.min(seen.requests++, replies.length - 1)]!;
  }, async () => {
    const before = ticks; await Bun.sleep(ms); seen.ticksDuringRequests += ticks - before;
    return replies[Math.min(seen.requests++, replies.length - 1)]!;
  });
  return { seen, status, stop: () => clearInterval(timer) };
}

function supervision() {
  let finished = false, released = 0;
  return { state: () => ({ finished, released }),
    hooks: { finished: () => finished, finish: () => { finished = true; }, release: () => { released++; } } };
}

test("a separate-UID worker's exit is polled with the event loop free and maps the supervisor's answer as before", async () => {
  const requests = statusRequests([{ exited: false, code: null }, { exited: false, code: null }, { exited: true, code: -9 }], 30);
  const owner = supervision();
  try {
    const code = await identityWorkerExit(requests.status, new Promise<number>(() => {}), owner.hooks);
    expect(code, "IDENTITY_EXIT_SIGNAL_CODE").toBe(137);
    expect(requests.seen.requests).toBe(3);
    expect(requests.seen.ticksDuringRequests, "IDENTITY_POLL_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
    expect(owner.state()).toEqual({ finished: true, released: 1 });
  } finally { requests.stop(); }
  const failed = statusRequests([{ exited: true, code: 0, failure: "the worker could not be confined" }], 1);
  try {
    const refusal = await identityWorkerExit(failed.status, new Promise<number>(() => {}), supervision().hooks).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(WorkerHostError);
    expect((refusal as WorkerHostError).requirement).toBe("worker_identity_supervision_failed: the worker could not be confined");
  } finally { failed.stop(); }
});

test("a broker release that cannot confirm cleanup after the exit stays handled, as when the poll caught it", async () => {
  const requests = statusRequests([{ exited: true, code: 0 }], 1);
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", record);
  let finished = false;
  try {
    const code = await identityWorkerExit(requests.status, new Promise<number>(() => {}), { finished: () => finished,
      finish: () => { finished = true; }, release: () => { throw new Error("worker_identity_cleanup_unconfirmed: fixture"); } });
    expect(code).toBe(0);
    await Bun.sleep(20);
    expect(unhandled, "IDENTITY_RELEASE_FAILURE_HANDLED").toEqual([]);
  } finally { process.off("unhandledRejection", record); requests.stop(); }
});

test("a supervisor lost while a status request is outstanding refuses once and ignores the late answer", async () => {
  const requests = statusRequests([{ exited: true, code: 0 }], 150);
  const owner = supervision();
  let lose!: (code: number) => void;
  try {
    const exit = identityWorkerExit(requests.status, new Promise<number>(resolve => { lose = resolve; }), owner.hooks);
    await Bun.sleep(150);
    expect(requests.seen.requests, "IDENTITY_REQUEST_OUTSTANDING").toBe(0);
    lose(1);
    const refusal = await exit.catch((error: unknown) => error);
    expect((refusal as WorkerHostError).requirement).toBe("worker_identity_supervisor_lost (1)");
    await Bun.sleep(200);
    expect(requests.seen.requests).toBe(1);
    // The late answer neither settles again nor releases the broker a second time.
    expect(owner.state()).toEqual({ finished: true, released: 0 });
  } finally { requests.stop(); }
});

test("a separate-UID maintenance launch waits for its helper worker with the event loop free", async () => {
  const f = fixture();
  const startupView = createFixtureWorkerStartupView(f.brain);
  let blocked = 0;
  const helper = spyOn(identity, "workerIdentityHelper").mockReturnValue("/usr/lib/odysseus/identity-helper");
  const launch = spyOn(launcher, "launchAgentWorkerSteps").mockImplementation(function* () {
    // The helper's setup wait, as the launcher yields it.
    yield* workerStep(() => { blocked++; Bun.sleepSync(100); }, () => Bun.sleep(100));
    const child = spawn("/bin/cat", [], { stdio: ["pipe", "pipe", "pipe"] });
    return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, pid: child.pid!,
      exited: new Promise<number>(resolve => child.once("exit", code => resolve(code ?? 1))),
      kill: (signal?: NodeJS.Signals) => { child.kill(signal); } } as unknown as LaunchedWorker;
  });
  try {
    const { result: worker, ticks } = await ticksDuring(() => launchMaintenanceWorkerAsync({ brainPath: f.brain, startupView,
      command: ["/bin/cat"], env: { PATH: "/usr/bin:/bin" }, credentials: false,
      tempDomain: { statePath: join(f.root, "maintenance-state.db") } }));
    expect(launch).toHaveBeenCalledTimes(1);
    expect(blocked, "ASYNC_MAINTENANCE_LAUNCH_NEVER_BLOCKS").toBe(0);
    expect(ticks, "ASYNC_MAINTENANCE_LAUNCH_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
    const output = new Response(worker.stdout).text();
    await worker.input("ithaca");
    expect(await output).toBe("ithaca");
    expect(await worker.exited).toBe(0);
  } finally { launch.mockRestore(); helper.mockRestore(); startupView.cleanup(); f.cleanup(); }
});

test("an abort accepted while a separate-UID maintenance launch is awaited still stops its worker", async () => {
  const f = fixture();
  const startupView = createFixtureWorkerStartupView(f.brain);
  const controller = new AbortController();
  let child: ReturnType<typeof spawn> | undefined;
  const helper = spyOn(identity, "workerIdentityHelper").mockReturnValue("/usr/lib/odysseus/identity-helper");
  const launch = spyOn(launcher, "launchAgentWorkerSteps").mockImplementation(function* () {
    // Cancelled while the helper's setup is awaited; the worker would otherwise run for 30 s.
    yield* workerStep(() => { controller.abort(); }, async () => { controller.abort(); await Bun.sleep(20); });
    const started = child = spawn("/bin/sh", ["-c", "exec sleep 30"], { stdio: ["pipe", "pipe", "pipe"] });
    return { stdin: started.stdin, stdout: started.stdout, stderr: started.stderr, pid: started.pid!,
      exited: new Promise<number>(resolve => started.once("exit", (code, signal) => resolve(code ?? (signal ? 137 : 1)))),
      kill: (signal?: NodeJS.Signals) => { started.kill(signal); } } as unknown as LaunchedWorker;
  });
  try {
    const startedAt = performance.now();
    const refusal = await runMaintenanceWorker({ brainPath: f.brain, startupView, command: ["/bin/sh"], env: { PATH: "/usr/bin:/bin" },
      credentials: false, tempDomain: { statePath: join(f.root, "maintenance-state.db") }, signal: controller.signal }).catch((error: unknown) => error);
    expect(refusal, "ABORT_DURING_MAINTENANCE_LAUNCH_REJECTS").toBeInstanceOf(DOMException);
    expect(child?.signalCode, "ABORT_DURING_MAINTENANCE_LAUNCH_KILLS_WORKER").toBe("SIGKILL");
    expect(performance.now() - startedAt).toBeLessThan(10_000);
  } finally { child?.kill("SIGKILL"); launch.mockRestore(); helper.mockRestore(); startupView.cleanup(); f.cleanup(); }
});

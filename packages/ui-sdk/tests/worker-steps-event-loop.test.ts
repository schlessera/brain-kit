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
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { identityWorkerExit, launchAgentWorker, launchAgentWorkerAsync, prepareWorkerSandbox, prepareWorkerSandboxAsync, probeWorkerHost, probeWorkerHostAsync,
  requireWorkerHostAsync, workerHostBoundary, WorkerHostError, type IdentityWorkerStatus, type LaunchedWorker } from "../src/server/worker-launcher";
import * as launcher from "../src/server/worker-launcher";
import * as identity from "../src/server/worker-identity";
import { launchMaintenanceWorker, launchMaintenanceWorkerAsync, runMaintenanceWorker } from "../src/server/maintenance-worker";
import { claudeMaskFilename, claudeReportedMaskPath, handleRequestImageMask } from "../src/server/bridge-tools/mask";
import type { BackendBridge } from "../src/server/backend";
import { runWorkerStepsAsync, workerStep, workerStepSleep, type WorkerSteps } from "../src/server/worker-steps";
import { createWorkerPipes, createWorkerPipesSteps } from "../src/server/worker-pipes";
import { mkfifoShim, mkfifoSpawns } from "./helpers/mkfifo-shim.js";
import { identityControl, identityControlSpawns } from "./helpers/identity-control-fixture.js";

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

// #2799: the FIFOs each of those forms creates for its worker.

test("a worker's FIFOs are created by an awaited mkfifo with the event loop free, with the synchronous form's modes", async () => {
  const slow = mkfifoShim(real => `sleep 0.2; exec "${real}" "$@"`);
  const made: ReturnType<typeof createWorkerPipes>[] = [];
  try {
    const awaited = await ticksDuring(() => runWorkerStepsAsync(createWorkerPipesSteps()));
    made.push(awaited.result);
    const blocked = await ticksDuring(async () => createWorkerPipes());
    made.push(blocked.result);
    expect(awaited.ticks, "ASYNC_FIFO_CREATION_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
    // The measure can fail: the synchronous form still blocks for the same wait.
    expect(blocked.ticks, "SYNC_FIFO_CREATION_BLOCKS").toBe(0);
    for (const pipes of made) for (const fd of [...pipes.child, ...pipes.parent]) {
      const stat = fstatSync(fd);
      expect(stat.isFIFO(), "FIFO_ENDS_ARE_FIFOS").toBe(true);
      expect(stat.mode & 0o777, "FIFO_MODE_0600").toBe(0o600);
    }
    const pipes = awaited.result;
    writeSync(pipes.parent[0], "ithaca");
    const buffer = Buffer.alloc(16);
    expect(buffer.subarray(0, readSync(pipes.child[0], buffer)).toString(), "ASYNC_FIFO_CARRIES_INPUT").toBe("ithaca");
  } finally { for (const pipes of made) { pipes.closeChild(); pipes.cleanup(); } slow.restore(); }
});

test("the asynchronous probe, launch and maintenance forms run no synchronous mkfifo, and the synchronous forms still do", async () => {
  const f = fixture();
  const maintenance = createFixtureMaintenanceHost(f.brain);
  const views = [createFixtureWorkerStartupView(f.brain), createFixtureWorkerStartupView(f.brain), createFixtureWorkerStartupView(f.brain)];
  const runs = async (work: () => Promise<unknown>) => {
    const spawns = mkfifoSpawns();
    try { await work(); return spawns.counts(); } finally { spawns.restore(); }
  };
  const agent = async (worker: LaunchedWorker) => {
    worker.stdin.end();
    const [code, output] = await Promise.all([worker.exited, collect(worker.stdout)]);
    worker.turnTemp?.close();
    expect({ code, output }).toEqual({ code: 0, output: "ithaca" });
  };
  const agentLaunch = (startupView: (typeof views)[number]) =>
    ({ brainPath: f.brain, startupView, turnTempBytes: 1024 * 1024, command: ["/bin/sh", "-c", "printf ithaca"], env: {} });
  const maintenanceLaunch = { brainPath: f.brain, startupView: views[2]!, command: ["/bin/sh", "-c", "printf ithaca"],
    env: { PATH: "/usr/bin:/bin" }, credentials: false, tempDomain: { statePath: join(f.root, "maintenance-state.db") } };
  try {
    const awaited = {
      probe: await runs(() => probeWorkerHostAsync(f.brain)),
      maintenanceRun: await runs(() => prepareWorkerSandboxAsync(f.brain, { maintenance })),
      agentLaunch: await runs(async () => agent(await launchAgentWorkerAsync(agentLaunch(views[0]!)))),
      maintenanceLaunch: await runs(async () => expect((await runMaintenanceWorker(maintenanceLaunch)).stdout).toBe("ithaca")),
    };
    const blocking = {
      probe: await runs(async () => probeWorkerHost(f.brain)),
      maintenanceRun: await runs(async () => prepareWorkerSandbox(f.brain, { maintenance })),
      agentLaunch: await runs(() => agent(launchAgentWorker(agentLaunch(views[1]!)))),
      maintenanceLaunch: await runs(async () => {
        const worker = launchMaintenanceWorker(maintenanceLaunch);
        const output = new Response(worker.stdout).text();
        await worker.input("");
        expect(await output).toBe("ithaca");
        expect(await worker.exited).toBe(0);
      }),
    };
    // An agent launch creates its stdio and, without the identity helper, its status channel.
    for (const [form, { sync, async }] of Object.entries(awaited))
      expect({ form, sync, awaited: async > 0 }, "ASYNC_FORM_AWAITS_MKFIFO").toEqual({ form, sync: 0, awaited: true });
    for (const [form, { sync, async }] of Object.entries(blocking))
      expect({ form, blocked: sync > 0, async }, "SYNC_FORM_KEEPS_MKFIFO").toEqual({ form, blocked: true, async: 0 });
  } finally { for (const view of views) view.cleanup(); maintenance.cleanup(); f.cleanup(); }
});

// #2844: a separate-UID worker's broker close, and the brain view, on those forms.

const IDENTITY_HELPER = "/usr/lib/odysseus/identity-helper";

/** A real broker whose ready file names `supervisor` as its same-UID supervisor. */
function readyBroker(supervisor: number) {
  const broker = identity.prepareWorkerIdentity(IDENTITY_HELPER, ["/bin/true"], []);
  const { ready } = JSON.parse(broker.command.at(-1)!) as { ready: string };
  writeFileSync(ready, JSON.stringify({ ok: true, workerUid: process.getuid!() + 1, worker: { pid: 2, start: "1" }, roots: {} }));
  broker.ready(supervisor, Date.now() + 5_000);
  return broker;
}

test("a separate-UID broker's close is awaited with the event loop free, and the synchronous close still blocks", async () => {
  const awaitedBroker = identity.prepareWorkerIdentity(IDENTITY_HELPER, ["/bin/true"], []);
  const blockingBroker = identity.prepareWorkerIdentity(IDENTITY_HELPER, ["/bin/true"], []);
  const controls = [identityControl(awaitedBroker, { delayMs: 200 }), identityControl(blockingBroker, { delayMs: 200 })];
  try {
    while (!controls.every(control => control.ready())) await Bun.sleep(5);
    const spawns = identityControlSpawns();
    let awaited, blocked;
    try {
      awaited = { ...await ticksDuring(() => runWorkerStepsAsync(awaitedBroker.closeSteps())), spawns: spawns.counts() };
      blocked = { ...await ticksDuring(async () => blockingBroker.close()), spawns: spawns.counts() };
    } finally { spawns.restore(); }
    expect(awaited.spawns, "ASYNC_BROKER_CLOSE_SPAWNS_NO_SYNC_CONTROL_CLIENT").toEqual({ sync: 0, async: 1 });
    expect(awaited.ticks, "ASYNC_BROKER_CLOSE_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
    // The measure can fail: the synchronous close still blocks for the same reply.
    expect(blocked.spawns, "SYNC_BROKER_CLOSE_KEEPS_SYNC_CONTROL_CLIENT").toEqual({ sync: 1, async: 1 });
    expect(blocked.ticks, "SYNC_BROKER_CLOSE_BLOCKS").toBe(0);
    expect(controls.map(control => control.operations())).toEqual([["close"], ["close"]]);
    // A closed broker is closed once: neither form asks again.
    await runWorkerStepsAsync(awaitedBroker.closeSteps());
    blockingBroker.close();
    expect(controls.map(control => control.operations())).toEqual([["close"], ["close"]]);
  } finally { for (const control of controls) await control.stop(); }
});

test("an awaited close that loses control stops the supervisor and refuses unconfirmed cleanup as before, retaining authority", async () => {
  const forms = { awaited: (broker: ReturnType<typeof readyBroker>) => runWorkerStepsAsync(broker.closeSteps()),
    blocking: async (broker: ReturnType<typeof readyBroker>) => broker.close() };
  for (const [form, close] of Object.entries(forms)) {
    // No control socket: the client fails, the supervisor is stopped, and the
    // fallback's helper (absent here) cannot confirm the cleanup.
    const supervisor = Bun.spawn(["/bin/sh", "-c", "exec sleep 30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const broker = readyBroker(supervisor.pid);
    const { ready } = JSON.parse(broker.command.at(-1)!) as { ready: string };
    const spawns = identityControlSpawns();
    let refusal: unknown, counts;
    try { refusal = await close(broker).catch((error: unknown) => error); counts = spawns.counts(); } finally { spawns.restore(); }
    try {
      expect({ form, unconfirmed: identity.workerCleanupUnconfirmed(refusal) }, "CLOSE_REFUSES_UNCONFIRMED_CLEANUP").toEqual({ form, unconfirmed: true });
      expect({ form, message: String((refusal as Error).message).split(":")[0] }).toEqual({ form, message: "worker_identity_cleanup_unconfirmed" });
      expect({ form, signal: (await supervisor.exited, supervisor.signalCode) }, "CONTROL_LOSS_STOPS_SUPERVISOR").toEqual({ form, signal: "SIGKILL" });
      // Control client, supervisor stop (twice: on the lost request and before the fallback) and the fallback itself.
      expect({ form, spawns: counts }, "CLOSE_FORM_RUNS_ITS_CONTROL_SUBPROCESSES").toEqual(form === "awaited"
        ? { form, spawns: { sync: 0, async: 4 } } : { form, spawns: { sync: 4, async: 0 } });
      // Authority and its files are retained for a later close that can confirm cleanup.
      expect({ form, retained: existsSync(ready) }, "UNCONFIRMED_CLOSE_RETAINS_AUTHORITY").toEqual({ form, retained: true });
    } finally { supervisor.kill("SIGKILL"); broker.discard(); }
  }
});

test("the brain view's broker requests are awaited with the event loop free", async () => {
  const f = fixture();
  const holder = Bun.spawn(["/usr/bin/python3", "-I", "-S", "-c", "import os,sys,time\nfd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY)\nprint(fd,flush=True)\ntime.sleep(30)", f.brain],
    { env: {}, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const reader = holder.stdout.getReader();
  let control: ReturnType<typeof identityControl> | undefined;
  try {
    let line = "";
    while (!line.includes("\n")) { const next = await reader.read(); if (next.done) throw new Error("view holder exited"); line += new TextDecoder().decode(next.value); }
    const info = statSync(f.brain);
    const broker = readyBroker(holder.pid);
    control = identityControl(broker, { delayMs: 100, replies: { view: { ok: true, fd: Number(line.trim()), dev: info.dev, ino: info.ino } } });
    while (!control.ready()) await Bun.sleep(5);
    const view = broker.brainView();
    const spawns = identityControlSpawns();
    let opened;
    try {
      opened = await ticksDuring(async () => {
        const handle = await runWorkerStepsAsync(view.open());
        try { return fstatSync(handle).ino; } finally { closeSync(handle); await runWorkerStepsAsync(view.close()); }
      });
      expect(spawns.counts(), "ASYNC_BRAIN_VIEW_SPAWNS_NO_SYNC_CONTROL_CLIENT").toEqual({ sync: 0, async: 2 });
    } finally { spawns.restore(); }
    expect(opened.result, "BRAIN_VIEW_IS_THE_HELD_DIRECTORY").toBe(info.ino);
    expect(opened.ticks, "ASYNC_BRAIN_VIEW_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
    expect(control.operations()).toEqual(["view", "unview"]);
  } finally { await control?.stop(); holder.kill("SIGKILL"); reader.releaseLock(); f.cleanup(); }
});

/**
 * `prepareWorkerIdentity` at the launcher's seam: the real broker, whose
 * close runs its real control client against a stand-in socket, with the
 * supervisor's setup and status answered in place of a root-owned helper.
 */
function seamBroker(answers: { ready?: () => never; status?: IdentityWorkerStatus }) {
  const prepare = identity.prepareWorkerIdentity;
  const controls: ReturnType<typeof identityControl>[] = [];
  const spy = spyOn(identity, "prepareWorkerIdentity").mockImplementation((...args: Parameters<typeof prepare>) => {
    const real = prepare(...args);
    const control = identityControl(real);
    controls.push(control);
    return { ...real, command: ["/bin/sh", "-c", "exit 0"],
      *readySteps() {
        while (!control.ready()) yield* workerStepSleep(1);
        if (answers.ready) answers.ready();
        return { ok: true as const, workerUid: process.getuid!() + 1, worker: { pid: 2, start: "1" }, roots: {} };
      },
      *requestSteps<T extends object>(operation: string): WorkerSteps<T> {
        yield* workerStepSleep(1);
        return (operation === "status" ? answers.status : { ok: true }) as T;
      } };
  });
  return { operations: () => controls.map(control => control.operations()),
    restore: async () => { spy.mockRestore(); for (const control of controls) await control.stop(); } };
}

test("the asynchronous probe closes a separate-UID broker through awaited steps, and the synchronous probe still blocks", async () => {
  const f = fixture();
  const helper = spyOn(identity, "workerIdentityHelper").mockReturnValue(IDENTITY_HELPER);
  const runs = async (status: IdentityWorkerStatus, probe: () => Promise<unknown>) => {
    const seam = seamBroker({ status });
    const spawns = identityControlSpawns();
    try { await probe(); return { spawns: spawns.counts(), operations: seam.operations() }; }
    finally { spawns.restore(); await seam.restore(); }
  };
  try {
    // An exited probe worker closes its broker inline; a failed supervision closes it on the way out.
    for (const status of [{ exited: true, code: 0 }, { exited: true, code: 0, failure: "the worker could not be confined" }]) {
      const awaited = await runs(status, () => probeWorkerHostAsync(f.brain));
      const blocking = await runs(status, async () => probeWorkerHost(f.brain));
      expect({ status, ...awaited }, "ASYNC_PROBE_AWAITS_BROKER_CLOSE").toEqual({ status, spawns: { sync: 0, async: 1 }, operations: [["close"]] });
      expect({ status, ...blocking }, "SYNC_PROBE_KEEPS_BLOCKING_BROKER_CLOSE").toEqual({ status, spawns: { sync: 1, async: 0 }, operations: [["close"]] });
    }
  } finally { helper.mockRestore(); f.cleanup(); }
});

test("a failed asynchronous launch closes its separate-UID broker through awaited steps before it refuses", async () => {
  const f = fixture();
  const views = [createFixtureWorkerStartupView(f.brain), createFixtureWorkerStartupView(f.brain)];
  const helper = spyOn(identity, "workerIdentityHelper").mockReturnValue(IDENTITY_HELPER);
  const launch = (startupView: (typeof views)[number]) => ({ brainPath: f.brain, startupView, command: ["/bin/true"], env: {} });
  const ready = () => { throw new Error("worker_identity_setup_timed_out"); };
  const runs = async (work: () => Promise<unknown>) => {
    const seam = seamBroker({ ready });
    const spawns = identityControlSpawns();
    try {
      const refusal = await work().then(() => undefined, (error: unknown) => error);
      return { refusal: (refusal as WorkerHostError).requirement, spawns: spawns.counts(), operations: seam.operations() };
    } finally { spawns.restore(); await seam.restore(); }
  };
  try {
    const awaited = await runs(() => launchAgentWorkerAsync(launch(views[0]!)));
    const blocking = await runs(async () => launchAgentWorker(launch(views[1]!)));
    expect(awaited, "ASYNC_LAUNCH_AWAITS_BROKER_CLOSE").toEqual({ refusal: "worker_identity_setup_timed_out", spawns: { sync: 0, async: 1 }, operations: [["close"]] });
    expect(blocking, "SYNC_LAUNCH_KEEPS_BLOCKING_BROKER_CLOSE").toEqual({ refusal: "worker_identity_setup_timed_out", spawns: { sync: 1, async: 0 }, operations: [["close"]] });
  } finally { helper.mockRestore(); for (const view of views) view.cleanup(); f.cleanup(); }
});

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
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
    hooks: { finished: () => finished, finish: () => { finished = true; }, release: async () => { released++; } } };
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

test("a broker release that cannot confirm cleanup after the exit refuses that exit, handled (#2854)", async () => {
  const requests = statusRequests([{ exited: true, code: 0 }], 1);
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", record);
  let finished = false;
  try {
    const refusal = await identityWorkerExit(requests.status, new Promise<number>(() => {}), { finished: () => finished,
      finish: () => { finished = true; }, release: async () => { throw new identity.WorkerIdentityCleanupError("worker_identity_cleanup_unconfirmed: fixture"); } })
      .then(code => code, (error: unknown) => error);
    expect(identity.workerCleanupUnconfirmed(refusal), "IDENTITY_EXIT_RELEASE_FAILURE_OBSERVABLE").toBe(true);
    await Bun.sleep(20);
    expect(unhandled, "IDENTITY_RELEASE_FAILURE_HANDLED").toEqual([]);
  } finally { process.off("unhandledRejection", record); requests.stop(); }
});

test("an exit settles only once its release has, and a failed supervision is refused without one (#2854)", async () => {
  const requests = statusRequests([{ exited: true, code: 0 }], 1);
  const release = Promise.withResolvers<void>();
  let finished = false, releases = 0, settled = false;
  try {
    const exit = identityWorkerExit(requests.status, new Promise<number>(() => {}), { finished: () => finished,
      finish: () => { finished = true; }, release: () => { releases++; return release.promise; } }).finally(() => { settled = true; });
    while (!releases) await Bun.sleep(5);
    await Bun.sleep(20);
    expect(settled, "IDENTITY_EXIT_AWAITS_ITS_RELEASE").toBe(false);
    release.resolve();
    expect(await exit).toBe(0);
  } finally { requests.stop(); }
  const failed = statusRequests([{ exited: true, code: 0, failure: "the worker could not be confined" }], 1);
  const owner = supervision();
  try {
    await identityWorkerExit(failed.status, new Promise<number>(() => {}), owner.hooks).catch(() => {});
    // Its owner terminates the worker before it closes the broker.
    expect(owner.state(), "FAILED_SUPERVISION_LEAVES_RELEASE_TO_ITS_OWNER").toEqual({ finished: true, released: 0 });
  } finally { failed.stop(); }
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
      released: async () => {}, kill: (signal?: NodeJS.Signals) => { child.kill(signal); } } as unknown as LaunchedWorker;
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
      released: async () => {}, kill: (signal?: NodeJS.Signals) => { started.kill(signal); } } as unknown as LaunchedWorker;
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
type Broker = ReturnType<typeof identity.prepareWorkerIdentity>;

/** A real broker whose ready file names `supervisor` as its same-UID supervisor. */
function readyBroker(supervisor: number): Broker {
  const broker = identity.prepareWorkerIdentity(IDENTITY_HELPER, ["/bin/true"], []);
  try {
    const { ready } = JSON.parse(broker.command.at(-1)!) as { ready: string };
    writeFileSync(ready, JSON.stringify({ ok: true, workerUid: process.getuid!() + 1, worker: { pid: 2, start: "1" }, roots: {} }));
    broker.ready(supervisor, Date.now() + 5_000);
    return broker;
  } catch (error) { broker.discard(); throw error; }
}

/** The broker's private directory, which only a confirmed close (or a discard) removes. */
const brokerDirectory = (broker: Broker) => dirname((JSON.parse(broker.command.at(-1)!) as { ready: string }).ready);

test("a separate-UID broker's close is awaited with the event loop free, and the synchronous close still blocks", async () => {
  const brokers: Broker[] = [], controls: ReturnType<typeof identityControl>[] = [];
  try {
    for (const delayMs of [200, 200]) {
      const broker = identity.prepareWorkerIdentity(IDENTITY_HELPER, ["/bin/true"], []);
      brokers.push(broker);
      controls.push(identityControl(broker, { delayMs }));
    }
    const [awaitedBroker, blockingBroker] = brokers as [Broker, Broker];
    for (const control of controls) await control.listening();
    const spawns = identityControlSpawns();
    let awaited, blocked;
    try {
      awaited = { ...await ticksDuring(() => runWorkerStepsAsync(awaitedBroker.closeSteps())), spawns: spawns.counts() };
      blocked = { ...await ticksDuring(async () => blockingBroker.close()), spawns: spawns.counts() };
    } finally { spawns.restore(); }
    expect(awaited.spawns, "ASYNC_BROKER_CLOSE_SPAWNS_NO_SYNC_CONTROL_CLIENT").toEqual({ sync: 0, async: 1 });
    expect(awaited.ticks, "ASYNC_BROKER_CLOSE_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
    // The measure can fail: the synchronous close still blocks for the same reply (counts are cumulative).
    expect(blocked.spawns, "SYNC_BROKER_CLOSE_KEEPS_SYNC_CONTROL_CLIENT").toEqual({ sync: 1, async: 1 });
    expect(blocked.ticks, "SYNC_BROKER_CLOSE_BLOCKS").toBe(0);
    expect(controls.map(control => control.operations())).toEqual([["close", "close:answered"], ["close", "close:answered"]]);
    expect(brokers.map(broker => existsSync(brokerDirectory(broker))), "CONFIRMED_CLOSE_RELEASES_BROKER").toEqual([false, false]);
    // A closed broker is closed once: neither form asks again.
    await runWorkerStepsAsync(awaitedBroker.closeSteps());
    blockingBroker.close();
    expect(controls.map(control => control.operations().length)).toEqual([2, 2]);
  } finally { for (const control of controls) await control.stop(); for (const broker of brokers) broker.discard(); }
});

test("an awaited close that loses control stops the supervisor and refuses unconfirmed cleanup as before, retaining authority", async () => {
  const forms = { awaited: (broker: Broker) => runWorkerStepsAsync(broker.closeSteps()), blocking: async (broker: Broker) => broker.close() };
  for (const [form, close] of Object.entries(forms)) {
    // No control socket: the client fails, the supervisor is stopped, and the
    // fallback's helper (absent here) cannot confirm the cleanup.
    const supervisor = Bun.spawn(["/bin/sh", "-c", "exec sleep 30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let broker: Broker | undefined, control: ReturnType<typeof identityControl> | undefined;
    try {
      broker = readyBroker(supervisor.pid);
      const spawns = identityControlSpawns();
      let refusal: unknown, counts;
      try { refusal = await close(broker).catch((error: unknown) => error); counts = spawns.counts(); } finally { spawns.restore(); }
      expect({ form, unconfirmed: identity.workerCleanupUnconfirmed(refusal) }, "CLOSE_REFUSES_UNCONFIRMED_CLEANUP").toEqual({ form, unconfirmed: true });
      expect({ form, message: String((refusal as Error).message).split(":")[0] }).toEqual({ form, message: "worker_identity_cleanup_unconfirmed" });
      expect({ form, signal: (await supervisor.exited, supervisor.signalCode) }, "CONTROL_LOSS_STOPS_SUPERVISOR").toEqual({ form, signal: "SIGKILL" });
      // Control client, supervisor stop (twice: on the lost request and before the fallback) and the fallback itself.
      expect({ form, spawns: counts }, "CLOSE_FORM_RUNS_ITS_CONTROL_SUBPROCESSES").toEqual(form === "awaited"
        ? { form, spawns: { sync: 0, async: 4 } } : { form, spawns: { sync: 4, async: 0 } });
      // Authority is retained: a later close that obtains a confirmed answer asks again and releases it.
      expect({ form, retained: existsSync(brokerDirectory(broker)) }, "UNCONFIRMED_CLOSE_RETAINS_AUTHORITY").toEqual({ form, retained: true });
      control = identityControl(broker);
      await control.listening();
      await close(broker);
      expect({ form, operations: control.operations(), released: !existsSync(brokerDirectory(broker)) }, "RETRIED_CLOSE_RELEASES_AUTHORITY")
        .toEqual({ form, operations: ["close", "close:answered"], released: true });
    } finally { await control?.stop(); supervisor.kill("SIGKILL"); await supervisor.exited; broker?.discard(); }
  }
});

test("the brain view's broker requests are awaited with the event loop free", async () => {
  const f = fixture();
  const holder = Bun.spawn(["/usr/bin/python3", "-I", "-S", "-c", "import os,sys,time\nfd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY)\nprint(fd,flush=True)\ntime.sleep(30)", f.brain],
    { env: {}, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const reader = holder.stdout.getReader();
  let broker: Broker | undefined, control: ReturnType<typeof identityControl> | undefined;
  try {
    let line = "";
    while (!line.includes("\n")) { const next = await reader.read(); if (next.done) throw new Error("view holder exited"); line += new TextDecoder().decode(next.value); }
    const info = statSync(f.brain);
    broker = readyBroker(holder.pid);
    control = identityControl(broker, { delayMs: 100, replies: { view: { ok: true, fd: Number(line.trim()), dev: info.dev, ino: info.ino } } });
    await control.listening();
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
    expect(control.operations()).toEqual(["view", "view:answered", "unview", "unview:answered"]);
  } finally { await control?.stop(); broker?.discard(); reader.releaseLock(); holder.kill("SIGKILL"); await holder.exited; f.cleanup(); }
});

/**
 * `prepareWorkerIdentity` at the launcher's seam: the real broker, whose
 * close runs its real control client against a stand-in socket, with the
 * supervisor's setup and status answered in place of a root-owned helper.
 * The trace records when the close starts and finishes, and when the launch
 * kills its worker.
 */
function seamBroker(answers: { ready?: () => never; status?: IdentityWorkerStatus; close?: object; command?: string[] },
  launched: () => ReturnType<typeof Bun.spawn>[] = () => []) {
  const prepare = identity.prepareWorkerIdentity;
  const controls: ReturnType<typeof identityControl>[] = [], brokers: Broker[] = [], trace: string[] = [];
  const spy = spyOn(identity, "prepareWorkerIdentity").mockImplementation((...args: Parameters<typeof prepare>) => {
    const real = prepare(...args);
    brokers.push(real);
    const control = identityControl(real, { delayMs: 200, ...(answers.close ? { replies: { close: answers.close } } : {}) });
    controls.push(control);
    return { ...real, command: answers.command ?? ["/bin/sh", "-c", "exit 0"],
      *readySteps() {
        for (const child of launched()) {
          const kill = child.kill.bind(child);
          child.kill = (signal?: number | NodeJS.Signals) => { trace.push("worker-killed"); kill(signal); };
        }
        while (!control.ready()) yield* workerStepSleep(1);
        if (answers.ready) answers.ready();
        return { ok: true as const, workerUid: process.getuid!() + 1, worker: { pid: 2, start: "1" }, roots: {} };
      },
      *requestSteps<T extends object>(operation: string): WorkerSteps<T> {
        yield* workerStepSleep(1);
        return (operation === "status" ? answers.status : { ok: true }) as T;
      },
      *closeSteps() {
        trace.push("close");
        try { yield* real.closeSteps(); } finally { trace.push("closed"); }
      } };
  });
  return { operations: () => controls.map(control => control.operations()), trace,
    restore: async () => { spy.mockRestore(); for (const control of controls) await control.stop(); for (const broker of brokers) broker.discard(); } };
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
    // Either way the probe answers only after the supervisor's reply to the close.
    for (const status of [{ exited: true, code: 0 }, { exited: true, code: 0, failure: "the worker could not be confined" }]) {
      const awaited = await runs(status, () => probeWorkerHostAsync(f.brain));
      const blocking = await runs(status, async () => probeWorkerHost(f.brain));
      expect({ status, ...awaited }, "ASYNC_PROBE_AWAITS_BROKER_CLOSE").toEqual({ status, spawns: { sync: 0, async: 1 }, operations: [["close", "close:answered"]] });
      expect({ status, ...blocking }, "SYNC_PROBE_KEEPS_BLOCKING_BROKER_CLOSE").toEqual({ status, spawns: { sync: 1, async: 0 }, operations: [["close", "close:answered"]] });
    }
  } finally { helper.mockRestore(); f.cleanup(); }
});

test("a failed asynchronous launch closes its separate-UID broker through awaited steps before it kills the worker and refuses", async () => {
  const f = fixture();
  const views = [0, 1, 2, 3].map(() => createFixtureWorkerStartupView(f.brain));
  const helper = spyOn(identity, "workerIdentityHelper").mockReturnValue(IDENTITY_HELPER);
  const launch = (startupView: (typeof views)[number]) => ({ brainPath: f.brain, startupView, command: ["/bin/true"], env: {} });
  const ready = () => { throw new Error("worker_identity_setup_timed_out"); };
  const runs = async (work: () => Promise<unknown>, close?: object) => {
    const spawns = identityControlSpawns();
    // The worker outlives its failed setup unless the launch kills it.
    const seam = seamBroker({ ready, command: ["/bin/sh", "-c", "exec sleep 30"], ...(close ? { close } : {}) }, spawns.launches);
    try {
      const refusal = await work().then(() => new Error("launch_succeeded"), (error: unknown) => error) as Error & { requirement?: string };
      const killed = await Promise.all(spawns.launches().map(async child => (await child.exited, child.signalCode)));
      return { refusal: refusal.requirement ?? refusal.message.split(":")[0], unconfirmed: identity.workerCleanupUnconfirmed(refusal),
        spawns: spawns.counts(), operations: seam.operations(), trace: seam.trace, killed };
    } finally { spawns.restore(); await seam.restore(); }
  };
  try {
    const confirmed = { refusal: "worker_identity_setup_timed_out", unconfirmed: false, operations: [["close", "close:answered"]],
      trace: ["close", "closed", "worker-killed"], killed: ["SIGKILL" as NodeJS.Signals] };
    expect(await runs(() => launchAgentWorkerAsync(launch(views[0]!))), "ASYNC_LAUNCH_AWAITS_BROKER_CLOSE")
      .toEqual({ ...confirmed, spawns: { sync: 0, async: 1 } });
    expect(await runs(async () => launchAgentWorker(launch(views[1]!))), "SYNC_LAUNCH_KEEPS_BLOCKING_BROKER_CLOSE")
      .toEqual({ ...confirmed, spawns: { sync: 1, async: 0 } });
    // A close the supervisor refuses still refuses the launch as unconfirmed cleanup, in both forms.
    const refused = { ...confirmed, refusal: "worker_identity_setup_cleanup_unconfirmed", unconfirmed: true };
    expect(await runs(() => launchAgentWorkerAsync(launch(views[2]!)), { ok: false }), "ASYNC_LAUNCH_REFUSES_UNCONFIRMED_CLOSE")
      .toEqual({ ...refused, spawns: { sync: 0, async: 1 } });
    expect(await runs(async () => launchAgentWorker(launch(views[3]!)), { ok: false }), "SYNC_LAUNCH_REFUSES_UNCONFIRMED_CLOSE")
      .toEqual({ ...refused, spawns: { sync: 1, async: 0 } });
  } finally { helper.mockRestore(); for (const view of views) view.cleanup(); f.cleanup(); }
});

// #2854: the broker close after an asynchronous launch has returned: the last
// handle's, a zero-handle exit's and a failed supervision's.

/**
 * The launcher's seam with held roots. The worker holds each requested root's
 * directory on descriptor 7 (state) or 8 (turn temp), as a supervisor holds
 * its tmpfs roots, and its exit is whatever `status` answers. The broker and
 * its close are real, against a stand-in control socket whose close reply can
 * be changed between attempts.
 */
function heldRootSeam(f: ReturnType<typeof fixture>, status: () => IdentityWorkerStatus) {
  const prepare = identity.prepareWorkerIdentity;
  const roots = { state: join(f.root, "state-root"), temp: join(f.root, "temp-root") };
  for (const root of Object.values(roots)) mkdirSync(root);
  let broker: Broker | undefined, control: ReturnType<typeof identityControl> | undefined;
  const spy = spyOn(identity, "prepareWorkerIdentity").mockImplementation((...args: Parameters<typeof prepare>) => {
    const real = broker = prepare(...args);
    control = identityControl(real, { delayMs: 100 });
    const requested = new Set(args[2].map(root => root.name));
    return { ...real, command: ["/bin/sh", "-c", 'exec 7<"$1" 8<"$2"; exec sleep 30', "sh", roots.state, roots.temp],
      *readySteps(supervisor: number) {
        // Until its bootstrap has executed the shell, those descriptors are the bootstrap's own.
        const holds = (fd: number, root: string) => { try { return readlinkSync(`/proc/${supervisor}/fd/${fd}`) === root; } catch { return false; } };
        while (!control!.ready() || !holds(7, roots.state) || !holds(8, roots.temp)) yield* workerStepSleep(1);
        return { ok: true as const, workerUid: process.getuid!() + 1, worker: { pid: supervisor, start: "1" }, roots: {
          ...(requested.has("state") ? { state: { fd: 7, dev: 0, ino: 0 } } : {}), ...(requested.has("temp") ? { temp: { fd: 8, dev: 0, ino: 0 } } : {}) } };
      },
      *requestSteps<T extends object>(operation: string): WorkerSteps<T> {
        yield* workerStepSleep(1);
        return (operation === "status" ? status() : { ok: true }) as T;
      } };
  });
  return {
    operations: () => control?.operations() ?? [],
    /** The broker's private directory, which only a confirmed close removes. */
    retained: () => existsSync(brokerDirectory(broker!)),
    /** Answer the next closes with `reply`, from a new stand-in on the same socket. */
    answerClose: async (reply?: object) => {
      await control!.stop();
      // The stale socket would answer `listening()` before the new stand-in has bound it.
      rmSync(control!.socket, { force: true });
      control = identityControl(broker!, { delayMs: 100, ...(reply ? { replies: { close: reply } } : {}) });
      await control.listening();
    },
    restore: async () => { spy.mockRestore(); await control?.stop(); broker?.discard(); },
  };
}

/** Launch through the seam, with both handles unless `handles` is false; `exit()` makes the supervisor report the worker gone. */
async function heldRootLaunch(handles = true, answer: IdentityWorkerStatus = { exited: true, code: 0 }) {
  const f = fixture(), view = createFixtureWorkerStartupView(f.brain);
  const helper = spyOn(identity, "workerIdentityHelper").mockReturnValue(IDENTITY_HELPER);
  let gone = false;
  const seam = heldRootSeam(f, () => gone ? answer : { exited: false, code: null });
  let worker: LaunchedWorker | undefined;
  try {
    worker = await launchAgentWorkerAsync({ brainPath: f.brain, startupView: view, command: ["/bin/true"], env: {},
      ...(handles ? { stateBytes: 1024 * 1024, turnTempBytes: 1024 * 1024 } : {}) });
  } catch (error) { helper.mockRestore(); await seam.restore(); view.cleanup(); f.cleanup(); throw error; }
  const launched = worker;
  launched.stdin.end(); launched.stdout.resume(); launched.stderr.resume();
  return { worker: launched, seam,
    exit: () => { gone = true; },
    cleanup: async () => {
      try { process.kill(launched.pid, "SIGKILL"); } catch { /* already gone */ }
      await launched.exited.catch(() => {});
      helper.mockRestore(); await seam.restore(); view.cleanup(); f.cleanup();
    } };
}

const settledWithin = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise.then(() => "settled", () => "settled"), Bun.sleep(ms).then(() => "pending")]);

test("an asynchronously launched separate-UID worker's exit settles with handles held, and its last handle closes the broker through awaited steps", async () => {
  for (const order of ["sequential", "concurrent"] as const) {
    const run = await heldRootLaunch();
    try {
      run.exit();
      // The exit settles while both handles are held, without closing the broker.
      expect({ order, exited: await run.worker.exited, operations: run.seam.operations() }, "EXIT_SETTLES_WHILE_HANDLES_HELD")
        .toEqual({ order, exited: 0, operations: [] });
      const spawns = identityControlSpawns();
      let closes, ticks;
      try {
        if (order === "sequential") {
          // Releasing a handle that is not the last waits for nothing.
          expect(await settledWithin(run.worker.state!.closeAsync(), 50), "NON_FINAL_HANDLE_RELEASE_DOES_NOT_WAIT").toBe("settled");
          expect(run.seam.operations(), "NON_FINAL_HANDLE_KEEPS_BROKER").toEqual([]);
          ({ ticks } = await ticksDuring(() => run.worker.turnTemp!.closeAsync()));
        } else {
          ({ ticks } = await ticksDuring(() => Promise.all([run.worker.state!.closeAsync(), run.worker.turnTemp!.closeAsync(),
            run.worker.turnTemp!.closeAsync(), run.worker.state!.closeAsync()])));
        }
        closes = spawns.operations();
      } finally { spawns.restore(); }
      expect({ order, closes }, "LAST_HANDLE_CLOSES_BROKER_THROUGH_AWAITED_STEPS").toEqual({ order, closes: { sync: [], async: ["close"] } });
      expect({ order, free: ticks > 0 }, "LAST_HANDLE_CLOSE_LEAVES_EVENT_LOOP_FREE").toEqual({ order, free: true });
      expect({ order, operations: run.seam.operations(), retained: run.seam.retained() }, "ONE_CONFIRMED_BROKER_CLOSE")
        .toEqual({ order, operations: ["close", "close:answered"], retained: false });
      // Closed handles stay closed: neither form asks again.
      await run.worker.turnTemp!.closeAsync(); run.worker.state!.close();
      expect(run.seam.operations()).toEqual(["close", "close:answered"]);
    } finally { await run.cleanup(); }
  }
});

test("an unconfirmed last-handle close rejects every waiter once, retains the broker, and a retry releases it without a second reference release", async () => {
  const run = await heldRootLaunch();
  try {
    run.exit();
    await run.worker.exited;
    await run.seam.answerClose({ ok: false });
    await run.worker.state!.closeAsync();
    const refusals = await Promise.all([run.worker.turnTemp!.closeAsync(), run.worker.turnTemp!.closeAsync()].map(close => close.then(() => undefined, (error: unknown) => error)));
    expect(refusals.map(identity.workerCleanupUnconfirmed), "UNCONFIRMED_LAST_HANDLE_CLOSE_REJECTS").toEqual([true, true]);
    expect({ operations: run.seam.operations(), retained: run.seam.retained() }, "UNCONFIRMED_CLOSE_SHARED_AND_RETAINS_BROKER")
      .toEqual({ operations: ["close", "close:answered"], retained: true });
    // A retry from either handle closes again. Had either reference been
    // released twice, the count would not reach zero and nothing would close.
    await run.seam.answerClose();
    await run.worker.state!.closeAsync();
    expect(run.seam.operations(), "CLOSED_NON_FINAL_HANDLE_DOES_NOT_RETRY").toEqual([]);
    const spawns = identityControlSpawns();
    try { await run.worker.turnTemp!.closeAsync(); expect(spawns.operations(), "RETRY_CLOSES_THROUGH_AWAITED_STEPS").toEqual({ sync: [], async: ["close"] }); }
    finally { spawns.restore(); }
    expect({ operations: run.seam.operations(), retained: run.seam.retained() }, "RETRIED_CLOSE_RELEASES_BROKER")
      .toEqual({ operations: ["close", "close:answered"], retained: false });
  } finally { await run.cleanup(); }
});

test("a separate-UID worker's exit with no handle held closes its broker through awaited steps before it settles, and refuses an unconfirmed close", async () => {
  for (const reply of [undefined, { ok: false }]) {
    const run = await heldRootLaunch(false);
    try {
      if (reply) await run.seam.answerClose(reply);
      const spawns = identityControlSpawns();
      let outcome: unknown, closes;
      try {
        run.exit();
        outcome = await run.worker.exited.then(code => code, (error: unknown) => error);
        closes = spawns.operations();
      } finally { spawns.restore(); }
      expect({ reply, closes }, "ZERO_HANDLE_EXIT_CLOSES_BROKER_THROUGH_AWAITED_STEPS").toEqual({ reply, closes: { sync: [], async: ["close"] } });
      // The exit settled only after the supervisor answered the close.
      expect({ reply, operations: run.seam.operations() }).toEqual({ reply, operations: ["close", "close:answered"] });
      if (!reply) expect(outcome, "ZERO_HANDLE_EXIT_SETTLES_AFTER_CONFIRMED_CLOSE").toBe(0);
      else {
        expect(identity.workerCleanupUnconfirmed(outcome), "ZERO_HANDLE_EXIT_REFUSES_UNCONFIRMED_CLOSE").toBe(true);
        expect(run.seam.retained(), "UNCONFIRMED_EXIT_CLOSE_RETAINS_BROKER").toBe(true);
      }
    } finally { await run.cleanup(); }
  }
});

test("a failed supervision terminates its worker before an awaited broker close, and an unconfirmed close stays the exit's refusal", async () => {
  const failure = { exited: true, code: 0, failure: "the worker could not be confined" };
  for (const reply of [undefined, { ok: false }]) {
    const run = await heldRootLaunch(false, failure);
    try {
      if (reply) await run.seam.answerClose(reply);
      const spawns = identityControlSpawns();
      let refusal: unknown, requests;
      try {
        run.exit();
        refusal = await run.worker.exited.then(() => new Error("exit_succeeded"), (error: unknown) => error);
        requests = spawns.operations();
      } finally { spawns.restore(); }
      // Termination is a synchronous signal request (out of #2854's scope); the close is awaited.
      expect({ reply, requests }, "EXIT_REJECTION_CLOSES_BROKER_THROUGH_AWAITED_STEPS").toEqual({ reply, requests: { sync: ["signal"], async: ["close"] } });
      expect({ reply, operations: run.seam.operations() }, "TERMINATION_PRECEDES_BROKER_CLOSE")
        .toEqual({ reply, operations: ["signal", "signal:answered", "close", "close:answered"] });
      const error = refusal as WorkerHostError;
      if (!reply) expect({ requirement: error.requirement, unconfirmed: identity.workerCleanupUnconfirmed(error) }, "FAILED_SUPERVISION_REFUSED_AS_BEFORE")
        .toEqual({ requirement: "worker_identity_supervision_failed: the worker could not be confined", unconfirmed: false });
      else {
        expect(identity.workerCleanupUnconfirmed(error), "EXIT_REJECTION_REFUSES_UNCONFIRMED_CLOSE").toBe(true);
        expect(error.message, "EXIT_REJECTION_KEEPS_ORIGINAL_FAILURE").toContain("worker_identity_supervision_failed");
      }
    } finally { await run.cleanup(); }
  }
  // With handles held, the failed exit leaves the close to the last of them.
  const held = await heldRootLaunch(true, failure);
  try {
    held.exit();
    await held.worker.exited.catch(() => {});
    expect(held.seam.operations(), "FAILED_EXIT_WITH_HANDLES_DEFERS_CLOSE").toEqual(["signal", "signal:answered"]);
    await held.worker.state!.closeAsync(); await held.worker.turnTemp!.closeAsync();
    expect(held.seam.operations()).toEqual(["signal", "signal:answered", "close", "close:answered"]);
  } finally { await held.cleanup(); }
});

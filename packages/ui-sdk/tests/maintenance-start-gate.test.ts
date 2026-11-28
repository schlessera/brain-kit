/**
 * #4301 commit C2: the direct-spawn maintenance launches (L2
 * `launchMaintenanceWorker`/`runMaintenanceWorker`, L3
 * stays on main's spawnSync and walks (#4301 path O5)) waits at START_GATE before its
 * payload starts. These pin what must not change (G1-G13 of the design).
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchMaintenanceWorker, runMaintenanceWorker, runMaintenanceWorkerSync } from "../src/server/maintenance-worker";
import * as workerStatus from "../src/server/worker-status";
import { WorkerHostError } from "../src/server/worker-launcher";
import { probeWorkerHost } from "../src/server/worker-launcher";
import { createOutputStagingStorage } from "./helpers/worker-copy-output";
import { createFixtureWorkerStartupView } from "./helpers/worker-startup-view-fixture";
import { watchdogMs } from "../../../scripts/test-deadlines.js";

const ROOT = resolve(import.meta.dir, "../../..");
const BUN = realpathSync(process.execPath);
const roots: string[] = [];
const cleanups: (() => void)[] = [];
beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const probe = mkdtempSync(join(ROOT, "tmp/maintenance-gate-probe-"));
  try { const result = probeWorkerHost(probe); if (!result.ok) throw new Error(result.requirement); }
  finally { rmSync(probe, { recursive: true, force: true }); }
});
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(ROOT, "tmp/maintenance-gate-")); roots.push(root);
  const brain = join(root, "brain"); mkdirSync(brain); mkdirSync(join(root, "state"));
  writeFileSync(join(brain, "ithaca.md"), "Odysseus sails for Ithaca.\n");
  const startupView = createFixtureWorkerStartupView(brain); cleanups.push(startupView.cleanup);
  return { root, brain, startupView, tempDomain: { statePath: join(root, "state/ui.db") } };
}
const command = (f: ReturnType<typeof fixture>, argv: string[]) => ({ brainPath: f.brain, startupView: f.startupView, tempDomain: f.tempDomain,
  command: argv, env: { PATH: "/usr/bin:/bin" }, credentials: false });
const sh = (script: string) => ["/bin/sh", "-c", script];
const openFds = () => readdirSync("/proc/self/fd").length;

describe("L2 runMaintenanceWorker", () => {
  test("G1: a large streamed stdin arrives whole; a command that never reads it does not hang", async () => {
    const f = fixture();
    const chunk = new Uint8Array(64 * 1024).fill(0x6f);
    async function* input() { for (let i = 0; i < 64; i++) yield chunk; }
    const read = await runMaintenanceWorker({ ...command(f, [BUN, "-e", "let n=0; for await (const c of Bun.stdin.stream()) n+=c.byteLength; console.log(n)"]), stdin: input(), timeoutMs: 20_000 });
    expect(read.exitCode, read.stderr).toBe(0);
    expect(read.stdout.trim(), "G1_STDIN_WHOLE").toBe(String(64 * 64 * 1024));
    const unread = await runMaintenanceWorker({ ...command(f, sh("exit 0")), stdin: input(), timeoutMs: 20_000 });
    expect(unread, "G1_UNREAD_STDIN_DOES_NOT_HANG").toMatchObject({ exitCode: 0, killed: false });
  }, watchdogMs(60_000));

  test("G2: the gate consumes none of the payload's stdin, even a line that reads like its own", async () => {
    const f = fixture();
    const result = await runMaintenanceWorker({ ...command(f, sh("sleep 0.2; cat")), stdin: "go\nPenelope weaves\n", timeoutMs: 20_000 });
    expect(result.stdout, "G2_STDIN_INTACT").toBe("go\nPenelope weaves\n");
  }, watchdogMs(30_000));

  test("G3: an abort during the awaited launch and one after it kill the worker and settle", async () => {
    const f = fixture();
    const early = new AbortController();
    const during = runMaintenanceWorker({ ...command(f, sh("sleep 30")), signal: early.signal, timeoutMs: 60_000 }, () => queueMicrotask(() => early.abort()));
    await expect(during, "G3_ABORT_DURING_LAUNCH").rejects.toThrow();
    const late = new AbortController(), started = performance.now();
    const after = runMaintenanceWorker({ ...command(f, sh("sleep 30")), signal: late.signal, timeoutMs: 60_000 });
    setTimeout(() => late.abort(), 500);
    await expect(after, "G3_ABORT_AFTER_LAUNCH").rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(15_000);
  }, watchdogMs(60_000));

  test("G4: the output cap kills the worker and reports killed", async () => {
    const f = fixture();
    const result = await runMaintenanceWorker({ ...command(f, [BUN, "-e", "process.stdout.write(Buffer.alloc(4*1024*1024, 111)); await Bun.sleep(30000)"]), outputBytes: 1024, timeoutMs: 60_000 });
    expect(result.killed, "G4_OUTPUT_CAP_KILLS").toBe(true);
  }, watchdogMs(60_000));

  test("G7: released() settles once the worker's stdio is released", async () => {
    const f = fixture();
    const worker = launchMaintenanceWorker(command(f, sh("printf Telemachus")));
    const [stdout] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.input(""), worker.exited]);
    await worker.released();
    expect(stdout, "G7_OUTPUT").toBe("Telemachus");
  }, watchdogMs(30_000));

  test("G11: with an output workspace (the nsenter path) the worker starts and writes its stage", async () => {
    const f = fixture();
    const storage = createOutputStagingStorage({ allowanceBytes: 4 * 1024 * 1024, budgetBytes: 4 * 1024 * 1024 }, f.startupView.root);
    storage.retain(); cleanups.push(() => storage.release());
    const result = await runMaintenanceWorker({ ...command(f, sh('printf ithaca > "$BRAIN_ROOT/landfall" && cat "$BRAIN_WORKER_CONFIG_ROOT/ithaca.md"')),
      output: { source: storage.root, target: "/tmp/brain-maintenance-output", storage }, timeoutMs: 20_000 });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout, "G11_OUTPUT_WORKSPACE_STARTS").toBe("Odysseus sails for Ithaca.\n");
    expect(readFileSync(join(storage.root, "landfall"), "utf8"), "G11_OUTPUT_WORKSPACE_WRITTEN").toBe("ithaca");
  }, watchdogMs(30_000));
});

describe("both paths", () => {
  test("G6: exit codes 0, 7, 125, 126, 127 and a signal death report exactly as before", async () => {
    const f = fixture();
    const cases: [string[], number][] = [[sh("exit 0"), 0], [sh("exit 7"), 7], [sh("exit 125"), 125], [sh("exit 126"), 126], [sh("exit 127"), 127], [sh("kill -9 $$"), 137]];
    for (const [argv, code] of cases) {
      const options = { ...command(f, argv), timeoutMs: 20_000 };
      expect((await runMaintenanceWorker(options)).exitCode, `G6_L2_${code}`).toBe(code);
    }
  }, watchdogMs(120_000));

  test("G8: the temp reservation and the startup view are released on success, on spawn refusal and on a sandbox setup failure", async () => {
    const f = fixture();
    // One allowance fills the budget: any leaked reservation refuses the next launch.
    const tempLimits = { allowanceBytes: 4 * 1024 * 1024, budgetBytes: 4 * 1024 * 1024 };
    const base = { ...command(f, sh("exit 0")), tempLimits, timeoutMs: 20_000 };
    for (let i = 0; i < 3; i++) {
      expect((await runMaintenanceWorker(base)).exitCode, "G8_SUCCESS_RELEASES").toBe(0);
      await expect(runMaintenanceWorker({ ...base, command: ["odysseus"] }), "G8_SPAWN_REFUSAL").rejects.toThrow();
    }
    expect(existsSync(f.startupView.root), "G8_CALLER_VIEW_KEPT").toBe(true);
  }, watchdogMs(120_000));

  test("G8b: a sandbox setup failure reports bubblewrap's own exit code and stderr, never a throw, 20 times", async () => {
    const f = fixture();
    // The writable file exists when the argv is built and is gone when bubblewrap
    // binds it: bubblewrap itself fails its setup and starts no payload.
    const log = join(f.root, "voyage.log");
    const failing = { ...command(f, sh("exit 0")), writeFiles: [log], timeoutMs: 20_000 };
    const spawn = Bun.spawn;
    const spy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
      if ((args[1] as { env?: Record<string, string> } | undefined)?.env?.BRAIN_WORKER_LAUNCH) rmSync(log, { force: true });
      return (spawn as (...a: unknown[]) => unknown)(...args);
    }) as typeof Bun.spawn);
    cleanups.push(() => spy.mockRestore());
    for (let i = 0; i < 20; i++) {
      writeFileSync(log, "");
      const result = await runMaintenanceWorker(failing);
      expect(result.exitCode, "G8B_SETUP_FAILURE_EXIT").not.toBe(0);
      expect(result.stderr, "G8B_SETUP_FAILURE_STDERR").toContain("bwrap");
    }
  }, watchdogMs(240_000));

  test("G9: no descriptor leaks after 200 launches", async () => {
    const f = fixture();
    const options = { ...command(f, sh("exit 0")), timeoutMs: 20_000 };
    await runMaintenanceWorker(options);
    await Bun.sleep(50);
    const before = openFds();
    for (let i = 0; i < 200; i++) await runMaintenanceWorker(options);
    await Bun.sleep(200);
    expect(openFds(), "G9_NO_DESCRIPTOR_LEAK").toBeLessThanOrEqual(before);
  }, watchdogMs(240_000));

  test("G13: eight concurrent launches all start and all release", async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runMaintenanceWorker({ ...command(f, sh(`printf ${i}`)),
      tempLimits: { allowanceBytes: 4 * 1024 * 1024, budgetBytes: 64 * 1024 * 1024 }, timeoutMs: 30_000 })));
    expect(results.map(result => result.stdout), "G13_CONCURRENT_START").toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  }, watchdogMs(60_000));
});

/** Stop the launch's outer process as soon as it is spawned: bubblewrap never reports, the gate's PID wait stalls. */
function stallSetup() {
  const spawn = Bun.spawn;
  const spy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
    const child = (spawn as (...a: unknown[]) => ReturnType<typeof Bun.spawn>)(...args);
    if ((args[1] as { env?: Record<string, string> } | undefined)?.env?.BRAIN_WORKER_LAUNCH) process.kill(child.pid, "SIGSTOP");
    return child;
  }) as typeof Bun.spawn);
  cleanups.push(() => spy.mockRestore());
}

describe("L2 gate lifecycle (#5016 review r1)", () => {
  test("G5: a timeout counted from the spawn stops the launch unreleased: killed, the payload never runs, the gate says so", async () => {
    const f = fixture();
    const options = { ...command(f, sh("printf ran")), timeoutMs: 1 };
    // SIGKILL, as the caller's timer sends it: 137, never SIGTERM's 143 (F4).
    expect(await runMaintenanceWorker(options), "G5_DEADLINE_COUNTS_FROM_SPAWN").toMatchObject({ killed: true, exitCode: 137, stdout: "" });
    const worker = launchMaintenanceWorker({ ...options } as Parameters<typeof launchMaintenanceWorker>[0]);
    expect(worker.gate?.timedOut, "G5_GATE_STOPPED_UNRELEASED").toBe(true);
    await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.input(""), worker.exited]);
    await worker.released();
  }, watchdogMs(30_000));

  test("G14 (F1, F13): an abort while the PID wait stalls rejects at once with its own reason, null included", async () => {
    const f = fixture();
    stallSetup();
    for (const reason of ["Penelope recalls the ship", null]) {
      const controller = new AbortController(), started = performance.now();
      setTimeout(() => controller.abort(reason), 300);
      const rejected = await runMaintenanceWorker({ ...command(f, sh("printf ran")), signal: controller.signal, timeoutMs: 60_000 }).then(() => "resolved", error => ({ error }));
      expect(rejected, "G14_ABORT_REASON_AS_GIVEN").toEqual({ error: reason });
      expect(performance.now() - started, "G14_ABORT_DURING_PID_WAIT_IS_PROMPT").toBeLessThan(3_000);
    }
  }, watchdogMs(60_000));

  test("G15 (F1, F4): a deadline while the PID wait stalls stops the launch with SIGKILL, as the caller's timer does: killed, 137", async () => {
    const f = fixture();
    stallSetup();
    const started = performance.now();
    const result = await runMaintenanceWorker({ ...command(f, sh("printf ran")), timeoutMs: 300 });
    expect(result, "G15_STALLED_DEADLINE_IS_SIGKILL").toMatchObject({ killed: true, exitCode: 137, stdout: "" });
    expect(performance.now() - started, "G15_DEADLINE_DURING_PID_WAIT_IS_PROMPT").toBeLessThan(3_000);
  }, watchdogMs(60_000));

  test("G16 (F2): a gate that fails while bubblewrap lives throws WorkerHostError itself, after stopping it", async () => {
    const f = fixture();
    stallSetup();
    const rejected = await runMaintenanceWorker({ ...command(f, sh("printf ran")), timeoutMs: 0 }).catch(error => error);
    expect(rejected instanceof WorkerHostError, `G16_LIVE_GATE_FAILURE_IS_WORKER_HOST_ERROR: ${rejected?.name}`).toBe(true);
  }, watchdogMs(60_000));

  test("G17 (F10): the gate runs outside the payload's rlimits; the payload keeps them", async () => {
    const f = fixture();
    const saved = process.env.BRAIN_UI_WORKER_LIMITS;
    process.env.BRAIN_UI_WORKER_LIMITS = "open_files=8";
    cleanups.push(() => { if (saved === undefined) delete process.env.BRAIN_UI_WORKER_LIMITS; else process.env.BRAIN_UI_WORKER_LIMITS = saved; });
    const result = await runMaintenanceWorker({ ...command(f, sh('printf "%s" "$(ulimit -n)"')), timeoutMs: 20_000 });
    expect(result, `G17_GATE_OUTSIDE_PAYLOAD_LIMITS: ${result.stderr}`).toMatchObject({ exitCode: 0, stdout: "8" });
  }, watchdogMs(30_000));

  test("G18 (F11): a missing payload executable keeps prlimit's own diagnostic", async () => {
    const f = fixture();
    const result = await runMaintenanceWorker({ ...command(f, ["/usr/bin/odysseus-oar"]), timeoutMs: 20_000 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr, "G18_PRLIMIT_DIAGNOSTIC_KEPT").toContain("prlimit: failed to execute");
  }, watchdogMs(30_000));

  test("G19 (F12): the gate overwrites no variable of the payload's environment", async () => {
    const f = fixture();
    const result = await runMaintenanceWorker({ ...command(f, sh('printf "%s" "$go"')), env: { PATH: "/usr/bin:/bin", go: "old" }, credentials: true, network: false, timeoutMs: 20_000 });
    expect(result.stdout, `G19_ENV_UNCHANGED: ${result.stderr}`).toBe("old");
  }, watchdogMs(30_000));
});

const restores: (() => void)[] = [];
/** Spawn spy: optionally stall the bootstrap, record every signal sent through the child handle, and run `after` once it is spawned. */
function watchSpawn(options: { stall?: boolean; after?: () => void } = {}) {
  const spawn = Bun.spawn, kills: string[] = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => {
    const child = (spawn as (...a: unknown[]) => ReturnType<typeof Bun.spawn>)(...args);
    if (!(args[1] as { env?: Record<string, string> } | undefined)?.env?.BRAIN_WORKER_LAUNCH) return child;
    if (options.stall) process.kill(child.pid, "SIGSTOP");
    const kill = child.kill.bind(child);
    Object.defineProperty(child, "kill", { configurable: true, value: (signal?: NodeJS.Signals | number) => { // Only a signal to a live supervisor counts; Bun ignores one sent after its exit.
      if (child.exitCode === null && child.signalCode === null) kills.push(String(signal ?? "SIGTERM"));
      kill(signal); } });
    options.after?.();
    return child;
  }) as typeof Bun.spawn);
  restores.push(() => spy.mockRestore());
  return kills;
}
/** Replace one step of the status channel; the rest stays real. */
function patchStatus(patch: (real: ReturnType<typeof workerStatus.createWorkerStatusPipe>) => Partial<ReturnType<typeof workerStatus.createWorkerStatusPipe>>) {
  const original = workerStatus.createWorkerStatusPipeSteps;
  const spy = spyOn(workerStatus, "createWorkerStatusPipeSteps").mockImplementation(function* () {
    const real = yield* original();
    return { ...real, ...patch(real) };
  } as typeof original);
  restores.push(() => spy.mockRestore());
}
/** Undo the spies installed so far, keeping the fixture. */
const restoreSpies = () => { for (const restore of restores.splice(0).reverse()) restore(); };
afterEach(restoreSpies);
/** Descriptors are released asynchronously once the child is gone; wait for the count to come back. */
async function descriptorsBackTo(baseline: number) {
  const until = performance.now() + 5_000;
  while (openFds() > baseline && performance.now() < until) await Bun.sleep(10);
  return openFds();
}
const environmentOf = (stdout: string) => stdout.split("\0").filter(Boolean);

describe("L2 gate (#5016 review r2): the payload starts exactly as main's bubblewrap started it", () => {
  test("F29: the payload's environment is the ungated launch's, byte for byte and in order, IFS included", async () => {
    const f = fixture();
    const env = { PATH: "/usr/bin:/bin", IFS: "odysseus", ODYSSEUS: "sails\n $HOME \\ 'Ithaca' \"Penelope\" *", PWD: "/srv/caller" };
    // A credentialed launch keeps the caller's variables as given.
    const launch = { ...command(f, ["/usr/bin/env", "-0"]), env, credentials: true, network: false, timeoutMs: 20_000 };
    const gated = await runMaintenanceWorker(launch);
    const ungated = runMaintenanceWorkerSync(launch);
    expect(gated.exitCode, gated.stderr).toBe(0);
    expect(environmentOf(gated.stdout), "F29_ENVIRONMENT_AS_UNGATED").toEqual(environmentOf(ungated.stdout));
    expect(environmentOf(gated.stdout), "F29_IFS_KEPT").toContain("IFS=odysseus");
    expect(environmentOf(gated.stdout)).toContain(`ODYSSEUS=${env.ODYSSEUS}`);
  }, watchdogMs(30_000));

  test("F34: nothing the caller's environment selects runs before release: the loader sees it exactly as often as ungated", async () => {
    const f = fixture();
    const env = { PATH: "/usr/bin:/bin", LD_PRELOAD: "/odysseus/missing-oar.so" };
    const count = (stderr: string) => stderr.split("missing-oar.so").length - 1;
    const launch = { ...command(f, ["/bin/true"]), env, credentials: true, network: false, timeoutMs: 20_000 };
    const gated = await runMaintenanceWorker(launch);
    const ungated = runMaintenanceWorkerSync(launch);
    expect(count(ungated.stderr), ungated.stderr).toBeGreaterThan(0);
    expect(count(gated.stderr), `F34_NO_CALLER_ENVIRONMENT_BEFORE_RELEASE: ${gated.stderr}`).toBe(count(ungated.stderr));
  }, watchdogMs(30_000));

  test("F30: with every rlimit off, a missing executable exits as main's bubblewrap did: 1 and its execvp diagnostic", async () => {
    const f = fixture();
    const saved = process.env.BRAIN_UI_WORKER_LIMITS;
    process.env.BRAIN_UI_WORKER_LIMITS = "processes=off,data=off,file_size=off,open_files=off";
    cleanups.push(() => { if (saved === undefined) delete process.env.BRAIN_UI_WORKER_LIMITS; else process.env.BRAIN_UI_WORKER_LIMITS = saved; });
    // A worker executable is always absolute (workerCommand refuses any other).
    for (const argv of [["/usr/bin/odysseus-oar"], ["/srv/ithaca/odysseus-oar"]]) {
      const gated = await runMaintenanceWorker({ ...command(f, argv), timeoutMs: 20_000 });
      const ungated = runMaintenanceWorkerSync({ ...command(f, argv), timeoutMs: 20_000 });
      expect(ungated, "the ungated launch is main's").toMatchObject({ exitCode: 1, stderr: `bwrap: execvp ${argv[0]}: No such file or directory\n` });
      expect({ exitCode: gated.exitCode, stderr: gated.stderr }, `F30_MISSING_EXECUTABLE_AS_UNGATED: ${argv[0]}`).toEqual({ exitCode: ungated.exitCode, stderr: ungated.stderr });
    }
  }, watchdogMs(30_000));
});

describe("L2 gate lifecycle (#5016 review r2)", () => {
  test("F25: a launch stopped before its PID is known releases its status and gate descriptors once it exits", async () => {
    const f = fixture();
    // Warm: the domain's temp accounting database opens on its first launch and stays open.
    await runMaintenanceWorker({ ...command(f, sh("exit 0")), timeoutMs: 20_000 });
    const baseline = openFds();
    watchSpawn({ stall: true });
    const worker = launchMaintenanceWorker({ ...command(f, sh("printf ran")), timeoutMs: 300 } as Parameters<typeof launchMaintenanceWorker>[0]);
    await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.input(""), worker.exited]);
    await worker.released();
    expect(await descriptorsBackTo(baseline), "F25_DESCRIPTORS_RELEASED").toBe(baseline);
  }, watchdogMs(30_000));

  test("F26: an abort or a deadline while a silent bubblewrap is given time to exit wins over the gate failure", async () => {
    const f = fixture();
    watchSpawn({ stall: true });
    const controller = new AbortController();
    patchStatus(() => ({ *childPidSteps() { yield* []; controller.abort("Penelope recalls the ship"); throw new Error("Odysseus lost the status line"); } }));
    const rejected = await runMaintenanceWorker({ ...command(f, sh("printf ran")), signal: controller.signal, timeoutMs: 60_000 }).then(() => "resolved", error => ({ error }));
    expect(rejected, "F26_ABORT_DURING_SUPERVISOR_WAIT").toEqual({ error: "Penelope recalls the ship" });
    restoreSpies();
    watchSpawn({ stall: true });
    patchStatus(() => ({ *childPidSteps() { yield* []; Bun.sleepSync(400); throw new Error("Odysseus lost the status line"); } }));
    const result = await runMaintenanceWorker({ ...command(f, sh("printf ran")), timeoutMs: 200 }).catch(error => error);
    expect(result, `F26_DEADLINE_DURING_SUPERVISOR_WAIT: ${result?.name}`).toMatchObject({ killed: true, exitCode: 137, stdout: "" });
  }, watchdogMs(60_000));

  test("F27: an abort reason that reads like an unconfirmed cleanup is returned as given and never skips the cleanup", async () => {
    const f = fixture();
    // One worker's allowance is the whole budget: a reservation left behind refuses the next launch.
    const one = { ...command(f, sh("printf ran")), tempLimits: { allowanceBytes: 4 * 1024 * 1024, budgetBytes: 4 * 1024 * 1024 }, timeoutMs: 60_000 };
    await runMaintenanceWorker({ ...one, command: sh("exit 0") });
    const baseline = openFds();
    watchSpawn({ stall: true });
    const reason = Object.assign(new Error("Penelope recalls the ship"), { cleanupUnconfirmed: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(reason), 300);
    const rejected = await runMaintenanceWorker({ ...one, signal: controller.signal }).then(() => "resolved", error => error);
    expect(rejected, "F27_REASON_AS_GIVEN").toBe(reason);
    restoreSpies();
    expect(await descriptorsBackTo(baseline), "F27_DESCRIPTORS_RELEASED").toBe(baseline);
    const next = await runMaintenanceWorker(one);
    expect(next, `F27_RESERVATION_RELEASED: ${next.stderr}`).toMatchObject({ exitCode: 0, stdout: "ran" });
  }, watchdogMs(60_000));

  test("F28: a stopped launch is frozen and its children enumerated before any kill, on a deadline and on an abort", async () => {
    const f = fixture();
    const timedOut = watchSpawn({ stall: true });
    await runMaintenanceWorker({ ...command(f, sh("printf ran")), timeoutMs: 300 });
    expect(timedOut[0], `F28_DEADLINE_FROZEN_BEFORE_KILLED: ${timedOut}`).not.toBe("SIGKILL");
    restoreSpies();
    const aborted = watchSpawn({ stall: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort("Penelope recalls the ship"), 300);
    await runMaintenanceWorker({ ...command(f, sh("printf ran")), signal: controller.signal, timeoutMs: 60_000 }).catch(() => undefined);
    expect(aborted[0], `F28_ABORT_FROZEN_BEFORE_KILLED: ${aborted}`).not.toBe("SIGKILL");
  }, watchdogMs(60_000));

  test("F31: a gate write that fails while bubblewrap lives throws WorkerHostError", async () => {
    const f = fixture();
    patchStatus(real => ({ release() { real.closeWriter(); throw new Error("Odysseus's gate write failed"); } }));
    const rejected = await runMaintenanceWorker({ ...command(f, sh("printf ran")), timeoutMs: 20_000 }).catch(error => error);
    expect(rejected instanceof WorkerHostError, `F31_GATE_WRITE_FAILURE_IS_WORKER_HOST_ERROR: ${rejected?.name}`).toBe(true);
  }, watchdogMs(30_000));

  test("F32: a timeout Bun's timer clamps to 1 ms stops the launch as main's timer did", async () => {
    const f = fixture();
    const started = performance.now();
    const result = await runMaintenanceWorker({ ...command(f, sh("sleep 20")), timeoutMs: 2 ** 31 });
    expect(result.killed, "F32_CLAMPED_TIMEOUT_KILLS").toBe(true);
    expect(performance.now() - started).toBeLessThan(10_000);
  }, watchdogMs(30_000));

  test("F33: a wall-clock jump during setup neither kills the launch nor shortens its timeout", async () => {
    const f = fixture();
    const now = Date.now.bind(Date);
    let offset = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => now() + offset);
    cleanups.push(() => clock.mockRestore());
    watchSpawn({ after: () => { offset = 10 * 24 * 60 * 60 * 1000; } });
    const result = await runMaintenanceWorker({ ...command(f, sh("printf ran")), timeoutMs: 60_000 });
    expect(result, `F33_MONOTONIC_DEADLINE: ${result.stderr}`).toMatchObject({ exitCode: 0, killed: false, stdout: "ran" });
  }, watchdogMs(30_000));
});

describe("L2 gate (#5016 review r3)", () => {
  test("F62: a gate that reaches EOF without `go` (a server that died before release) exits 125 and never runs the payload", async () => {
    const f = fixture();
    // The server's release never writes: the gate's writer closes as at its
    // death. A reader of the status pipe stays open, as bubblewrap's own
    // channel to the host would, so only the gate sees EOF.
    const held: number[] = [];
    cleanups.push(() => { for (const fd of held) closeSync(fd); });
    patchStatus(real => ({
      *childPidSteps(...args: Parameters<typeof real.childPidSteps>) {
        held.push(openSync(real.source, constants.O_RDONLY | constants.O_NONBLOCK));
        return yield* real.childPidSteps(...args);
      },
      release() { void real.close(); },
    }));
    const result = await runMaintenanceWorker({ ...command(f, sh("printf ran")), timeoutMs: 20_000 });
    expect(result, `F62_SERVER_DEATH_FAILS_CLOSED: ${result.stderr}`).toMatchObject({ exitCode: 125, stdout: "" });
    restoreSpies();
    // The next launch is unaffected.
    expect(await runMaintenanceWorker({ ...command(f, sh("printf ran")), timeoutMs: 20_000 }), "F62_NEXT_LAUNCH_RUNS").toMatchObject({ exitCode: 0, stdout: "ran" });
  }, watchdogMs(30_000));

  test("F55, F56: a variable name without a NAME=VALUE form, or a command whose first word holds '=', is refused before spawn", async () => {
    const f = fixture();
    const credentialed = { credentials: true, network: false, timeoutMs: 20_000 };
    const badName = await runMaintenanceWorker({ ...command(f, sh("printf ran")), env: { PATH: "/usr/bin:/bin", "CREW=SHIP": "ithaca" }, ...credentialed }).catch(error => error);
    expect(badName instanceof WorkerHostError, `F56_NAME_WITH_EQUALS_REFUSED: ${badName?.name}`).toBe(true);
    const saved = process.env.BRAIN_UI_WORKER_LIMITS;
    process.env.BRAIN_UI_WORKER_LIMITS = "processes=off,data=off,file_size=off,open_files=off";
    cleanups.push(() => { if (saved === undefined) delete process.env.BRAIN_UI_WORKER_LIMITS; else process.env.BRAIN_UI_WORKER_LIMITS = saved; });
    const badCommand = await runMaintenanceWorker({ ...command(f, ["/srv/ithaca/oar=ship"]), timeoutMs: 20_000 }).catch(error => error);
    expect(badCommand instanceof WorkerHostError, `F55_COMMAND_WITH_EQUALS_REFUSED: ${badCommand?.name}`).toBe(true);
  }, watchdogMs(30_000));
});

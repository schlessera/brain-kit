/**
 * #4301 commit C2: the direct-spawn maintenance launches (L2
 * `launchMaintenanceWorker`/`runMaintenanceWorker`, L3
 * stays on main's spawnSync and walks (#4301 path O5)) waits at START_GATE before its
 * payload starts. These pin what must not change (G1-G13 of the design).
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchMaintenanceWorker, runMaintenanceWorker } from "../src/server/maintenance-worker";
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

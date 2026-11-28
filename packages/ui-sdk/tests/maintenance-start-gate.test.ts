/**
 * #4301 commit C2: the direct-spawn maintenance launches (L2
 * `launchMaintenanceWorker`/`runMaintenanceWorker`, L3
 * `runMaintenanceWorkerSync` and its steps) wait at START_GATE before their
 * payload starts. These pin what must not change (G1-G13 of the design).
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchMaintenanceWorker, runMaintenanceWorker, runMaintenanceWorkerSteps, runMaintenanceWorkerSync } from "../src/server/maintenance-worker";
import { probeWorkerHost } from "../src/server/worker-launcher";
import { createOutputStagingStorage } from "./helpers/worker-copy-output";
import { runWorkerStepsAsync } from "../src/server/worker-steps";
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

describe("L3 runMaintenanceWorkerSync and its steps", () => {
  test("G5: the timeout yields exitCode 1, killed, counted from the spawn, in both forms", async () => {
    const f = fixture();
    let started = performance.now();
    const sync = runMaintenanceWorkerSync({ ...command(f, sh("sleep 30")), timeoutMs: 1_000 });
    expect(sync, "G5_SYNC_TIMEOUT").toEqual({ stdout: "", stderr: "", exitCode: 1, killed: true });
    expect(performance.now() - started).toBeLessThan(15_000);
    started = performance.now();
    const stepped = await runWorkerStepsAsync(runMaintenanceWorkerSteps({ ...command(f, sh("sleep 30")), timeoutMs: 1_000 }));
    expect(stepped, "G5_STEPPED_TIMEOUT").toEqual({ stdout: "", stderr: "", exitCode: 1, killed: true });
    expect(performance.now() - started).toBeLessThan(15_000);
  }, watchdogMs(60_000));

  test("G5b: a zero timeout disables the deadline, as spawnSync's did, in both forms", async () => {
    const f = fixture();
    const options = { ...command(f, sh("sleep 0.3; printf landed")), timeoutMs: 0 };
    expect(runMaintenanceWorkerSync(options), "G5B_SYNC_ZERO_TIMEOUT_RUNS").toMatchObject({ exitCode: 0, killed: false, stdout: "landed" });
    expect(await runWorkerStepsAsync(runMaintenanceWorkerSteps(options)), "G5B_STEPPED_ZERO_TIMEOUT_RUNS").toMatchObject({ exitCode: 0, killed: false, stdout: "landed" });
  }, watchdogMs(30_000));

  test("G5c: a deadline shorter than the sandbox's setup passes before release: killed, the payload never runs, in every form", async () => {
    const f = fixture();
    const options = { ...command(f, sh("printf ran")), timeoutMs: 1 };
    const asynchronous = await runMaintenanceWorker(options);
    expect(asynchronous, "G5C_ASYNC_DEADLINE_COUNTS_FROM_SPAWN").toMatchObject({ killed: true, stdout: "" });
    expect(runMaintenanceWorkerSync(options), "G5C_SYNC_DEADLINE_COUNTS_FROM_SPAWN").toMatchObject({ exitCode: 1, killed: true, stdout: "" });
    // The direct launch itself stops it unreleased: its gate says so, and its exit follows.
    const worker = launchMaintenanceWorker({ ...options } as Parameters<typeof launchMaintenanceWorker>[0]);
    expect(worker.gate?.timedOut, "G5C_GATE_STOPPED_UNRELEASED").toBe(true);
    await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.input(""), worker.exited]);
    await worker.released();
  }, watchdogMs(30_000));

  test("G12: the synchronous form blocks for the child's lifetime; the stepped form yields", async () => {
    const f = fixture();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      runMaintenanceWorkerSync({ ...command(f, sh("sleep 0.5")), timeoutMs: 10_000 });
      const blocked = ticks;
      await runWorkerStepsAsync(runMaintenanceWorkerSteps({ ...command(f, sh("sleep 0.5")), timeoutMs: 10_000 }));
      expect(blocked, "G12_SYNC_BLOCKS").toBe(0);
      expect(ticks, "G12_STEPPED_YIELDS").toBeGreaterThan(10);
    } finally { clearInterval(timer); }
  }, watchdogMs(30_000));
});

describe("both paths", () => {
  test("G6: exit codes 0, 7, 125, 126, 127 and a signal death report exactly as before", async () => {
    const f = fixture();
    const cases: [string[], number][] = [[sh("exit 0"), 0], [sh("exit 7"), 7], [sh("exit 125"), 125], [sh("exit 126"), 126], [sh("exit 127"), 127], [sh("kill -9 $$"), 137]];
    for (const [argv, code] of cases) {
      const options = { ...command(f, argv), timeoutMs: 20_000 };
      expect((await runMaintenanceWorker(options)).exitCode, `G6_L2_${code}`).toBe(code);
      expect(runMaintenanceWorkerSync(options).exitCode, `G6_L3_SYNC_${code}`).toBe(code);
      expect((await runWorkerStepsAsync(runMaintenanceWorkerSteps(options))).exitCode, `G6_L3_STEPPED_${code}`).toBe(code);
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
      expect(runMaintenanceWorkerSync(base).exitCode, "G8_SYNC_SUCCESS_RELEASES").toBe(0);
    }
    expect(existsSync(f.startupView.root), "G8_CALLER_VIEW_KEPT").toBe(true);
  }, watchdogMs(120_000));

  test("G8b: a sandbox setup failure reports bubblewrap's own exit code and stderr, never a throw, 20 times in both forms", async () => {
    const f = fixture();
    // The writable file exists when the argv is built and is gone when bubblewrap
    // binds it: bubblewrap itself fails its setup and starts no payload.
    const log = join(f.root, "voyage.log");
    const failing = { ...command(f, sh("exit 0")), writeFiles: [log], timeoutMs: 20_000 };
    const spawn = Bun.spawn, spawnSync = Bun.spawnSync;
    const removeFirst = (args: unknown[]) => { if ((args[1] as { env?: Record<string, string> } | undefined)?.env?.BRAIN_WORKER_LAUNCH) rmSync(log, { force: true }); };
    const spies = [spyOn(Bun, "spawn").mockImplementation(((...args: unknown[]) => { removeFirst(args); return (spawn as (...a: unknown[]) => unknown)(...args); }) as typeof Bun.spawn),
      spyOn(Bun, "spawnSync").mockImplementation(((...args: unknown[]) => { removeFirst(args); return (spawnSync as (...a: unknown[]) => unknown)(...args); }) as typeof Bun.spawnSync)];
    cleanups.push(() => { for (const spy of spies) spy.mockRestore(); });
    for (let i = 0; i < 20; i++) {
      writeFileSync(log, "");
      const asynchronous = await runMaintenanceWorker(failing);
      expect(asynchronous.exitCode, "G8B_ASYNC_SETUP_FAILURE_EXIT").not.toBe(0);
      expect(asynchronous.stderr, "G8B_ASYNC_SETUP_FAILURE_STDERR").toContain("bwrap");
      writeFileSync(log, "");
      const synchronous = runMaintenanceWorkerSync(failing);
      expect(synchronous.exitCode, "G8B_SYNC_SETUP_FAILURE_EXIT").not.toBe(0);
      expect(synchronous.stderr, "G8B_SYNC_SETUP_FAILURE_STDERR").toContain("bwrap");
    }
  }, watchdogMs(240_000));

  test("G9b: 200 consecutive synchronous launches with no await leave no descriptor behind", async () => {
    const f = fixture();
    const options = { ...command(f, sh("exit 0")), timeoutMs: 20_000 };
    runMaintenanceWorkerSync(options);
    await Bun.sleep(50);
    // Bun holds one pidfd per spawned child until its event loop next runs; nothing synchronous can release it.
    const kinds = () => readdirSync("/proc/self/fd").map(fd => { try { return readlinkSync(`/proc/self/fd/${fd}`); } catch { return "gone"; } });
    const others = () => kinds().filter(target => target !== "anon_inode:[pidfd]").length;
    const before = { all: kinds().length, others: others() };
    for (let i = 0; i < 200; i++) expect(runMaintenanceWorkerSync(options).exitCode).toBe(0);
    expect(others(), "G9B_NO_DESCRIPTOR_LEFT_IN_ONE_SYNCHRONOUS_STRETCH").toBeLessThanOrEqual(before.others);
    await Bun.sleep(100);
    expect(kinds().length, "G9B_NO_DESCRIPTOR_LEFT_AFTER_ONE_TICK").toBeLessThanOrEqual(before.all);
  }, watchdogMs(240_000));

  test("G9: no descriptor leaks after 200 launches", async () => {
    const f = fixture();
    const options = { ...command(f, sh("exit 0")), timeoutMs: 20_000 };
    await runMaintenanceWorker(options); runMaintenanceWorkerSync(options);
    await Bun.sleep(50);
    const before = openFds();
    for (let i = 0; i < 100; i++) { await runMaintenanceWorker(options); runMaintenanceWorkerSync(options); }
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

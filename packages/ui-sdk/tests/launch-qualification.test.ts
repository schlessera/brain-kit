/**
 * #4301 commit C3: every launch with a caller-supplied command is qualified
 * against host private state while its start gate is closed. Real sandboxes:
 * a state root made reachable (bound back by the launch's own read paths, or
 * under a restored credentialed HOME) refuses that launch before its payload
 * runs, and the next launch without it starts. An unreadable layout runs the
 * provider's walk at the launch.
 */
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { text as streamText } from "node:stream/consumers";
import { runMaintenanceWorker, runMaintenanceWorkerSync } from "../src/server/maintenance-worker";
import { launchAgentWorker, launchAgentWorkerAsync, prepareWorkerSandbox, probeWorkerHost, workerBootstrap } from "../src/server/worker-launcher";
import { parseMountinfo, resolveMount, WORKER_NAMESPACE_SEAL } from "../src/server/namespace-qualification";
import { kernelRealpath, onUnqualifiedLaunch, privateStateRefusalOf, qualifyWorkerNamespaceSteps, WorkerQualificationInterrupted, registerWorkerPrivateState, unqualifiedLaunches, type UnqualifiedLaunch, workerPrivateStateProviders, WorkerPrivateStateError, type WorkerPrivateStateEvent, type WorkerPrivateStateProvider } from "../src/server/worker-private-state";
import * as workerStatus from "../src/server/worker-status";
import { assertScratchMaskAsync } from "../src/server/bridge-tools/mask";
import { runWorkerStepsSync } from "../src/server/worker-steps";
import { createFixtureWorkerStartupView } from "./helpers/worker-startup-view-fixture";
import { watchdogMs } from "../../../scripts/test-deadlines.js";

const ROOT = resolve(import.meta.dir, "../../..");
const BUN = realpathSync(process.execPath);
const cleanups: (() => void | Promise<void>)[] = [];
beforeAll(() => {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const probe = mkdtempSync(join(ROOT, "tmp/launch-qualification-probe-"));
  try { const result = probeWorkerHost(probe); if (!result.ok) throw new Error(result.requirement); }
  finally { rmSync(probe, { recursive: true, force: true }); }
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A brain, a state root beside it, a home, and a socket the payload calls to prove it ran. */
async function fixture(options: { stateUnder?: "root" | "home" | "tmp" } = {}) {
  const root = mkdtempSync(join(ROOT, "tmp/launch-qualification-")); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const brain = join(root, "brain"), home = join(root, "home"), markers = join(root, "markers");
  for (const dir of [brain, home, markers]) mkdirSync(dir);
  writeFileSync(join(brain, "ithaca.md"), "Odysseus sails for Ithaca.\n");
  const stateBase = options.stateUnder === "home" ? join(home, ".local/state") : options.stateUnder === "tmp" ? mkdtempSync(join(tmpdir(), "odysseus-state-")) : join(root, "state");
  if (options.stateUnder === "tmp") cleanups.push(() => rmSync(stateBase, { recursive: true, force: true }));
  const state = join(stateBase, "brain-ui.db.journal");
  mkdirSync(state, { recursive: true }); writeFileSync(join(state, "penelope.db"), "suitors");
  const socket = join(markers, "ran.sock");
  let ran = 0;
  const server: Server = createServer(connection => { ran++; connection.end(); });
  await new Promise<void>(done => server.listen(socket, done));
  cleanups.push(() => new Promise<void>(done => server.close(() => done())));
  const startupView = createFixtureWorkerStartupView(brain); cleanups.push(startupView.cleanup);
  const events: WorkerPrivateStateEvent[] = [];
  let walk: ReturnType<WorkerPrivateStateProvider["walk"]>, onWalk: (() => void) | undefined;
  let roots = [{ setting: "turn journal", path: state }];
  const dispose = registerWorkerPrivateState(brain, { roots: () => roots, walk: () => { onWalk?.(); return walk; }, report: event => events.push(event) });
  cleanups.push(dispose);
  // Exits once connected: a synchronous launch blocks this thread, so the server accepts only afterwards.
  const payload = [BUN, "-e", `require("node:net").connect(${JSON.stringify(socket)}).on("connect", () => process.exit(0)).on("error", () => process.exit(9))`];
  const settle = () => new Promise(done => setTimeout(done, 100));
  const view = () => { const fresh = createFixtureWorkerStartupView(brain); cleanups.push(fresh.cleanup); return fresh; };
  return { root, brain, home, state, markers, startupView, events, payload, settle, view, ran: () => ran,
    setWalk: (value: typeof walk) => { walk = value; }, setRoots: (value: typeof roots) => { roots = value; },
    duringWalk: (hook: typeof onWalk) => { onWalk = hook; },
    /** A layout the host cannot read: every launch walks at its closed gate. */
    unknownLayout: () => { const file = join(root, "not-a-directory"); writeFileSync(file, "x"); roots = [{ setting: "turn journal", path: join(file, "journal") }]; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const maintenance = (f: Fixture, readPaths: string[], extra: Record<string, unknown> = {}) => ({ brainPath: f.brain, startupView: f.startupView,
  command: f.payload, env: { PATH: "/usr/bin:/bin" }, credentials: false, readPaths, timeoutMs: 20_000, ...extra });
const isExposure = (error: unknown) => error instanceof WorkerPrivateStateError && error.reason === "private_state_exposed";

describe("every launch function refuses an exposure before its payload and releases a clean launch (A2, A6, A7)", () => {
  test("L2: credential-free maintenance, state bound back by the launch's own read paths", async () => {
    const f = await fixture();
    const refused = await runMaintenanceWorker(maintenance(f, [f.markers, f.state])).catch(error => error);
    expect(isExposure(refused), `L2_EXPOSURE_REFUSED: ${refused}`).toBe(true);
    expect((refused as WorkerPrivateStateError).exposure?.name).toBe(realpathSync(f.state));
    expect(f.ran(), "L2_PAYLOAD_NEVER_RAN").toBe(0);
    const clean = await runMaintenanceWorker(maintenance(f, [f.markers]));
    expect(clean.exitCode, clean.stderr).toBe(0);
    expect(f.ran(), "L2_CLEAN_LAUNCH_RUNS_NO_RESTART").toBe(1);
  }, watchdogMs(60_000));


  test("L2: a state directory under a restored credentialed HOME refuses the credentialed launch", async () => {
    const f = await fixture({ stateUnder: "home" });
    const refused = await runMaintenanceWorker(maintenance(f, [f.markers], { credentials: true, network: false, home: f.home })).catch(error => error);
    expect(isExposure(refused), `L2_CREDENTIALED_HOME_REFUSED: ${refused}`).toBe(true);
    expect(f.ran()).toBe(0);
    // The same layout in a credential-free launch never shows the home.
    expect((await runMaintenanceWorker(maintenance(f, [f.markers]))).exitCode, "L2_CREDENTIAL_FREE_HOME_HIDDEN").toBe(0);
  }, watchdogMs(60_000));

  test("L2: a state root under the server's /tmp is hidden by the worker's private /tmp", async () => {
    const f = await fixture({ stateUnder: "tmp" });
    expect((await runMaintenanceWorker(maintenance(f, [f.markers]))).exitCode, "PRIVATE_TMP_HIDES_STATE").toBe(0);
    expect(f.ran()).toBe(1);
  }, watchdogMs(60_000));

  for (const profile of ["strict", "governed"] as const) test(`L1: ${profile} agent worker, synchronous and asynchronous`, async () => {
    const f = await fixture();
    // Each launch consumes its own execution reference of a strict startup view.
    const launch = (readPaths: string[]) => {
      const view = profile === "strict" ? { startupView: f.view() } : {};
      return { brainPath: f.brain, ...view, sandbox: prepareWorkerSandbox(f.brain, { profile, ...view, areas: [], readPaths: [BUN, ...readPaths] }), env: {}, command: f.payload };
    };
    let refused: unknown;
    try { launchAgentWorker(launch([f.markers, f.state])); } catch (error) { refused = error; }
    expect(isExposure(refused), `L1_${profile}_SYNC_REFUSED: ${refused}`).toBe(true);
    expect(isExposure(await launchAgentWorkerAsync(launch([f.markers, f.state])).catch(error => error)), `L1_${profile}_ASYNC_REFUSED`).toBe(true);
    expect(f.ran(), `L1_${profile}_PAYLOAD_NEVER_RAN`).toBe(0);
    const worker = await launchAgentWorkerAsync(launch([f.markers]));
    const [stderr, code] = await Promise.all([streamText(worker.stderr), worker.exited, streamText(worker.stdout)]);
    expect(code, stderr).toBe(0);
    expect(f.ran(), `L1_${profile}_CLEAN_LAUNCH_RUNS`).toBe(1);
  }, watchdogMs(60_000));

  test("L1: a no-profile worker sees the host unmasked, so a registered root there is refused", async () => {
    const f = await fixture();
    let refused: unknown;
    try { launchAgentWorker({ brainPath: f.brain, startupView: f.view(), env: {}, command: f.payload }); } catch (error) { refused = error; }
    expect(isExposure(refused), `L1_NO_PROFILE_REFUSED: ${refused}`).toBe(true);
    f.setRoots([{ setting: "turn journal", path: join(f.root, "not-created-yet") }]);
    const worker = launchAgentWorker({ brainPath: f.brain, startupView: f.view(), env: {}, command: f.payload });
    expect(await worker.exited, "ABSENT_ROOT_NOT_JUDGED").toBe(0);
  }, watchdogMs(60_000));
});

describe("synchronous maintenance is not qualified; it walks (#4301 path O5, #5026)", () => {
  test("an exposed synchronous maintenance launch runs, and is counted unqualified with its site and brain", async () => {
    const f = await fixture();
    const before = unqualifiedLaunches().count;
    const result = runMaintenanceWorkerSync(maintenance(f, [f.markers, f.state], { maskPaths: [join(f.root, "state")] }));
    expect(result.exitCode, `L3_EXPOSED_RUNS_UNQUALIFIED: ${result.stderr}`).toBe(0);
    await f.settle();
    expect(f.ran(), "L3_PAYLOAD_RAN").toBe(1);
    expect(unqualifiedLaunches(), "L3_COUNTED_UNQUALIFIED").toMatchObject({ count: before + 1, last: { site: "synchronous-maintenance", brain: realpathSync(f.brain) } });
  }, watchdogMs(60_000));

  test("F42: a synchronous launch runs the registered walk itself and refuses with its typed reason; the payload never runs", async () => {
    const f = await fixture();
    f.setWalk({ reason: "private_state_in_brain", detail: "the turn journal is inside the brain at .brain/ithaca" });
    let refused: unknown;
    try { runMaintenanceWorkerSync(maintenance(f, [f.markers])); } catch (error) { refused = error; }
    expect(privateStateRefusalOf(refused)?.reason, `F42_SYNC_WALK_REFUSES: ${refused}`).toBe("private_state_in_brain");
    await f.settle();
    expect(f.ran(), "F42_PAYLOAD_NEVER_RAN").toBe(0);
  }, watchdogMs(60_000));

  test("F50: every synchronous launch for a brain with a layout is counted, masked or not", async () => {
    const f = await fixture();
    const before = unqualifiedLaunches().count;
    expect(runMaintenanceWorkerSync(maintenance(f, [f.markers])).exitCode).toBe(0);
    expect(unqualifiedLaunches(), "F50_UNMASKED_SYNC_COUNTED").toMatchObject({ count: before + 1, last: { site: "synchronous-maintenance" } });
  }, watchdogMs(60_000));

  test("F51: synchronous maintenance carries no namespace seal; a qualified launch does", async () => {
    const f = await fixture();
    const table = ["/bin/sh", "-c", "cat /proc/self/mountinfo"];
    const sync = runMaintenanceWorkerSync({ ...maintenance(f, [f.markers]), command: table });
    expect(sync.exitCode, sync.stderr).toBe(0);
    expect(sync.stdout, "F51_SYNC_HAS_NO_SEAL").not.toContain(WORKER_NAMESPACE_SEAL);
    expect((await runMaintenanceWorker({ ...maintenance(f, [f.markers]), command: table })).stdout, "F51_QUALIFIED_HAS_THE_SEAL").toContain(WORKER_NAMESPACE_SEAL);
  }, watchdogMs(60_000));
});

describe("ownership rule on a shared-UID host (A17)", () => {
  test("owner-only state is still refused when the sandbox runs as its owner", async () => {
    const f = await fixture();
    chmodSync(f.state, 0o700);
    expect(isExposure(await runMaintenanceWorker(maintenance(f, [f.markers, f.state])).catch(error => error)), "SHARED_UID_OWNER_ONLY_REFUSED").toBe(true);
  }, watchdogMs(60_000));
});

describe("an unknown layout runs the walk at the launch (A12)", () => {
  test("a pass releases, recorded as namespace_unverified; a refusal throws with the walk's own reason", async () => {
    const f = await fixture();
    const file = join(f.root, "not-a-directory"); writeFileSync(file, "x");
    // realpath through a regular file fails with ENOTDIR: not an absent root, an unreadable layout.
    f.setRoots([{ setting: "turn journal", path: join(file, "journal") }]);
    expect((await runMaintenanceWorker(maintenance(f, [f.markers]))).exitCode, "UNKNOWN_WALK_PASS_RELEASES").toBe(0);
    expect(f.events.map(event => event.kind), "UNKNOWN_RECORDED").toContain("namespace_unverified");
    f.setWalk({ reason: "private_state_in_brain", detail: "OperationalStateInBrainError: turn journal has an inode alias inside the brain" });
    const refused = await runMaintenanceWorker(maintenance(f, [f.markers])).catch(error => error);
    expect(refused instanceof WorkerPrivateStateError && refused.reason, "UNKNOWN_WALK_REFUSAL_REASON").toBe("private_state_in_brain");
    let sync: unknown;
    try { launchAgentWorker({ brainPath: f.brain, startupView: f.view(), env: {}, command: f.payload }); } catch (error) { sync = error; }
    expect(sync instanceof WorkerPrivateStateError && sync.reason, "UNKNOWN_WALK_REFUSAL_L1").toBe("private_state_in_brain");
    await f.settle();
    expect(f.ran()).toBe(1);
  }, watchdogMs(60_000));

  test("private paths declared for a brain with no registered layout run unqualified: a backend's own credential masks", async () => {
    const f = await fixture();
    const other = join(f.root, "other-brain"); mkdirSync(other);
    const view = createFixtureWorkerStartupView(other); cleanups.push(view.cleanup);
    const seen: UnqualifiedLaunch[] = [], before = unqualifiedLaunches().count;
    cleanups.push(onUnqualifiedLaunch(launch => seen.push(launch)));
    const result = await runMaintenanceWorker({ ...maintenance(f, [f.markers]), brainPath: other, startupView: view, maskPaths: [join(f.root, "state")] });
    expect(result.exitCode, `UNREGISTERED_BRAIN_RUNS_UNQUALIFIED: ${result.stderr}`).toBe(0);
    expect(f.ran()).toBe(1);
    // Never silently (maintainer ruling on Q1): the skip is recorded with its launch site and brain.
    expect(seen, "UNQUALIFIED_SKIP_RECORDED").toEqual([{ at: expect.any(Number), site: "maintenance", brain: realpathSync(other) }]);
    expect(unqualifiedLaunches(), "UNQUALIFIED_SKIP_COUNTED").toMatchObject({ count: before + 1, last: { site: "maintenance", brain: realpathSync(other) } });
    // An unmasked launch for an unregistered brain (a library's own) is not a skip of declared private state.
    const view2 = createFixtureWorkerStartupView(other); cleanups.push(view2.cleanup);
    const unmasked = await runMaintenanceWorker({ ...maintenance(f, [f.markers]), brainPath: other, startupView: view2 });
    expect(unmasked.exitCode).toBe(0);
    expect(unqualifiedLaunches().count, "UNMASKED_LAUNCH_NOT_RECORDED").toBe(before + 1);
  }, watchdogMs(60_000));
});

describe("the fixed probes are not qualified (A14)", () => {
  test("with a registered root live in the no-profile envelope, the worker-host probe passes", async () => {
    const f = await fixture();
    expect(probeWorkerHost(f.brain), "PROBE_NOT_QUALIFIED").toMatchObject({ ok: true });
  }, watchdogMs(60_000));
});

describe("qualification never judges an incomplete table (A25)", () => {
  const line = (id: number, parent: number, sb: string, root: string, point: string, fstype = "ext4", options = "rw") =>
    `${id} ${parent} ${sb} ${root} ${point} ${options} - ${fstype} odysseus rw`;
  const reads = [
    "",
    [line(1, 0, "0:70", "/", "/"), line(2, 1, "0:80", "/", "/tmp", "tmpfs")].join("\n"),
    [line(1, 0, "0:70", "/", "/"), line(9, 1, "0:71", "/newroot", "/"), line(2, 9, "0:80", "/", "/tmp", "tmpfs"), line(3, 2, "0:90", "/", WORKER_NAMESPACE_SEAL, "tmpfs", "ro")].join("\n"),
    [line(9, 0, "0:71", "/newroot", "/"), line(2, 9, "0:80", "/", "/tmp", "tmpfs"), line(3, 2, "0:90", "/", WORKER_NAMESPACE_SEAL, "tmpfs", "ro")].join("\n"),
  ];
  function injected(sequence: string[]) {
    let served = 0;
    const real = fs.readFileSync;
    const spy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (path === "/proc/424242/mountinfo") return sequence[Math.min(served++, sequence.length - 1)];
      if (path === "/proc/424242/status") return "Uid:\t1000\t1000\t1000\t1000\n";
      return (real as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof fs.readFileSync);
    cleanups.push(() => spy.mockRestore());
    return () => served;
  }
  test("reads in order: empty, seal absent, seal with the old root stacked at /, complete: judged only on the last", async () => {
    const f = await fixture();
    const served = injected(reads);
    expect(runWorkerStepsSync(qualifyWorkerNamespaceSteps(424242, f.brain, Date.now() + 5_000, { site: "maintenance", masked: true })), "RELEASED_ON_COMPLETE").toEqual({ result: "hidden" });
    expect(served(), "JUDGED_ONLY_THE_FOURTH_READ").toBe(4);
  }, watchdogMs(30_000));
  test("a stacked root repeated to the deadline is unknown: the walk decides", async () => {
    const f = await fixture();
    injected(reads.slice(0, 3));
    expect(runWorkerStepsSync(qualifyWorkerNamespaceSteps(424242, f.brain, Date.now() + 200, { site: "maintenance", masked: true })), "STACKED_TO_DEADLINE_UNKNOWN").toEqual({ result: "namespace_unverified" });
    expect(f.events.at(-1)).toMatchObject({ kind: "namespace_unverified", cause: "the sandbox's mount table was not complete in time" });
  }, watchdogMs(30_000));
  test("F45: state roots are observed against the final table, never before it", async () => {
    const f = await fixture();
    const served = injected(reads);
    let observedAt = -1;
    cleanups.push(registerWorkerPrivateState(f.brain, { roots: () => { observedAt = served(); return []; }, walk: () => undefined }));
    runWorkerStepsSync(qualifyWorkerNamespaceSteps(424242, f.brain, Date.now() + 5_000, { site: "maintenance", masked: true }));
    expect(observedAt, "F45_ROOTS_OBSERVED_AFTER_THE_FINAL_TABLE").toBe(4);
  }, watchdogMs(30_000));
  test("F46: the caller's abort or deadline ends the mount-table wait at once and skips the walk", async () => {
    const f = await fixture();
    injected(reads.slice(0, 3));
    let walked = false;
    f.duringWalk(() => { walked = true; });
    const started = performance.now(), until = started + 100;
    const interrupted = () => performance.now() >= until;
    expect(() => runWorkerStepsSync(qualifyWorkerNamespaceSteps(424242, f.brain, Date.now() + 5_000, { site: "maintenance", masked: true, interrupted })), "F46_WAIT_INTERRUPTED")
      .toThrow(WorkerQualificationInterrupted);
    expect(performance.now() - started, "F46_INTERRUPTION_IS_PROMPT").toBeLessThan(2_000);
    expect(walked, "F46_NO_WALK_AFTER_INTERRUPTION").toBe(false);
  }, watchdogMs(30_000));
  test("F46: an L2 launch whose mount table never completes keeps its caller's timeout and abort results, promptly", async () => {
    const f = await fixture();
    const real = fs.readFileSync;
    // Every sandbox's table stays incomplete: the wait would run to the setup bound.
    const spy = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor, ...rest: unknown[]) =>
      typeof path === "string" && /^\/proc\/\d+\/mountinfo$/.test(path) && path !== `/proc/${process.pid}/mountinfo` ? reads[2]
        : (real as (...args: unknown[]) => unknown)(path, ...rest)) as typeof fs.readFileSync);
    cleanups.push(() => spy.mockRestore());
    let started = performance.now();
    const timed = await runMaintenanceWorker({ ...maintenance(f, [f.markers]), timeoutMs: 300 });
    expect(timed, "F46_TIMEOUT_RESULT_KEPT").toMatchObject({ killed: true, exitCode: 137 });
    expect(performance.now() - started, "F46_TIMEOUT_IS_PROMPT").toBeLessThan(3_000);
    const controller = new AbortController();
    started = performance.now();
    setTimeout(() => controller.abort("Penelope recalls the ship"), 300);
    const aborted = await runMaintenanceWorker({ ...maintenance(f, [f.markers]), signal: controller.signal, timeoutMs: 60_000 }).then(() => "resolved", error => ({ error }));
    expect(aborted, "F46_ABORT_REASON_KEPT").toEqual({ error: "Penelope recalls the ship" });
    expect(performance.now() - started, "F46_ABORT_IS_PROMPT").toBeLessThan(3_000);
    expect(f.ran(), "F46_PAYLOAD_NEVER_RAN").toBe(0);
  }, watchdogMs(60_000));
});

describe("resolveMount equals the kernel in a real sandbox (A8)", () => {
  test("every probed name resolves to the mount the kernel opens it in", async () => {
    const f = await fixture();
    const names = ["/", "/tmp", WORKER_NAMESPACE_SEAL, f.state, f.brain, f.markers, join(f.root, "state"), "/proc", "/usr/bin", realpathSync(BUN)];
    const program = `const fs=require("node:fs");const out={table:fs.readFileSync("/proc/self/mountinfo","utf8"),ids:{}};
      for (const name of ${JSON.stringify(names)}) { try { const fd=fs.openSync(name, 0o10000000|fs.constants.O_NOFOLLOW); out.ids[name]=Number(/^mnt_id:\\s*(\\d+)$/m.exec(fs.readFileSync("/proc/self/fdinfo/"+fd,"utf8"))[1]); } catch (e) { out.ids[name]=e.code; } }
      console.log(JSON.stringify(out));`;
    const result = await runMaintenanceWorker({ ...maintenance(f, [f.markers]), command: [BUN, "-e", program] });
    expect(result.exitCode, result.stderr).toBe(0);
    const { table, ids } = JSON.parse(result.stdout) as { table: string; ids: Record<string, number | string> };
    const rows = parseMountinfo(table)!;
    for (const name of names) {
      if (typeof ids[name] !== "number") continue;
      const reached = resolveMount(rows, name);
      expect("row" in reached ? reached.row.id : reached.ambiguous, `RESOLVE_EQUALS_KERNEL ${name}`).toBe(ids[name]!);
    }
    expect(Object.values(ids).filter(id => typeof id === "number").length).toBeGreaterThanOrEqual(6);
  }, watchdogMs(60_000));
});

/** Count start-gate releases of every launch in this test. */
function countReleases() {
  let releases = 0;
  const create = workerStatus.createWorkerStatusPipeSteps;
  const spy = spyOn(workerStatus, "createWorkerStatusPipeSteps").mockImplementation(function* () {
    const channel = yield* create();
    const release = channel.release.bind(channel);
    channel.release = () => { releases++; release(); };
    return channel;
  } as typeof create);
  cleanups.push(() => spy.mockRestore());
  return () => releases;
}

describe("review round 1: the start gate never releases a launch its caller gave up on (C2, F5-F7)", () => {

  test("G3b (F6): an abort that arrives while the launch waits at its gate rejects and never releases the payload", async () => {
    const f = await fixture();
    const controller = new AbortController();
    f.unknownLayout(); f.duringWalk(() => controller.abort());
    const released = countReleases();
    await expect(runMaintenanceWorker({ ...maintenance(f, [f.markers]), signal: controller.signal }), "G3B_ABORT_WHILE_GATED_REJECTS").rejects.toThrow();
    expect(released(), "G3B_NEVER_RELEASED").toBe(0);
    await f.settle();
    expect(f.ran()).toBe(0);
  }, watchdogMs(60_000));

});

describe("review round 1: one registry and one refusal per process (F11-F13)", () => {
  test("F12: another loaded copy of the SDK sees the same providers and its refusals are recognised", async () => {
    const f = await fixture();
    const copyPath = "../src/server/worker-private-state.ts?another-copy";
    const copy = await import(copyPath) as typeof import("../src/server/worker-private-state");
    expect(copy.registerWorkerPrivateState === registerWorkerPrivateState, "SEPARATE_MODULE_INSTANCE").toBe(false);
    expect(copy.workerPrivateStateProviders(f.brain).length, "F12_SHARED_REGISTRY").toBe(1);
    const foreign = new copy.WorkerPrivateStateError("private_state_exposed", "turn journal is reachable at /opt/aeolus");
    expect(privateStateRefusalOf(Object.assign(new Error("wrapped"), { cause: foreign })), "F12_FOREIGN_REFUSAL_RECOGNISED").toBe(foreign as never);
  });
  test("F13: registrations of one layout are one entry", async () => {
    const f = await fixture();
    const layout = JSON.stringify(["/srv/ithaca/ui.db"]);
    const first = registerWorkerPrivateState(f.brain, { roots: () => [], walk: () => undefined }, layout);
    const second = registerWorkerPrivateState(f.brain, { roots: () => [], walk: () => undefined }, layout);
    expect(workerPrivateStateProviders(f.brain).length, "F13_ONE_ENTRY_PER_LAYOUT").toBe(2);
    first(); second();
    expect(workerPrivateStateProviders(f.brain).length).toBe(1);
  });
  test("F11: a scratch-ignore query refused for private state keeps its typed cause", async () => {
    const f = await fixture();
    fs.mkdirSync(join(f.brain, ".brain/scratch"), { recursive: true });
    const refusal = new WorkerPrivateStateError("private_state_exposed", "turn journal is reachable at /opt/aeolus");
    const rejected = await assertScratchMaskAsync(realpathSync(f.brain), ".brain/scratch/raft-mask.png", join(realpathSync(f.brain), ".brain/scratch/raft-mask.png"),
      { scratchIgnoreQuery: async () => { throw refusal; } }).catch(error => error);
    expect(rejected, "F11_SCRATCH_QUERY_KEEPS_REFUSAL").toBe(refusal);
  });
});

describe("review round 2 (#4301)", () => {
  test("F16: a root configured through a link then `..` resolves in kernel order and is judged", async () => {
    const f = await fixture();
    // link -> sub/deep, so link/.. is sub, not the root's parent: the state lives under sub.
    fs.mkdirSync(join(f.root, "sub/deep"), { recursive: true });
    const state = join(f.root, "sub/state/brain-ui.db.journal"); fs.mkdirSync(state, { recursive: true });
    fs.symlinkSync(join(f.root, "sub/deep"), join(f.root, "link"));
    // Built by hand: path.join would collapse `link/..` before the kernel follows the link.
    f.setRoots([{ setting: "turn journal", path: `${f.root}/link/../state/brain-ui.db.journal` }]);
    const refused = await runMaintenanceWorker(maintenance(f, [f.markers, state])).catch(error => error);
    expect(isExposure(refused), `F16_KERNEL_ORDER_ROOT_REFUSED: ${refused}`).toBe(true);
    expect(f.ran()).toBe(0);
  }, watchdogMs(60_000));

  test("F35: an agent launch named through a link then `..` finds the layout registered under the same name", async () => {
    const f = await fixture();
    // hop -> brain/x/y, so hop/../.. is the brain in kernel order; Bun's realpathSync collapses it lexically to the root's parent.
    fs.mkdirSync(join(f.brain, "x/y"), { recursive: true });
    fs.symlinkSync(join(f.brain, "x/y"), join(f.root, "hop"));
    const named = `${f.root}/hop/../..`;
    // No root of the fixture's own layout exists: this unmasked launch has nothing to refuse.
    f.setRoots([{ setting: "turn journal", path: join(f.root, "not-created-yet") }]);
    let consulted = 0;
    cleanups.push(registerWorkerPrivateState(named, { roots: () => { consulted++; return []; }, walk: () => undefined }));
    const worker = launchAgentWorker({ brainPath: named, startupView: f.view(), env: {}, command: ["/bin/sh", "-c", "exit 0"] });
    await worker.exited;
    expect(consulted, "F35_SAME_NAME_FINDS_THE_LAYOUT").toBeGreaterThan(0);
  }, watchdogMs(60_000));

  test("F43: the sandbox binds the brain the kernel resolves, the one qualification and the registry name", async () => {
    const f = await fixture();
    fs.mkdirSync(join(f.brain, "x/y"), { recursive: true });
    fs.symlinkSync(join(f.brain, "x/y"), join(f.root, "hop"));
    const named = `${f.root}/hop/../..`;
    expect(kernelRealpath(named)).toBe(realpathSync.native(f.brain));
    const { payload } = workerBootstrap({ brainPath: named, command: ["/bin/true"], env: {} });
    const chdir = payload.argv[payload.argv.indexOf("--chdir") + 1];
    expect(chdir, "F43_SANDBOX_BRAIN_IS_THE_KERNELS").toBe(kernelRealpath(named));
  }, watchdogMs(60_000));

  test("F25: with no host log listening, a skipped masked launch writes one stderr line per site and brain", async () => {
    const f = await fixture();
    const other = join(f.root, "other-brain"); mkdirSync(other);
    const lines: string[] = [], write = process.stderr.write.bind(process.stderr);
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (String(chunk).includes("worker_launch_unqualified")) { lines.push(String(chunk)); return true; }
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write);
    cleanups.push(() => spy.mockRestore());
    for (let i = 0; i < 2; i++) {
      const view = createFixtureWorkerStartupView(other); cleanups.push(view.cleanup);
      expect((await runMaintenanceWorker({ ...maintenance(f, [f.markers]), brainPath: other, startupView: view, maskPaths: [join(f.root, "state")] })).exitCode).toBe(0);
    }
    expect(lines.map(line => JSON.parse(line)), "F25_ONE_LINE_PER_SITE_AND_BRAIN").toEqual([expect.objectContaining({ kind: "worker_launch_unqualified", site: "maintenance", brain: realpathSync(other) })]);
  }, watchdogMs(60_000));
});

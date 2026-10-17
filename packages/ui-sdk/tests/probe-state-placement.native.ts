/** Actual probe/checkpoint/collector composition; fixture-only synchronization. */
import { expect } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workerHostBoundary } from "../src/server/worker-launcher.js";
import { createNativeBrainManagerClient } from "../src/server/native-brain-manager-client.js";
import { prepareNativeWorkerStartupView, type WorkerStartupView } from "../src/server/worker-startup-view.js";
import { probeWorkerHostRecorded } from "../../ui-server/src/agent/worker-host.js";
import { prepareMaintenanceOutput } from "../../ui-server/src/brain/maintenance-output.js";
import { prepareMaintenanceGit } from "../../ui-server/src/brain/maintenance-git.js";
const brain = "/brain-fixture/brain", state = "/identity-server-private";
const barrier = join(state, "probe-state-barrier"), ready = join(barrier, "ready"), release = join(barrier, "release");
const omission = process.argv.includes("--omit-probe-state-placement");
const limits = 1024 ** 2, context = { dbPath: join(state, "probe-state.sqlite") };
expect(process.getuid!(), "PROBE_STATE_ACTUAL_SERVER_UID").toBe(21001);
if (process.argv.includes("--held-probe")) {
  const descriptor = Object.getOwnPropertyDescriptor(Bun, "spawn")!, spawn = Bun.spawn;
  const probe = workerHostBoundary.probe;
  let held = false;
  Object.defineProperty(Bun, "spawn", { ...descriptor, value: (...args: any[]) => {
    const options = Array.isArray(args[0]) ? args[1] : args[0];
    if (options?.env?.BRAIN_WORKER_LAUNCH) {
      if (held) throw Error("PROBE_STATE_ONLY_ONE_PAYLOAD");
      held = true; writeFileSync(ready, "ready", { flag: "wx", mode: 0o600 });
      const deadline = Date.now() + 10000;
      while (!existsSync(release)) {
        if (Date.now() >= deadline) throw Error("PROBE_STATE_BARRIER_TIMED_OUT");
        Bun.sleepSync(1);
      }
    }
    return Reflect.apply(spawn, Bun, args);
  } });
  // The causal mutant drops this one forwarded option, retaining all guards.
  if (omission) workerHostBoundary.probe = (root, options) => probe(root, { ...options, identitySentinelDirectory: undefined });
  try {
    const actual = probeWorkerHostRecorded(brain, "ordinary", undefined, "check", limits, limits, context);
    expect(held, "PROBE_STATE_ACTUAL_PAYLOAD_BARRIER_REACHED").toBe(true);
    expect(actual, "PROBE_STATE_ACTUAL_PRIVATE_SENTINEL_QUALIFICATION").toMatchObject({ ok: true, identity: "separate_uid", workerUid: 21002 });
    console.log(JSON.stringify({ heldProbe: actual, omission }));
  } finally {
    workerHostBoundary.probe = probe; Object.defineProperty(Bun, "spawn", descriptor);
  }
} else {
  const qualified = probeWorkerHostRecorded(brain, "ordinary", undefined, "boot", limits, limits, context);
  expect(qualified, "PROBE_STATE_COORDINATOR_REAL_IDENTITY").toMatchObject({ ok: true, identity: "separate_uid", workerUid: 21002 });
  expect(existsSync(barrier), "PROBE_STATE_BARRIER_INITIALLY_ABSENT").toBe(false);
  mkdirSync(barrier, { mode: 0o700 });
  try {
  const child = Bun.spawn([process.execPath, "--preload", "/repo/scripts/test-network-child-preload.ts", import.meta.filename,
    "--held-probe", ...(omission ? ["--omit-probe-state-placement"] : [])],
    { env: process.env, stdout: "pipe", stderr: "pipe", timeout: 30000 });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  let view: WorkerStartupView | undefined, outputs: Awaited<ReturnType<typeof prepareMaintenanceOutput>> | undefined;
  let settled = false;
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null || Date.now() >= deadline) throw Error("PROBE_STATE_CHILD_DID_NOT_REACH_BARRIER");
      await Bun.sleep(1);
    }
    const live = readdirSync(omission ? brain : state).filter(name => name.startsWith(".worker-identity-sentinel-"));
    expect(live, "PROBE_STATE_REAL_SENTINEL_HELD").toHaveLength(1);
    const info = lstatSync(join(omission ? brain : state, live[0]!));
    expect(info.isDirectory()).toBe(true); expect(info.uid).toBe(21001); expect(info.mode & 0o7777).toBe(0o700);
    const manager = createNativeBrainManagerClient({ socketPath: "/native-runtime/server-ws-manager.sock" });
    view = await prepareNativeWorkerStartupView(brain, manager);
    const captured = readdirSync(view.root).filter(name => name.startsWith(".worker-identity-sentinel-"));
    console.log(JSON.stringify({ probeStateCheckpoint: { omission, capturedPrivateSentinels: captured.length,
      liveSentinel: { uid: info.uid, gid: info.gid, mode: info.mode & 0o7777 }, immutable: true } }));
    writeFileSync(release, "release", { flag: "wx", mode: 0o600 });
    const [code, output, errors] = await Promise.all([child.exited, stdout, stderr]); settled = true;
    expect(code, errors).toBe(0); expect(errors).toBe("");
    console.log(output);
    outputs = await prepareMaintenanceOutput(brain, { startupView: view });
    let failure: unknown;
    try {
      const git = await prepareMaintenanceGit({ brainPath: brain, command: ["/bin/true"], credentials: false,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" } }, outputs);
      expect(git, "PROBE_STATE_ORIGINAL_GIT_COLLECTOR_REPOSITORY").toBeDefined();
    } catch (error) { failure = error; }
    // The omission invocation reaches this assertion after the byte-original
    // collector records attrs/EACCES; do not turn that mutant into a green case.
    expect(failure, "PROBE_STATE_ORIGINAL_COLLECTOR_SUCCEEDS").toBeUndefined();
    expect(captured, "PROBE_STATE_CHECKPOINT_EXCLUDES_PRIVATE_SENTINEL").toEqual([]);
    console.log(JSON.stringify({ probeStateCollector: "pass", originalCollector: true, identity: qualified, capturedPrivateSentinels: captured.length }));
  } finally {
    // Release the owned barrier before waiting even when checkpointing refuses.
    try { if (!existsSync(release)) writeFileSync(release, "release", { mode: 0o600 }); }
    finally {
      try {
        if (!settled) await child.exited;
        await Promise.allSettled([stdout, stderr]);
      } finally {
        try { await outputs?.cleanup(); } finally { await view?.cleanup(); }
      }
    }
  }
  } finally { rmSync(barrier, { recursive: true, force: true }); }
}

import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as internal from "@schlessera/brain-ui-sdk/internal";
import { brainWorkerPath } from "@schlessera/brain-common/internal/worker-areas";
import { startBrainToolWorker, probeBrainBridgeInventory } from "../src/brain-tool-forwarder.js";
import { createBridgedTurnReservation } from "../src/brain-tool-reservation.js";
import { createClaudeSdkTurn } from "../src/sdk-options.js";
import { installTestHome } from "../../../scripts/test-home.js";
import { createWorkerSpawn } from "../src/worker-spawn.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ithaca-brain-worker-")), brain = join(root, "brain"), state = join(root, "state");
  mkdirSync(brain); mkdirSync(state); writeFileSync(join(brain, "brain.config.json"), "{}");
  const input = { brainPath: brain, exec: { wrapper: "/usr/bin/env" },
    sandbox: { brain, profile: "governed" as const, restricted: false, areas: [], scratchAliasesRemoved: [] },
    env: { HOME: root, PATH: "/usr/bin:/bin", BASH_ENV: "/operator/startup", ENV: "/operator/env", ZDOTDIR: "/operator/zsh",
      SHELLOPTS: "xtrace", BASHOPTS: "extdebug", "BASH_FUNC_ithaca%%": "() { :; }", ODYSSEUS: "retained" },
    limits: internal.launchLimits({}), turnTempLimits: { allowanceBytes: 1024 * 1024, budgetBytes: 1024 * 1024 },
    credentialEnv: [], req: { bridge: {} } as never };
  return { root, brain, state, input, signal: new AbortController().signal };
}
function worker(root: string) {
  const exit = Promise.withResolvers<number>();
  void exit.promise.catch(() => {});
  let closed = 0, released = 0;
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  const handle = { root, space: () => ({ total: 1024 * 1024, free: 1024 * 1024 }), async closeAsync() { closed++; } };
  const launched = { stdin, stdout, stderr, exited: exit.promise, turnTemp: handle, state: handle,
    kill() { stdout.end(); stderr.end(); exit.resolve(0); }, async released() { released++; }, limitReport: () => ({}) };
  return { launched: launched as unknown as internal.LaunchedWorker, exit, stdin, stdout, stderr, get closed() { return closed; }, get released() { return released; } };
}

for (const mode of ["inventory", "forwarder"] as const) test(`${mode} shares the runtime exec wrapper, worker PATH and shell-startup filtering`, async () => {
  const f = fixture(), child = worker(f.state);
  const calls: internal.WorkerLaunch[] = [];
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockImplementation(async input => {
    calls.push(input);
    if (mode === "inventory") { child.stdout.end('{"enabled":[],"available":[]}'); child.exit.resolve(0); }
    return child.launched;
  });
  let resource: Awaited<ReturnType<ReturnType<typeof startBrainToolWorker>>> | undefined;
  try {
    if (mode === "inventory") expect(await probeBrainBridgeInventory(f.input, f.signal)).toBe("core-only");
    else resource = await startBrainToolWorker(f.input)(f.signal);
    expect(calls).toHaveLength(1);
    const input = calls[0]!;
    expect(input.command, "BRAIN_SUBPROCESS_USES_OPERATOR_WRAPPER").toEqual(["/usr/bin/env", process.execPath, join(f.brain, "node_modules/.bin/brain"), ...(mode === "inventory" ? ["module", "list", "--json"] : ["mcp"])]);
    expect(input.env.PATH, "BRAIN_SUBPROCESS_USES_WORKER_PATH").toBe(brainWorkerPath(f.brain, f.input.env.PATH));
    expect(input.env.HOME).toBe(internal.WORKER_EMPTY_HOME);
    expect(input.hostHome).toBe(f.root);
    expect(input.env.ODYSSEUS).toBe("retained");
    for (const name of ["BASH_ENV", "ENV", "ZDOTDIR", "SHELLOPTS", "BASHOPTS", "BASH_FUNC_ithaca%%"])
      expect(input.env[name], `BRAIN_SUBPROCESS_WITHHOLDS_${name}`).toBeUndefined();
  } finally { await resource?.close(); launch.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const setupError of [false, true]) test(`rejecting exited still cleans brain pipes, temp and reservation during ${setupError ? "setup failure" : "close"}`, async () => {
  const f = fixture(), child = worker(f.state), ledger = internal.createStateLedger();
  const reserve = () => ledger.reserve(undefined, f.input.turnTempLimits);
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockResolvedValue(child.launched);
  let resource: Awaited<ReturnType<ReturnType<typeof startBrainToolWorker>>> | undefined;
  try {
    if (setupError) {
      await expect(startBrainToolWorker({ ...f.input, reservation: reserve, req: { bridge: {}, workerStarted() {
        child.exit.reject(new Error("Ithaca supervisor rejected")); throw new Error("Ithaca callback refused");
      } } as never })(f.signal)).rejects.toThrow("Ithaca supervisor rejected");
    } else {
      resource = await startBrainToolWorker({ ...f.input, reservation: reserve })(f.signal);
      child.exit.reject(new Error("Ithaca supervisor rejected"));
      await expect(resource.close()).rejects.toThrow("Ithaca supervisor rejected");
    }
    expect(child.stdin.writableEnded, "REJECTED_EXIT_ENDS_STDIN").toBe(true);
    expect(child.stdout.destroyed, "REJECTED_EXIT_DESTROYS_STDOUT").toBe(true);
    expect(child.stderr.destroyed, "REJECTED_EXIT_DESTROYS_STDERR").toBe(true);
    expect(child.released, "REJECTED_EXIT_DISPOSES_PIPES").toBe(1);
    expect(child.closed, "REJECTED_EXIT_CLOSES_TURN_TEMP").toBe(1);
    expect(ledger.turnTempHeld, "REJECTED_EXIT_RELEASES_RESERVATION").toBe(0);
  } finally { await resource?.close().catch(() => {}); launch.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

test("a budget of one admits both the brain forwarder and runtime and charges their combined mount limits", async () => {
  const f = fixture(), ledger = internal.createStateLedger();
  const stateLimits = { allowanceBytes: 1024 * 1024, budgetBytes: 1024 * 1024 };
  const shared = createBridgedTurnReservation(stateLimits, f.input.turnTempLimits, ledger);
  const children: ReturnType<typeof worker>[] = [], calls: internal.WorkerLaunch[] = [];
  const both = Promise.withResolvers<void>();
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockImplementation(async input => {
    calls.push(input); const child = worker(f.state); children.push(child);
    if (children.length === 2) both.resolve();
    return child.launched;
  });
  const host = spyOn(internal, "requireWorkerHostAsync").mockResolvedValue({ ok: true });
  const runtime = createWorkerSpawn(f.brain, {}, f.signal, undefined, f.input.sandbox, undefined, undefined,
    { ledger, limits: stateLimits, turnTempLimits: shared.runtimeTemp, reservation: shared.runtime });
  let brain: Awaited<ReturnType<ReturnType<typeof startBrainToolWorker>>> | undefined;
  try {
    brain = await startBrainToolWorker({ ...f.input, reservation: shared.brain })(f.signal);
    const process = runtime.spawn({ command: "/bin/true", args: [], env: { HOME: f.root }, signal: f.signal } as never);
    process.on("error", () => both.resolve());
    await both.promise;
    expect(calls, "ONE_SESSION_BUDGET_STARTS_BOTH_PROCESSES").toHaveLength(2);
    expect(calls.reduce((sum, call) => sum + call.turnTempBytes!, 0), "SUM_OF_MOUNTS_EQUALS_RESERVED_ALLOWANCE").toBe(f.input.turnTempLimits.allowanceBytes);
    expect([ledger.held, ledger.turnTempHeld, ledger.live]).toEqual([stateLimits.allowanceBytes, f.input.turnTempLimits.allowanceBytes, 1]);
    await brain.close(); shared.close();
    expect(ledger.turnTempHeld, "LIVE_RUNTIME_STILL_OWNS_RESERVATION").toBe(f.input.turnTempLimits.allowanceBytes);
    children[1]!.launched.kill("SIGKILL"); await runtime.finish();
    expect([ledger.held, ledger.turnTempHeld, ledger.live], "BOTH_CLEANUPS_RELEASE_SHARED_ALLOWANCE").toEqual([0, 0, 0]);
  } finally {
    for (const child of children) child.launched.kill("SIGKILL");
    await brain?.close().catch(() => {}); await runtime.finish().catch(() => {}); shared.close();
    host.mockRestore(); launch.mockRestore(); rmSync(f.root, { recursive: true, force: true });
  }
});


test("SDK assembly runs a bridged turn with a one-session temp budget and reports the runtime share", async () => {
  const f = fixture(), home = installTestHome(), ledger = internal.processStateLedger();
  const baseline = ledger.turnTempHeld;
  const calls: internal.WorkerLaunch[] = [], children: ReturnType<typeof worker>[] = [];
  const first = Promise.withResolvers<void>(), both = Promise.withResolvers<void>();
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockImplementation(async input => {
    calls.push(input); const child = worker(f.state); children.push(child);
    first.resolve(); if (children.length === 2) both.resolve();
    return child.launched;
  });
  const host = spyOn(internal, "requireWorkerHostAsync").mockResolvedValue({ ok: true });
  const controller = new AbortController();
  const turn = createClaudeSdkTurn({ backend: { brainPath: f.brain, turnTemp: { allowanceBytes: 1024 * 1024, budgetBytes: 1024 * 1024 } },
    brainBridgeInventory: "core-only", req: { prompt: "Odysseus checks Ithaca.", applicationAuthority: "server", workerSandbox: f.input.sandbox,
      signal: controller.signal, bridge: { emit() {}, async requestPermission() { return { behavior: "deny", message: "The fixture cannot grant." }; } } },
    profile: { id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: [], buildEnv: () => ({}) },
    turnEnvironment: { HOME: process.env.HOME }, abortController: controller, allowedTools: [], confirmPatterns: [],
    turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never, log() {} });
  try {
    turn.startBrainTools!(); await first.promise;
    const process = turn.options.spawnClaudeCodeProcess!({ command: "/bin/true", args: [], env: turn.options.env!, signal: controller.signal } as never);
    process.on("error", () => both.resolve()); await both.promise;
    expect(calls, "ASSEMBLED_BRIDGE_ADMITS_RUNTIME_WITH_ONE_SESSION_BUDGET").toHaveLength(2);
    expect(calls.map(call => call.turnTempBytes)).toEqual([512 * 1024, 512 * 1024]);
    expect(ledger.turnTempHeld - baseline, "ASSEMBLED_BRIDGE_CHARGES_ONE_ALLOWANCE").toBe(1024 * 1024);
    const message = await (turn.prompt as AsyncIterable<{ message: { content: string } }>)[Symbol.asyncIterator]().next();
    expect(message.value.message.content, "RUNTIME_NOTE_REPORTS_ACTUAL_MOUNT_ALLOWANCE").toContain("0.5 MiB");
  } finally {
    for (const child of children) child.launched.kill("SIGKILL");
    try { await turn.finishWorker(); expect(ledger.turnTempHeld).toBe(baseline); }
    finally { controller.abort(); host.mockRestore(); launch.mockRestore(); home.dispose(); rmSync(f.root, { recursive: true, force: true }); }
  }
});

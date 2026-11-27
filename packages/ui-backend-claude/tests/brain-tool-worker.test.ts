import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import * as internal from "@schlessera/brain-ui-sdk/internal";
import { brainWorkerPath } from "@schlessera/brain-common/internal/worker-areas";
import { startBrainToolWorker, probeBrainBridgeInventory, brainWorkerTransport, createBrainToolForwarder, bridgeBrainVersion, BRAIN_INVENTORY_TIMEOUT_MS, BRAIN_TOOL_EXIT_WAIT_MS } from "../src/brain-tool-forwarder.js";
import * as promptContext from "../src/prompt-context.js";
import { createBridgedTurnReservation } from "../src/brain-tool-reservation.js";
import { createClaudeSdkTurn } from "../src/sdk-options.js";
import { installTestHome } from "../../../scripts/test-home.js";
import { createWorkerSpawn } from "../src/worker-spawn.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ithaca-brain-worker-")), brain = join(root, "brain"), state = join(root, "state");
  mkdirSync(brain); mkdirSync(state); writeFileSync(join(brain, "brain.config.json"), "{}");
  mkdirSync(join(brain, "node_modules/.bin"), { recursive: true }); writeFileSync(join(brain, "node_modules/.bin/brain"), "");
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
  // Idempotent like the launcher's handle: `closed` counts the one release.
  let handleReleased = false;
  const handle = { root, space: () => ({ total: 1024 * 1024, free: 1024 * 1024 }), async closeAsync() { if (!handleReleased) { handleReleased = true; closed++; } } };
  const launched = { stdin, stdout, stderr, exited: exit.promise, turnTemp: handle, state: handle,
    kill() { stdout.end(); stderr.end(); exit.resolve(0); }, async released() { released++; }, limitReport: () => ({ hits: [], fatal: false }) };
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
    expect(input.command, "BRAIN_SUBPROCESS_USES_OPERATOR_WRAPPER").toEqual(["/usr/bin/env", process.execPath,
      ...(mode === "inventory" ? [Bun.resolveSync("../src/brain-bridge-inventory-entry", import.meta.dir), bridgeBrainVersion()] : ["node_modules/.bin/brain", "mcp"])]);
    expect(input.readOnlyBrain, "BRAIN_SUBPROCESS_IS_READ_ONLY").toBe(true);
    // The launcher plans an absolute existing argument as a host runtime
    // path; nothing in the live brain may become one (#4325 F19).
    expect(input.command.filter(part => isAbsolute(part) && (part === f.brain || part.startsWith(`${f.brain}/`))), "BRAIN_LAUNCH_PLANS_NO_LIVE_BRAIN_PATH").toEqual([]);
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
    // #4325 F27: the brain worker launched first; its hit joins the turn's report.
    const hit = { source: "cgroup", limit: "pids", events: 1 } as never;
    (children[0]!.launched as { limitReport: unknown }).limitReport = () => ({ hits: [hit], fatal: false });
    expect(turn.workerLimits.current().hits, "TURN_LIMITS_INCLUDE_FORWARDER_HITS").toContainEqual(hit);
  } finally {
    for (const child of children) child.launched.kill("SIGKILL");
    try { await turn.finishWorker(); expect(ledger.turnTempHeld).toBe(baseline); }
    finally { controller.abort(); host.mockRestore(); launch.mockRestore(); home.dispose(); rmSync(f.root, { recursive: true, force: true }); }
  }
});

for (const failure of ["launch", "nonzero", "malformed", "shape", "timeout"] as const) test(`inventory ${failure} failure keeps an unavailable verdict`, async () => {
  const f = fixture(), child = worker(f.state);
  let timeoutMs: number | undefined;
  const nativeTimer = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (failure === "timeout" && ms === BRAIN_INVENTORY_TIMEOUT_MS) { timeoutMs = ms; return nativeTimer(callback, 0, ...args); }
    return nativeTimer(callback, ms, ...args);
  }) as typeof setTimeout);
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockImplementation(async () => {
    if (failure === "launch") throw new Error("Ithaca helper cannot launch.");
    if (failure !== "timeout") {
      child.stdout.end(failure === "malformed" ? "Ithaca is not JSON" : failure === "shape" ? '{"enabled":[{"tools":[]}],"available":[]}' : '{"enabled":[],"available":[]}');
      child.exit.resolve(failure === "nonzero" ? 1 : 0);
    }
    return child.launched;
  });
  try {
    expect(await probeBrainBridgeInventory(f.input, f.signal), `FAILED_INVENTORY_${failure}_NEVER_SELECTS_CORE_BRIDGE`).toBe("unavailable");
    if (failure === "timeout") expect(timeoutMs, "INVENTORY_PRODUCT_TIMEOUT_IS_ITS_OWN_SHORT_BOUND").toBe(8_000);
    if (failure !== "launch") expect(child.closed, "FAILED_INVENTORY_RELEASES_TEMP").toBe(1);
  } finally { timer.mockRestore(); launch.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

// #4325 F20: the read-only forwarder never stages output, so it cannot take
// the staging slot a strict writer's runtime needs.
test("a strict turn with a writable area launches the forwarder read-only with no output stage", async () => {
  const f = fixture(), child = worker(f.state), calls: internal.WorkerLaunch[] = [];
  mkdirSync(join(f.brain, "notes"));
  const view = { root: f.brain } as unknown as internal.WorkerStartupView;
  const sandbox = { ...f.input.sandbox, profile: "strict" as const, areas: [
    { name: "notes", rel: "notes", mount: { writable: true, path: join(f.brain, "notes") } },
    { name: "workspaces", rel: "workspaces", mount: { writable: false, missing: true } }] } as unknown as internal.WorkerSandbox;
  const stage = spyOn(internal, "prepareNativeWorkerOutput");
  const retain = spyOn(internal, "retainWorkerStartupView").mockImplementation(value => value);
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockImplementation(async input => { calls.push(input); return child.launched; });
  let resource: Awaited<ReturnType<ReturnType<typeof startBrainToolWorker>>> | undefined;
  try {
    resource = await startBrainToolWorker({ ...f.input, sandbox, startupView: view })(f.signal);
    expect(stage, "FORWARDER_STAGES_NO_OUTPUT").not.toHaveBeenCalled();
    expect(calls[0]!.preparedOutput, "FORWARDER_HAS_NO_PREPARED_OUTPUT").toBeUndefined();
    expect(calls[0]!.sandbox!.profile, "FORWARDER_KEEPS_TURN_PROFILE").toBe("strict");
    expect(calls[0]!.sandbox!.areas.map(area => [area.name, area.mount.writable]), "FORWARDER_HAS_NO_WRITABLE_AREA").toEqual([["workspaces", false]]);
    expect(calls[0]!.startupView, "FORWARDER_KEEPS_TURN_VIEW").toBe(view);
  } finally { await resource?.close(); stage.mockRestore(); retain.mockRestore(); launch.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

// #4325 F25: a wrapper refused before launch leaves no retained view behind.
test("an invalid exec wrapper is refused before the startup view is retained", async () => {
  const f = fixture();
  const sandbox = { ...f.input.sandbox, profile: "strict" as const } as internal.WorkerSandbox;
  const retain = spyOn(internal, "retainWorkerStartupView").mockImplementation(value => value);
  const launch = spyOn(internal, "launchAgentWorkerAsync");
  try {
    await expect(startBrainToolWorker({ ...f.input, sandbox, startupView: { root: f.brain } as never, exec: { wrapper: "ithaca-wrapper" } })(f.signal))
      .rejects.toThrow("must be an absolute path");
    expect(retain, "REFUSED_WRAPPER_RETAINS_NO_VIEW").not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  } finally { retain.mockRestore(); launch.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

// #4325 F24: a refused signal request still runs every cleanup step.
for (const during of ["close", "abort"] as const) test(`a kill that throws during ${during} still releases pipes, temp and reservation`, async () => {
  const f = fixture(), child = worker(f.state), ledger = internal.createStateLedger(), controller = new AbortController();
  const kill = child.launched.kill;
  (child.launched as { kill: unknown }).kill = () => { kill(); throw new Error("Ithaca supervisor refused the signal."); };
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockResolvedValue(child.launched);
  try {
    const resource = await startBrainToolWorker({ ...f.input, reservation: () => ledger.reserve(undefined, f.input.turnTempLimits) })(controller.signal);
    if (during === "abort") expect(() => controller.abort(), "ABORT_LISTENER_CONTAINS_KILL_FAILURE").not.toThrow();
    await resource.close();
    expect([child.stdin.writableEnded, child.stdout.destroyed, child.stderr.destroyed], "THROWING_KILL_DISPOSES_STREAMS").toEqual([true, true, true]);
    expect([child.released, child.closed], "THROWING_KILL_RELEASES_PIPES_AND_TEMP").toEqual([1, 1]);
    expect(ledger.turnTempHeld, "THROWING_KILL_RELEASES_RESERVATION").toBe(0);
  } finally { launch.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

// #4325 F28: like the pinned stdio transport, one bad line never drops the next.
test("a malformed stdout line is reported and later lines in the same chunk are delivered", async () => {
  const f = fixture(), child = worker(f.state);
  try {
    const transport = brainWorkerTransport(child.launched);
    const messages: unknown[] = [], errors: unknown[] = [];
    transport.onmessage = message => messages.push(message);
    transport.onerror = error => errors.push(error);
    await transport.start();
    child.stdout.write('Odysseus starts the brain server.\n{"jsonrpc":"2.0","id":1,"result":{}}\n');
    await Bun.sleep(0);
    expect(errors, "MALFORMED_LINE_REPORTED").toHaveLength(1);
    expect(messages, "LATER_LINE_DELIVERED").toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  } finally { child.launched.kill("SIGKILL"); rmSync(f.root, { recursive: true, force: true }); }
});

// #4325 F27: a forwarded read's limit hit reaches the turn's limit report.
test("the forwarding worker's limit hits are reported with the runtime's", async () => {
  const hit = { source: "brain", limit: "pids", events: 1 } as never;
  const forward = createBrainToolForwarder(async () => ({ transport: brainWorkerTransport(worker("/tmp").launched),
    worker: { limitReport: () => ({ hits: [hit], fatal: false }) }, async close() {} }), new AbortController().signal, () => {});
  try {
    expect(forward.limitReports(), "NO_REPORT_BEFORE_START").toEqual([]);
    forward.start();
    for (let tries = 0; forward.limitReports().length === 0 && tries < 100; tries++) await Bun.sleep(1);
    expect(forward.limitReports(), "FORWARDER_LIMIT_REPORT_COLLECTED").toEqual([{ hits: [hit], fatal: false }]);
  } finally { await forward.close().catch(() => {}); }
});

// #4325 F26: a failed forwarder cleanup never withholds the acknowledgement of
// what the runtime already saved; the failure is still reported.
test("a forwarder cleanup failure still acknowledges the delivered context and then fails", async () => {
  const f = fixture(), home = installTestHome();
  const children: ReturnType<typeof worker>[] = [];
  const first = Promise.withResolvers<void>();
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockImplementation(async () => {
    const child = worker(f.state); children.push(child); first.resolve(); return child.launched;
  });
  const acknowledge = spyOn(promptContext, "acknowledgeClaudeContext").mockImplementation(() => {});
  const controller = new AbortController();
  const turn = createClaudeSdkTurn({ backend: { brainPath: f.brain, turnTemp: { allowanceBytes: 1024 * 1024, budgetBytes: 1024 * 1024 } },
    brainBridgeInventory: "core-only", req: { prompt: "Odysseus checks Ithaca.", applicationAuthority: "server", workerSandbox: f.input.sandbox,
      signal: controller.signal, bridge: { emit() {}, async requestPermission() { return { behavior: "deny", message: "The fixture cannot grant." }; } } },
    profile: { id: "fixture", label: "Fixture", billing: "api", requiredEnvKeys: [], buildEnv: () => ({}) },
    turnEnvironment: { HOME: process.env.HOME }, abortController: controller, allowedTools: [], confirmPatterns: [],
    turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never, log() {} });
  try {
    turn.startBrainTools!(); await first.promise;
    await (turn.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
    children[0]!.exit.reject(new Error("Ithaca supervisor lost the brain worker."));
    await expect(turn.finishWorker(), "FORWARDER_CLEANUP_FAILURE_IS_REPORTED").rejects.toThrow("Ithaca supervisor lost the brain worker.");
    expect(acknowledge, "DELIVERED_CONTEXT_STILL_ACKNOWLEDGED").toHaveBeenCalledTimes(1);
  } finally {
    for (const child of children) child.launched.kill("SIGKILL");
    controller.abort(); acknowledge.mockRestore(); launch.mockRestore(); home.dispose(); rmSync(f.root, { recursive: true, force: true });
  }
});

// #4325 F9: an oversized message ends the transport with an error instead of
// throwing out of the host stream listener.
test("an oversized stdout message ends the transport with a reported error, never a throw from the listener", async () => {
  const f = fixture(), child = worker(f.state);
  let killed = 0;
  const kill = child.launched.kill;
  (child.launched as { kill: unknown }).kill = (signal: string) => { killed++; kill(signal as never); };
  try {
    const transport = brainWorkerTransport(child.launched);
    const errors: unknown[] = [];
    transport.onerror = error => errors.push(error);
    await transport.start();
    expect(() => child.stdout.write(Buffer.alloc(10 * 1024 * 1024 + 1, 0x41)), "OVERSIZED_CHUNK_NEVER_THROWS").not.toThrow();
    await Bun.sleep(0);
    expect(errors.map(String), "OVERSIZED_MESSAGE_REPORTED").toEqual([expect.stringContaining("ReadBuffer exceeded maximum size")]);
    expect(killed, "OVERSIZED_MESSAGE_CLOSES_TRANSPORT").toBe(1);
  } finally { child.launched.kill("SIGKILL"); rmSync(f.root, { recursive: true, force: true }); }
});

// #4325 F12: a refused signal never hangs cleanup; end of input stops the
// server, and an exit that never comes keeps its allowance held, not leaked.
test("a refused kill still stops the server through end of input, and an unconfirmed exit keeps its allowance held", async () => {
  const f = fixture(), ledger = internal.createStateLedger();
  const exits = worker(f.state), stuck = worker(f.state);
  for (const child of [exits, stuck]) (child.launched as { kill: unknown }).kill = () => { throw new Error("Ithaca supervisor refused the signal."); };
  exits.stdin.on("finish", () => { exits.stdout.end(); exits.exit.resolve(0); });
  let launch = spyOn(internal, "launchAgentWorkerAsync").mockResolvedValue(exits.launched);
  const nativeTimer = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimer(callback, ms === 5_000 ? 0 : ms, ...args)) as typeof setTimeout);
  try {
    const reserve = () => ledger.reserve(undefined, f.input.turnTempLimits);
    const stopped = await startBrainToolWorker({ ...f.input, reservation: reserve })(f.signal);
    await stopped.close();
    expect([exits.released, exits.closed, ledger.turnTempHeld], "END_OF_INPUT_STOPS_A_SIGNAL_REFUSED_SERVER").toEqual([1, 1, 0]);
    launch.mockRestore(); launch = spyOn(internal, "launchAgentWorkerAsync").mockResolvedValue(stuck.launched);
    const hung = await startBrainToolWorker({ ...f.input, reservation: reserve })(f.signal);
    await expect(hung.close(), "UNCONFIRMED_EXIT_NEVER_HANGS").rejects.toThrow("brain_tool_worker_exit_unconfirmed");
    expect(ledger.turnTempHeld, "UNCONFIRMED_EXIT_KEEPS_ALLOWANCE_HELD").toBe(f.input.turnTempLimits.allowanceBytes);
    expect([stuck.stdout.destroyed, stuck.stderr.destroyed], "UNCONFIRMED_EXIT_DISPOSES_PIPES").toEqual([true, true]);
  } finally {
    stuck.exit.resolve(0); timer.mockRestore(); launch.mockRestore(); rmSync(f.root, { recursive: true, force: true });
  }
});

// #4325 round 2 F3: an inventory worker whose kill is refused and whose stdout
// never ends costs only the deadline; the new chat falls back to stdio.
for (const cause of ["deadline", "caller abort"] as const) test(`a hung inventory helper yields an unavailable verdict at its ${cause}`, async () => {
  const f = fixture(), child = worker(f.state), ledger = internal.createStateLedger(), controller = new AbortController();
  (child.launched as { kill: unknown }).kill = () => { throw new Error("Ithaca supervisor refused the signal."); };
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockResolvedValue(child.launched);
  const nativeTimer = globalThis.setTimeout;
  // The product deadline (cause "deadline") and the exit wait fire at once; the caller variant keeps the deadline.
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimer(callback, ms === 5_000 || (cause === "deadline" && ms === BRAIN_INVENTORY_TIMEOUT_MS) ? 0 : ms, ...args)) as typeof setTimeout);
  try {
    const probe = probeBrainBridgeInventory({ ...f.input, reservation: () => ledger.reserve(undefined, f.input.turnTempLimits) }, controller.signal);
    if (cause === "caller abort") { await Bun.sleep(10); controller.abort(); }
    const verdict = await Promise.race([probe, Bun.sleep(3_000).then(() => "STILL_WAITING")]);
    expect(verdict, `HUNG_INVENTORY_${cause}_IS_UNAVAILABLE`).toBe("unavailable");
    // Cleanup runs detached after the verdict; its exit wait is shortened here.
    for (let waited = 0; waited < 2_000 && !(child.stdout.destroyed && child.stderr.destroyed); waited += 10) await Bun.sleep(10);
    expect([child.stdout.destroyed, child.stderr.destroyed], "HUNG_INVENTORY_PIPES_DISPOSED").toEqual([true, true]);
    expect(ledger.turnTempHeld, "HUNG_INVENTORY_ALLOWANCE_HELD").toBe(f.input.turnTempLimits.allowanceBytes);
  } finally { child.exit.resolve(0); timer.mockRestore(); launch.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

// #4894 round 5: one lifecycle rule for every bridge worker. The verdict and
// close are decided by one bounded race; cleanup runs detached after it; a
// worker is signalled once, asynchronously; a launch that has not returned a
// worker is never awaited.
const shortTimers = (map: Record<number, number>) => {
  const nativeTimer = globalThis.setTimeout;
  return spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimer(callback, ms !== undefined && ms in map ? map[ms] : ms, ...args)) as typeof setTimeout);
};

test("a missed inventory deadline signals its worker once, asynchronously, never through a blocking call", async () => {
  const f = fixture(), child = worker(f.state), ledger = internal.createStateLedger();
  let syncSignals = 0, asyncSignals = 0;
  Object.assign(child.launched, { kill() { syncSignals++; }, async killAsync() { asyncSignals++; } });
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockResolvedValue(child.launched);
  const timer = shortTimers({ [BRAIN_INVENTORY_TIMEOUT_MS]: 20, [BRAIN_TOOL_EXIT_WAIT_MS]: 0 });
  try {
    const verdict = await probeBrainBridgeInventory({ ...f.input, reservation: () => ledger.reserve(undefined, f.input.turnTempLimits) }, f.signal);
    expect(verdict).toBe("unavailable");
    // Let the detached cleanup run its stop, which must not signal again.
    for (let waited = 0; waited < 2_000 && !child.stdout.destroyed; waited += 10) await Bun.sleep(10);
    expect({ syncSignals, asyncSignals }, "BRIDGE_WORKER_SIGNALLED_ONCE_ASYNC").toEqual({ syncSignals: 0, asyncSignals: 1 });
  } finally { child.exit.resolve(0); timer.mockRestore(); launch.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

// #4894 round 6 F1: turn scope gets a guarded handle, never the raw worker.
test("a launch returning after cancellation and turn-scope teardown is signalled exactly once, asynchronously", async () => {
  const f = fixture(), child = worker(f.state), controller = new AbortController(), ledger = internal.createStateLedger();
  let syncSignals = 0, asyncSignals = 0;
  Object.assign(child.launched, { kill() { syncSignals++; }, async killAsync() { asyncSignals++; } });
  const gate = Promise.withResolvers<internal.LaunchedWorker>();
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockImplementation(() => gate.promise);
  let scoped: { kill(): void } | undefined;
  const timer = shortTimers({ [BRAIN_TOOL_EXIT_WAIT_MS]: 0 });
  try {
    const starting = startBrainToolWorker({ ...f.input, reservation: () => ledger.reserve(undefined, f.input.turnTempLimits),
      req: { bridge: {}, workerStarted: (handle: { kill(): void }) => { scoped = handle; } } as never })(controller.signal);
    controller.abort();
    gate.resolve(child.launched);
    const resource = await starting;
    scoped!.kill();
    await resource.close().catch(() => {});
    expect({ syncSignals, asyncSignals }, "LATE_LAUNCH_SIGNALLED_ONCE_ASYNC").toEqual({ syncSignals: 0, asyncSignals: 1 });
    expect(scoped, "TURN_SCOPE_NEVER_GETS_THE_RAW_WORKER").not.toBe(child.launched);
  } finally { child.exit.resolve(0); timer.mockRestore(); launch.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

// #4894 round 6 F2: on a one-turn budget the forwarder reserves the allowance
// the probe held, once the probe's helper has exited and its storage closed,
// even while the probe's pipes are still held.
test("a probe's allowance is free for the forwarder once its helper exits, while its pipes are still held", async () => {
  const f = fixture(), probe = worker(f.state), forwarder = worker(f.state), ledger = internal.createStateLedger();
  (probe.launched as { released: unknown }).released = () => new Promise<void>(() => {});
  let launches = 0;
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockImplementation(async () => {
    if (launches++ > 0) return forwarder.launched;
    probe.stdout.end('{"enabled":[],"available":[]}'); probe.exit.resolve(0);
    return probe.launched;
  });
  const reservation = () => ledger.reserve(undefined, f.input.turnTempLimits);
  let started: Awaited<ReturnType<ReturnType<typeof startBrainToolWorker>>> | undefined;
  try {
    expect(await probeBrainBridgeInventory({ ...f.input, reservation }, f.signal)).toBe("core-only");
    for (let waited = 0; waited < 2_000 && ledger.turnTempHeld > 0; waited += 10) await Bun.sleep(10);
    expect(ledger.turnTempHeld, "PROBE_ALLOWANCE_FREE_AT_EXIT").toBe(0);
    started = await startBrainToolWorker({ ...f.input, reservation })(f.signal);
    expect(started.worker, "FORWARDER_RESERVES_AFTER_THE_PROBE").toBe(forwarder.launched);
  } finally {
    forwarder.stdout.end(); forwarder.exit.resolve(0); await started?.close().catch(() => {});
    launch.mockRestore(); rmSync(f.root, { recursive: true, force: true });
  }
});

test("a valid inventory returns its verdict while the worker's pipe release is still held", async () => {
  // Its own ledger: the held release keeps this reservation for good.
  const f = fixture(), child = worker(f.state), ledger = internal.createStateLedger();
  (child.launched as { released: unknown }).released = () => new Promise<void>(() => {});
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockImplementation(async () => {
    child.stdout.end('{"enabled":[],"available":[]}'); child.exit.resolve(0);
    return child.launched;
  });
  try {
    const verdict = await Promise.race([probeBrainBridgeInventory({ ...f.input, reservation: () => ledger.reserve(undefined, f.input.turnTempLimits) }, f.signal),
      Bun.sleep(2_000).then(() => "STILL_WAITING")]);
    expect(verdict, "VERDICT_NOT_HELD_BY_CLEANUP").toBe("core-only");
  } finally { launch.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

test("closing the forwarder never waits for a launch that has not returned, and closes it when it does", async () => {
  const gate = Promise.withResolvers<{ transport: never; close(): Promise<void> }>();
  let lateCloses = 0;
  const forward = createBrainToolForwarder(async () => gate.promise, new AbortController().signal, () => {});
  forward.start();
  await Bun.sleep(0);
  const closed = await Promise.race([forward.close().then(() => "closed"), Bun.sleep(1_000).then(() => "STILL_WAITING")]);
  expect(closed, "CLOSE_DOES_NOT_AWAIT_A_STALLED_LAUNCH").toBe("closed");
  gate.resolve({ transport: {} as never, async close() { lateCloses++; } });
  for (let waited = 0; waited < 1_000 && lateCloses === 0; waited += 10) await Bun.sleep(10);
  expect(lateCloses, "LATE_LAUNCH_CLOSED_DETACHED").toBe(1);
});

test("closing the forwarder waits for a started worker's cleanup only within the exit wait", async () => {
  const transport = { async start() {}, async send() {}, async close() { (transport as { onclose?: () => void }).onclose?.(); } };
  const forward = createBrainToolForwarder(async () => ({ transport: transport as never, close: () => new Promise<void>(() => {}) }), new AbortController().signal, () => {});
  forward.start();
  await Bun.sleep(10);
  const timer = shortTimers({ [BRAIN_TOOL_EXIT_WAIT_MS]: 20 });
  try {
    const closed = await Promise.race([forward.close().then(() => "closed"), Bun.sleep(1_000).then(() => "STILL_WAITING")]);
    expect(closed, "CLOSE_BOUNDED_BY_EXIT_WAIT").toBe("closed");
  } finally { timer.mockRestore(); }
});

// #4894 round 4 F4: a rejected exit (lost supervision) closes the transport
// once as well, so a pending call rejects at once instead of at its timeout.
test("a rejected worker exit closes the transport once and fails a pending call at once", async () => {
  const f = fixture(), child = worker(f.state);
  child.stdin.on("data", chunk => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      const message = JSON.parse(line);
      if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ithaca", version: "1" } } })}\n`);
    }
  });
  const client = new Client({ name: "ithaca-host", version: "1" });
  try {
    const transport = brainWorkerTransport(child.launched);
    await client.connect(transport);
    let closes = 0, errors = 0;
    const onclose = transport.onclose, onerror = transport.onerror;
    transport.onclose = () => { closes++; onclose?.(); };
    transport.onerror = error => { errors++; onerror?.(error); };
    const pending = client.listTools().then(() => "resolved", () => "rejected");
    child.exit.reject(new Error("Ithaca supervision was lost."));
    expect(await Promise.race([pending, Bun.sleep(1_000).then(() => "STILL_WAITING")]), "REJECTED_EXIT_FAILS_PENDING_CALL").toBe("rejected");
    child.stdout.end();
    await Bun.sleep(0);
    expect([closes, errors], "REJECTED_EXIT_CLOSES_ONCE_AND_REPORTS").toEqual([1, 1]);
  } finally { child.stdout.end(); rmSync(f.root, { recursive: true, force: true }); }
});

// #4894 round 4 F3: past its own bound the probe returns the stdio fallback at
// once; a worker that will not die costs its detached cleanup, never the
// verdict. The inventory deadline is shortened; the 5 s exit wait stays real.
test("a missed inventory deadline returns the fallback without waiting for the worker's exit", async () => {
  const f = fixture(), child = worker(f.state), ledger = internal.createStateLedger();
  (child.launched as { kill: unknown }).kill = () => { throw new Error("Ithaca supervisor refused the signal."); };
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockResolvedValue(child.launched);
  const nativeTimer = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    nativeTimer(callback, ms === BRAIN_INVENTORY_TIMEOUT_MS ? 20 : ms, ...args)) as typeof setTimeout);
  try {
    const started = performance.now();
    const verdict = await Promise.race([probeBrainBridgeInventory({ ...f.input, reservation: () => ledger.reserve(undefined, f.input.turnTempLimits) }, f.signal),
      Bun.sleep(2_000).then(() => "STILL_WAITING")]);
    expect(verdict, "MISSED_DEADLINE_RETURNS_FALLBACK_AT_ONCE").toBe("unavailable");
    expect(performance.now() - started, "FALLBACK_NOT_DELAYED_BY_THE_EXIT_WAIT").toBeLessThan(2_000);
    expect(ledger.turnTempHeld, "DETACHED_CLEANUP_KEEPS_ALLOWANCE_UNTIL_EXIT").toBe(f.input.turnTempLimits.allowanceBytes);
  } finally { child.exit.resolve(0); timer.mockRestore(); launch.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

// #4325 F3: under a separate UID the inventory helper's stdout is the identity
// supervisor's, which ends only once the broker closes, and the broker closes
// only when the worker's last handle is released. The probe releases its
// turn-temp handle on the helper's exit, so the verdict arrives at once
// instead of at the deadline.
test("a supervised inventory helper whose stdout ends only after its handle is released yields its verdict at exit", async () => {
  const f = fixture(), child = worker(f.state);
  const handle = (child.launched as unknown as { turnTemp: { closeAsync(): Promise<void> } }).turnTemp;
  const release = handle.closeAsync.bind(handle);
  handle.closeAsync = async () => { await release(); child.stdout.end(); };
  const launch = spyOn(internal, "launchAgentWorkerAsync").mockImplementation(async () => {
    child.stdout.write('{"enabled":[],"available":[]}'); child.exit.resolve(0);
    return child.launched;
  });
  try {
    const verdict = await Promise.race([probeBrainBridgeInventory(f.input, f.signal), Bun.sleep(2_000).then(() => "STILL_WAITING")]);
    expect(verdict, "SUPERVISED_INVENTORY_RELEASES_ITS_HANDLE_AT_EXIT").toBe("core-only");
    expect(child.closed, "SUPERVISED_INVENTORY_RELEASES_TEMP_ONCE").toBe(1);
  } finally { child.stdout.end(); launch.mockRestore(); rmSync(f.root, { recursive: true, force: true }); }
});

// #4325 F3 R2: the forwarder's transport closes at the worker's exit too, so a
// crashed supervised `brain mcp` fails its calls at once, not at their timeout.
test("the brain worker transport closes when the worker exits before its stdout ends", async () => {
  const f = fixture(), child = worker(f.state);
  try {
    const transport = brainWorkerTransport(child.launched);
    let closes = 0;
    transport.onclose = () => { closes++; };
    await transport.start();
    child.exit.resolve(1);
    await Bun.sleep(0);
    expect(closes, "WORKER_EXIT_CLOSES_THE_TRANSPORT").toBe(1);
    child.stdout.end();
    await Bun.sleep(0);
    expect(closes, "TRANSPORT_CLOSES_ONCE").toBe(1);
  } finally { child.stdout.end(); rmSync(f.root, { recursive: true, force: true }); }
});

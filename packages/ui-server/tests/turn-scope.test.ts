import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { writeFileSync, chmodSync, readdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchAgentWorker, prepareWorkerSandbox } from "@schlessera/brain-ui-sdk/internal";
import { createWorkerFreezer } from "../../ui-sdk/src/server/worker-freezer.js";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createTurnScope, SCOPE_DISCONNECTED_MS } from "../src/brain/turn-scope.js";
import { scopeFixture } from "./helpers/scope-fixture.js";
import { registeredInterval } from "./helpers/registered-interval.js";
async function wait(check: () => boolean, timeout = 5000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw Error("Scope fixture timed out"); await Bun.sleep(10); } }

test("real process tree freezes, resumes once per dimension, then stops with event-bound replay and independent grants", async () => {
  const f = scopeFixture({ max_tool_calls: 2, max_bytes_written: 8 }); let child: ReturnType<typeof f.worker> | undefined;
  try {
    await f.begin(); child = f.worker('while :; do printf x >> heartbeat; sleep 0.02; done & wait');
    await wait(() => Bun.file(join(f.brain, "heartbeat")).size > 0);
    f.scope.toolCall("voyage", "loom-1"); f.scope.toolCall("voyage", "loom-1"); f.scope.toolCall("voyage", "loom-2");
    const before = Bun.file(join(f.brain, "heartbeat")).size;
    await Bun.sleep(100);
    expect(Bun.file(join(f.brain, "heartbeat")).size, "SCOPE_RUNTIME_PAUSE_STOPS_RUNNING_DESCENDANT").toBe(before);
    expect(f.receipt()).toMatchObject({ state: "paused", dimension: "tool_calls", cap: 2, count: 2, newCap: 4, frozen: true, overshoot: 0 });
    const msg = f.message("continue");
    expect(f.scope.decide({ ...msg, sessionId: "ogygia" }, true).state).toBe("refused");
    expect(f.scope.decide({ ...msg, turnId: "other-turn" }, true).state).toBe("refused");
    expect(f.scope.decide(msg, false).state).toBe("refused");
    expect(f.scope.decide(msg, true).state).toBe("accepted");
    expect(f.scope.decide(msg, true).state).toBe("accepted");
    expect(f.scope.decide({ ...msg, submissionId: "penelope" }, true).state).toBe("answered_elsewhere");
    await wait(() => Bun.file(join(f.brain, "heartbeat")).size > before);
    f.scope.toolCall("voyage", "loom-3"); f.scope.toolCall("voyage", "loom-4");
    expect(f.receipt()).toMatchObject({ state: "paused", cap: 4 }); expect(f.receipt().newCap).toBeUndefined();
    expect(f.scope.decide(f.message("continue", "second-grant"), true).state, "SCOPE_SECOND_HIT_STOP_ONLY").toBe("refused");
    expect(f.scope.decide(f.message("stop", "stop-here"), true).state).toBe("accepted");
    await child.exited; await f.journal.finish("voyage"); f.scope.finish("voyage");
    expect(f.stopped).toContain("You stopped"); expect(f.journal.summary("voyage").state).toBe("complete");
    expect(f.db.query("SELECT count(*) AS n FROM governance_events WHERE kind='scope_cap'").get()).toEqual({ n: 2 });
  } finally { child?.kill("SIGKILL"); if (child) await child.exited; await f.close(); }
});

test("shared snapshots count ignored scratch, workspaces and repeated observed bytes, with independent finite grant", async () => {
  const f = scopeFixture({ max_bytes_written: 8, max_files_changed: 3 }); let child: ReturnType<typeof f.worker> | undefined;
  try {
    await f.begin(); child = f.worker('while :; do sleep 1; done');
    writeFileSync(join(f.brain, ".brain/scratch/loom"), "12345678"); await f.journal.observe();
    expect(f.receipt()).toMatchObject({ dimension: "turn_bytes", count: 8, cap: 8, newCap: 16 });
    expect(f.scope.decide(f.message("continue"), true).state).toBe("accepted");
    writeFileSync(join(f.brain, "workspaces/shroud"), "x"); writeFileSync(join(f.brain, "sail"), "x"); await f.journal.observe();
    expect(f.receipt()).toMatchObject({ dimension: "files_changed", count: 3, newCap: 6 });
    expect(f.scope.decide(f.message("continue", "files"), true).state, "SCOPE_OTHER_DIMENSION_RETAINS_GRANT").toBe("accepted");
    writeFileSync(join(f.brain, ".brain/scratch/loom"), "87654321"); await f.journal.observe();
    expect(f.receipt()).toMatchObject({ dimension: "turn_bytes", count: 18, cap: 16, overshoot: 2 }); expect(f.receipt().newCap).toBeUndefined();
    f.scope.decide(f.message("stop", "bytes-stop"), true); await child.exited;
  } finally { child?.kill("SIGKILL"); if (child) await child.exited; await f.close(); }
});

test("connected pause has no scope expiry; disconnect lifetime, reconnect and restart never resume automatically", async () => {
  let clock = Date.now(); const f = scopeFixture({ max_tool_calls: 1 }, () => clock); let child: ReturnType<typeof f.worker> | undefined;
  try {
    await f.begin(); child = f.worker('while :; do sleep 1; done'); f.scope.toolCall("voyage", "loom");
    clock += SCOPE_DISCONNECTED_MS * 2; await f.journal.observe(); expect(f.receipt().state).toBe("paused");
    f.disconnect(); await f.journal.observe(); clock += SCOPE_DISCONNECTED_MS - 1; await f.journal.observe(); expect(f.receipt().state).toBe("paused");
    f.reconnect(); await f.journal.observe(); expect(f.receipt().state, "SCOPE_RECONNECT_NEVER_RESUMES").toBe("paused");
    f.disconnect(); await f.journal.observe(); clock += SCOPE_DISCONNECTED_MS; await f.journal.observe();
    expect(f.receipt().state).toBe("ended_before_answer"); expect(f.scope.decide(f.message("continue"), true).state).toBe("ended_before_answer"); await child.exited;
  } finally { child?.kill("SIGKILL"); if (child) await child.exited; await f.close(); }
});

test("true voice stops without a grant and preserves partial work", async () => {
  const f = scopeFixture({ max_tool_calls: 1 }); let child: ReturnType<typeof f.worker> | undefined;
  try {
    await f.begin("voice"); child = f.worker('printf Ithaca > voice-note; while :; do sleep 1; done');
    await wait(() => Bun.file(join(f.brain, "voice-note")).size > 0); f.scope.toolCall("voyage", "loom"); await child.exited;
    expect(f.receipt()).toMatchObject({ state: "voice_stopped", cap: 1, frozen: true }); expect(f.receipt().newCap).toBeUndefined();
    expect(f.scope.decide(f.message("continue"), true).state).toBe("answered_elsewhere"); expect(f.stopped).toContain("I stopped");
    expect(await Bun.file(join(f.brain, "voice-note")).text()).toBe("Ithaca");
  } finally { child?.kill("SIGKILL"); if (child) await child.exited; await f.close(); }
});

// Assertion boundaries and real-time minima: docs/process/scope-observer-proof.md.
test("one long single Bash loop is frozen by the registered 15-second observation before finishing", async () => {
  const f = scopeFixture({ max_files_changed: 20 });
  const timerDescriptors = ["setInterval", "clearInterval"].map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const clock = registeredInterval();
  let child: ReturnType<typeof f.worker> | undefined, monitor: ReturnType<typeof Bun.spawn> | undefined;
  const scratch = join(f.brain, ".brain/scratch"), samples = join(f.root, "external-counts.jsonl");
  const countFiles = () => readdirSync(scratch).length;
  type Sample = { at: number; count: number };
  // Ignore the incomplete final line if the independent process is writing it.
  const progress = (): Sample[] => {
    try { return readFileSync(samples, "utf8").split("\n").slice(0, -1).map(line => JSON.parse(line) as Sample); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  // Read actual kernel task states, independently of the freeze method returning.
  // The bubblewrap PID-1 reaper must remain runnable; only its shell/sleep
  // descendants execute this fixed writer command.
  function writerStates(pid: number): boolean[] {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
    return children.flatMap(childPid => {
      try {
        const status = readFileSync(`/proc/${childPid}/status`, "utf8");
        const name = status.match(/^Name:\s+(.+)$/m)?.[1];
        const state = status.match(/^State:\s+(\S)/m)?.[1];
        let frozen = state === "T" || state === "t";
        if (!frozen && (name === "sh" || name === "sleep")) {
          // Delegated cgroup freezing need not report a task as SIGSTOPped.
          const group = readFileSync(`/proc/${childPid}/cgroup`, "utf8").match(/^0::(.+)$/m)?.[1];
          if (group) {
            try { frozen = /^frozen 1$/m.test(readFileSync(join("/sys/fs/cgroup", group, "cgroup.events"), "utf8")); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          }
        }
        // A sleep that exited just before STOP may be an unreaped zombie;
        // it cannot write. Require at least one remaining live writer task.
        return [...((name === "sh" || name === "sleep") && state !== "Z" ? [frozen] : []), ...writerStates(childPid)];
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    });
  }
  let frozenAt = 0, captureAt = 0, captureCount = 0, snapshotCount = 0, observationCount = 0;
  const checkpoint = f.native.manager.checkpoint;
  let captureFailure: unknown;
  try {
    await f.begin(); clock.finishRegistration();
    expect(clock.registrations.length, "SCOPE_SINGLE_HOST_INTERVAL_REGISTERED").toBe(1);
    const registration = clock.registrations[0]!;
    // This separate native process keeps sampling while synchronous host IO runs.
    monitor = Bun.spawn([process.execPath, "--no-env-file", "-e", 'const fs=require("node:fs"); setInterval(()=>{fs.appendFileSync(process.argv[2],JSON.stringify({at:Date.now(),count:fs.readdirSync(process.argv[1]).length})+"\\n");},20);', scratch, samples], { stdout: "ignore", stderr: "pipe" });
    child = f.worker('i=0; while [ "$i" -lt 10000 ]; do i=$((i+1)); printf Ithaca > .brain/scratch/sail-$i; sleep 0.05; done; printf done > finished');
    const freeze = child.freeze; child.freeze = () => { freeze(); frozenAt ||= Date.now(); };
    f.journal.onObservation(() => { observationCount++; });
    // The oracle, not the host's directory poll, must witness the cap crossing.
    await wait(() => progress().some(sample => sample.count >= 20));
    const crossing = progress().find(sample => sample.count >= 20)!;
    // Keep overshoot numerically meaningful: an always-zero receipt must fail.
    await wait(() => progress().some(sample => sample.count >= 22));
    f.native.manager.checkpoint = async (...args) => {
      try {
        const states = writerStates(child!.pid);
        expect(states.length, "SCOPE_NATIVE_WRITER_PRESENT_BEFORE_SNAPSHOT").toBeGreaterThan(0);
        expect(states.every(Boolean), "SCOPE_NATIVE_FREEZE_PRECEDES_SNAPSHOT").toBe(true);
        expect(frozenAt, "SCOPE_CONFIRMED_FREEZE_PRECEDES_SNAPSHOT").toBeGreaterThan(0);
        captureAt = Date.now(); captureCount = countFiles();
        // Candidate native proof: >=150 real ms and >=8 independent 20ms ticks
        // expose an unfrozen writer (50ms writes). JS clock advances cannot
        // establish absence of native progress. No production timer is shortened.
        await wait(() => {
          const during = progress().filter(sample => sample.at >= captureAt);
          return during.length >= 8 && during.at(-1)!.at - captureAt >= 150;
        });
        expect(countFiles(), "SCOPE_NATIVE_COUNT_STABLE_BEFORE_SNAPSHOT").toBe(captureCount);
        const atSnapshot = writerStates(child!.pid);
        expect(atSnapshot.length, "SCOPE_NATIVE_WRITER_PRESENT_AT_SNAPSHOT").toBeGreaterThan(0);
        expect(atSnapshot.every(Boolean), "SCOPE_NATIVE_FREEZE_PRECEDES_SNAPSHOT").toBe(true);
        const result = await checkpoint(...args);
        snapshotCount = readdirSync(join(result.path, ".brain/scratch")).length;
        expect(snapshotCount, "SCOPE_RETAINED_SNAPSHOT_MATCHES_FROZEN_WRITER").toBe(captureCount);
        expect(countFiles(), "SCOPE_NATIVE_COUNT_STABLE_DURING_SNAPSHOT").toBe(captureCount);
        return result;
      } catch (error) { captureFailure = error; throw error; }
    };
    clock.advanceTo(14_999);
    await f.journal.idle();
    expect(observationCount, "SCOPE_NO_OBSERVATION_BEFORE_DEADLINE").toBe(0);
    expect(frozenAt, "SCOPE_NO_FREEZE_BEFORE_DEADLINE").toBe(0);
    expect(f.journal.summary("voyage").scope!.receipts).toEqual([]);
    clock.advanceTo(15_000);
    expect(clock.dispatches, "SCOPE_OBSERVATION_DISPATCHED_AT_DEADLINE").toBe(1);
    await f.journal.idle();
    if (captureFailure) throw captureFailure;
    expect(observationCount, "SCOPE_OBSERVATION_COMPLETES_AT_DEADLINE").toBe(1);
    expect(registration.delay, "SCOPE_PRODUCTION_INTERVAL_IS_15000_MS").toBe(15_000);
    const receipt = f.receipt(), count = countFiles(), observed = progress();
    expect(receipt.dimension).toBe("files_changed");
    expect(frozenAt - crossing.at, "SCOPE_FROZEN_WITHIN_OBSERVATION_INTERVAL").toBeLessThanOrEqual(15_000);
    expect(observed.at(-1)!.count, "SCOPE_EXTERNAL_WRITER_PROGRESS_STOPS_BEFORE_RETENTION").toBe(count);
    expect(observed.some(sample => sample.at > frozenAt + 150 && sample.count === count), "SCOPE_EXTERNAL_OBSERVER_CONFIRMS_PAUSE_DURING_CAPTURE").toBe(true);
    expect(observed.filter(sample => sample.at >= captureAt).every(sample => sample.count === count), "SCOPE_EXTERNAL_COUNT_STABLE_THROUGH_CAPTURE").toBe(true);
    console.log("SCOPE_EXTERNAL_TIMING", JSON.stringify({ crossingAt: crossing.at, frozenAt, captureAt, receiptAt: receipt.observedAt, finalCount: count, logicalElapsedMs: 15_000 }));
    expect(receipt.count, "SCOPE_COUNT_TAKEN_AFTER_CONFIRMED_FREEZE").toBe(count);
    expect(receipt.count, "SCOPE_RECEIPT_MATCHES_RETAINED_SNAPSHOT").toBe(snapshotCount);
    expect(receipt.overshoot, "SCOPE_EXACT_OBSERVED_OVERSHOOT").toBe(count - 20);
    expect(receipt.overshoot, "SCOPE_POSITIVE_NATIVE_OVERSHOOT").toBeGreaterThan(0); expect(receipt.overshoot, "SCOPE_OBSERVATION_RATE_BOUND").toBeLessThanOrEqual(300);
    const stableAt = Date.now();
    await Bun.sleep(150); expect(countFiles(), "SCOPE_LONG_BASH_REALLY_FROZEN").toBe(count);
    await wait(() => progress().filter(sample => sample.at >= stableAt).length >= 5);
    expect(progress().filter(sample => sample.at >= stableAt).every(sample => sample.count === count), "SCOPE_EXTERNAL_FINAL_WINDOW_STAYS_FROZEN").toBe(true);
    expect(await Bun.file(join(f.brain, "finished")).exists()).toBe(false);
    expect(f.scope.decide(f.message("stop"), true).state, "SCOPE_LONG_BASH_STOP_ACCEPTED").toBe("accepted");
    expect(await child.exited, "SCOPE_LONG_BASH_STOP_EXITS_CHILD").toBe(137);
    f.native.manager.checkpoint = checkpoint;
    await f.journal.close();
    expect(registration.cancelled, "SCOPE_SHUTDOWN_CANCELS_REGISTERED_INTERVAL").toBe(true);
    const dispatched = clock.dispatches;
    clock.advanceTo(45_000);
    expect(clock.dispatches, "SCOPE_NO_OBSERVATION_AFTER_SHUTDOWN").toBe(dispatched);
  } finally {
    try {
      await clock.cleanup([
        () => { f.native.manager.checkpoint = checkpoint; },
        () => monitor?.kill("SIGKILL"),
        () => child?.kill("SIGKILL"),
        async () => { if (monitor) expect(await monitor.exited, "SCOPE_EXTERNAL_OBSERVER_EXIT").toBe(137); },
        async () => { if (child) await child.exited; },
        () => f.close(),
      ]);
    } finally {
      expect(["setInterval", "clearInterval"].map(name => Object.getOwnPropertyDescriptor(globalThis, name)), "SCOPE_HOST_TIMER_DESCRIPTORS_RESTORED").toEqual(timerDescriptors);
    }
  }
}, 60_000);

test("scope timer cleanup attempts every action and restores native successor scheduling after a failure", async () => {
  const names = ["setInterval", "clearInterval"];
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const clock = registeredInterval(), visited: string[] = [];
  const injected = Error("Injected monitor cleanup failure");
  let failure: unknown;
  try {
    await clock.cleanup([
      () => { visited.push("monitor"); throw injected; },
      () => { visited.push("writer"); },
      () => { visited.push("fixture"); },
    ]);
  } catch (error) { failure = error; }
  const restored = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  clock.restore();
  expect(visited, "SCOPE_CLEANUP_ATTEMPTS_SUCCESSORS_AFTER_FAILURE").toEqual(["monitor", "writer", "fixture"]);
  expect(failure, "SCOPE_CLEANUP_REPORTS_COLLECTED_FAILURE").toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors).toEqual([injected]);
  expect(restored, "SCOPE_CLEANUP_FAILURE_RESTORES_DESCRIPTORS").toEqual(descriptors);
  let ticks = 0;
  const successor = setInterval(() => { ticks++; }, 1);
  try { await wait(() => ticks > 0); }
  finally { clearInterval(successor); }
  expect(ticks, "SCOPE_CLEANUP_SUCCESSOR_USES_NATIVE_INTERVAL").toBeGreaterThan(0);
  expect(clock.registrations, "SCOPE_CLEANUP_SUCCESSOR_IS_NOT_CAPTURED").toEqual([]);
});

test.each(["running", "pausedFloor"])("small tmpfs brain: %s crosses the real statfs floor and permits Stop only", async mode => {
  const brain = mkdtempSync(join(tmpdir(), "odysseus-scope-tmpfs-"));
  try {
    const child = Bun.spawn([Bun.which("bwrap")!, "--unshare-user", "--unshare-net", "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
      "--size", String(2 * 1024 ** 3 + 32 * 1024 ** 2), "--tmpfs", brain,
      process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/scope-tmpfs-probe.ts"), brain, mode], { cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `SCOPE_TMPFS_SUPPORTED_LIFECYCLE: ${errors}${output}`).toBe(0);
    expect(JSON.parse(output.trim())).toMatchObject({ proof: "supported tmpfs worker freeze/Stop", receipt: { dimension: "free_space_floor", cap: 2 * 1024 ** 3, frozen: true, state: "stopped" } });
  } finally { rmSync(brain, { recursive: true, force: true }); }
}, 45_000);

test("real host restart kills its paused namespace, records interruption and never grants a retained answer", async () => {
  const host = Bun.spawn([Bun.which("bwrap")!, "--unshare-user", "--unshare-net", "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
    process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/scope-restart-probe.ts")], { cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  let root = "";
  try {
    const reader = host.stdout.getReader(), first = await reader.read();
    const packet = JSON.parse(new TextDecoder().decode(first.value).trim()) as { root: string; brain: string; workerPid: number; serverPid: number; state: string }; root = packet.root;
    expect(packet.state).toBe("paused"); process.kill(packet.serverPid, "SIGKILL"); await host.exited;
    await wait(() => { try { return readFileSync(`/proc/${packet.workerPid}/stat`, "utf8").replace(/^.*\) /s, "").startsWith("Z"); } catch { return true; } });
    const path = join(root, "ui.db"), db = createUiDb(path), native = createNativeJournalFixture(packet.brain, root), journal = createTurnJournal(db, { nativeManager: native.manager, brainPath: packet.brain, dbPath: path, objectsRoot: join(root, "objects") });
    const recovered = createTurnScope(db, { brainPath: packet.brain, journal, connected: () => true, changed: () => {} });
    try {
      const receipt = journal.summary("voyage").scope!.receipts[0]!;
      expect(receipt.state, "SCOPE_RESTART_INTERRUPTION_RECEIPT").toBe("ended_before_answer"); expect(receipt.reason).toContain("Host restarted");
      expect(journal.summary("voyage").state).toBe("partial");
      expect(recovered.decide({ type: "scope_decision", eventId: receipt.eventId, turnId: "voyage", sessionId: "ithaca", submissionId: "late-device", action: "continue" }, true).state).toBe("ended_before_answer");
      expect(db.query("SELECT count(*) AS n FROM governance_events WHERE kind='roadblock'").get(), "SCOPE_RESTART_RETAINS_ROADBLOCK").toEqual({ n: 1 });
      expect(await Bun.file(join(packet.brain, "restart-note")).text()).toBe("Ithaca");
    } finally { recovered.close(); await journal.close(); await native.close(); db.close(); }
  } finally { host.kill("SIGKILL"); await host.exited; if (root) rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test("wall time uses the frozen policy independently of later edits and hard limits, then allows only one finite grant", async () => {
  let clock = Date.now(); const f = scopeFixture({ max_minutes: .25 }, () => clock); let child: ReturnType<typeof f.worker> | undefined;
  try {
    await f.begin(); child = f.worker('while :; do sleep 1; done'); f.policy.scope.max_minutes = 90; clock += 15_001; await f.journal.observe();
    expect(f.receipt()).toMatchObject({ dimension: "minutes", cap: .25, newCap: .5, frozen: true });
    expect(f.scope.decide(f.message("continue"), true).state).toBe("accepted");
    clock += 15_001; await f.journal.observe(); expect(f.receipt()).toMatchObject({ cap: .5, state: "paused" }); expect(f.receipt().newCap).toBeUndefined();
    f.scope.decide(f.message("stop", "time-stop"), true); await child.exited;
  } finally { child?.kill("SIGKILL"); if (child) await child.exited; await f.close(); }
});

test("namespace freeze never signals the host or an unrelated worker", async () => {
  expect(() => createWorkerFreezer(process.pid), "SCOPE_HOST_NAMESPACE_REFUSED_BEFORE_SIGNAL").toThrow("verified private PID namespace");
  const f = scopeFixture({ max_tool_calls: 1 }), neighborBrain = mkdtempSync(join(tmpdir(), "odysseus-scope-neighbor-")); let own: ReturnType<typeof f.worker> | undefined, neighbor: ReturnType<typeof launchAgentWorker> | undefined;
  try {
    await f.begin(); own = f.worker('while :; do printf x >> own-heartbeat; sleep 0.02; done');
    neighbor = launchAgentWorker({ brainPath: neighborBrain, sandbox: prepareWorkerSandbox(neighborBrain, { profile: "governed", areas: [] }),
      command: ["/bin/sh", "-c", 'while :; do printf x >> neighbor-heartbeat; sleep 0.3; done'], env: { PATH: "/usr/bin:/bin" } });
    neighbor.stdout.resume(); neighbor.stderr.resume(); neighbor.stdin.end();
    await wait(() => Bun.file(join(f.brain, "own-heartbeat")).size > 0 && Bun.file(join(neighborBrain, "neighbor-heartbeat")).size > 0);
    f.scope.toolCall("voyage", "loom");
    const ownBytes = Bun.file(join(f.brain, "own-heartbeat")).size, neighborBytes = Bun.file(join(neighborBrain, "neighbor-heartbeat")).size;
    // A runnable neighbor may not be scheduled within 100ms on a shared host.
    // Its deliberately slower heartbeat must advance while our namespace stays frozen.
    const neighborDeadline = Date.now() + 5000;
    do {
      await Bun.sleep(10);
      expect(Bun.file(join(f.brain, "own-heartbeat")).size, "SCOPE_OWN_NAMESPACE_STAYS_FROZEN").toBe(ownBytes);
    } while (Bun.file(join(neighborBrain, "neighbor-heartbeat")).size <= neighborBytes && Date.now() < neighborDeadline);
    expect(Bun.file(join(neighborBrain, "neighbor-heartbeat")).size, "SCOPE_UNRELATED_NAMESPACE_STAYS_RUNNING").toBeGreaterThan(neighborBytes);
    expect(f.scope.decide(f.message("stop"), true).state, "SCOPE_UNRELATED_WORKER_STOP_ACKNOWLEDGED").toBe("accepted"); await own.exited;
  } finally { own?.kill("SIGKILL"); neighbor?.kill("SIGKILL"); if (own) await own.exited; if (neighbor) await neighbor.exited; await f.close(); rmSync(neighborBrain, { recursive: true, force: true }); }
});

test("failed freeze or resume stops the real worker, retains work and exposes an ended readback without a second effect", async () => {
  for (const failure of ["freeze", "resume"] as const) {
    const f = scopeFixture({ max_tool_calls: 1 }); let child: ReturnType<typeof f.worker> | undefined;
    try {
      await f.begin(); child = f.worker('printf Ithaca > partial-note; while :; do sleep 1; done');
      await wait(() => Bun.file(join(f.brain, "partial-note")).size > 0);
      if (failure === "freeze") child.freeze = () => { throw Error("Freeze could not be confirmed"); };
      f.scope.toolCall("voyage", "loom");
      if (failure === "resume") {
        child.resume = () => { throw Error("Resume failed"); };
        await f.journal.idle();
        const message = f.message("continue"); expect(f.scope.decide(message, true).state).toBe("failed");
        expect(f.scope.decide({ ...message, action: "readback" }, true).state, "SCOPE_FAILED_RESUME_ENDED_READBACK").toBe("ended_before_answer");
        expect(f.receipt().state).toBe("ended_before_answer");
      } else {
        expect(f.receipt()).toMatchObject({ state: "stopped", frozen: false }); expect(f.receipt().newCap).toBeUndefined();
        expect(f.db.query("SELECT count(*) AS n FROM governance_events WHERE kind='scope_cap'").get()).toEqual({ n: 1 });
      }
      await child.exited; expect(await Bun.file(join(f.brain, "partial-note")).text()).toBe("Ithaca");
    } finally { child?.kill("SIGKILL"); if (child) await child.exited; await f.close(); }
  }
});


test("periodic capture resumes a productive worker and snapshot failure terminates its held worker", async () => {
  for (const failCapture of [false, true]) {
    const f = scopeFixture(); let child: ReturnType<typeof f.worker> | undefined;
    try {
      await f.begin(); child = f.worker('while :; do printf x >> heartbeat; sleep 0.02; done');
      await wait(() => Bun.file(join(f.brain, "heartbeat")).size > 0);
      if (failCapture) {
        // Actual non-root CAS publication fails on this owned read-only store.
        // The worker must stay stopped after the observation window ends.
        chmodSync(join(f.root, "objects"), 0o555);
      }
      let freezes = 0, resumes = 0;
      let captureWitness: { before: number; after: number } | undefined;
      if (!failCapture) f.journal.onObservation(() => {
        const before = Bun.file(join(f.brain, "heartbeat")).size;
        // Model a finite slow downstream observation consumer while the actual
        // worker heartbeat independently runs or stays frozen.
        Bun.sleepSync(200);
        captureWitness = { before, after: Bun.file(join(f.brain, "heartbeat")).size };
      });
      const freeze = child.freeze, resume = child.resume;
      child.freeze = () => { freeze(); freezes++; };
      child.resume = () => { resume(); resumes++; };
      await wait(() => failCapture ? freezes > 0 : captureWitness !== undefined, 16_000);
      if (failCapture) {
        await child.exited;
        expect(resumes, "SCOPE_CAPTURE_FAILURE_NEVER_RESUMES_ENDED_WORKER").toBe(0);
        expect(f.stopped.length, "SCOPE_CAPTURE_FAILURE_STOPS_WITH_REASON").toBeGreaterThan(0);
        expect(f.journal.summary("voyage").state).toBe("partial");
      } else {
        expect(captureWitness!.after, "SCOPE_PERIODIC_CAPTURE_STOPS_PRODUCTIVE_WORKER").toBe(captureWitness!.before);
        const before = Bun.file(join(f.brain, "heartbeat")).size;
        await wait(() => Bun.file(join(f.brain, "heartbeat")).size > before);
        expect(resumes, "SCOPE_PRODUCTIVE_OBSERVATION_RESUMES_ONLY_TEMPORARY_HOLD").toBe(1);
        expect(f.journal.summary("voyage").scope!.receipts).toEqual([]);
      }
    } finally { child?.kill("SIGKILL"); if (child) await child.exited; chmodSync(join(f.root, "objects"), 0o700); await f.close(); }
  }
}, 45_000);

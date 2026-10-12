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
async function wait(check: () => boolean, timeout = 5000) { const end = Date.now() + timeout; while (!check()) { if (Date.now() > end) throw Error("Scope fixture timed out"); await Bun.sleep(10); } }

test("real process tree freezes, resumes once per dimension, then stops with event-bound replay and independent grants", async () => {
  const f = scopeFixture({ max_tool_calls: 2, max_bytes_written: 8 }); let child: ReturnType<typeof f.worker> | undefined;
  try {
    f.begin(); child = f.worker('while :; do printf x >> heartbeat; sleep 0.02; done & wait');
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
    await child.exited; f.journal.finish("voyage"); f.scope.finish("voyage");
    expect(f.stopped).toContain("You stopped"); expect(f.journal.summary("voyage").state).toBe("complete");
    expect(f.db.query("SELECT count(*) AS n FROM governance_events WHERE kind='scope_cap'").get()).toEqual({ n: 2 });
  } finally { child?.kill("SIGKILL"); if (child) await child.exited; f.close(); }
});

test("shared snapshots count ignored scratch, workspaces and repeated observed bytes, with independent finite grant", async () => {
  const f = scopeFixture({ max_bytes_written: 8, max_files_changed: 3 }); let child: ReturnType<typeof f.worker> | undefined;
  try {
    f.begin(); child = f.worker('while :; do sleep 1; done');
    writeFileSync(join(f.brain, ".brain/scratch/loom"), "12345678"); f.journal.observe();
    expect(f.receipt()).toMatchObject({ dimension: "turn_bytes", count: 8, cap: 8, newCap: 16 });
    expect(f.scope.decide(f.message("continue"), true).state).toBe("accepted");
    writeFileSync(join(f.brain, "workspaces/shroud"), "x"); writeFileSync(join(f.brain, "sail"), "x"); f.journal.observe();
    expect(f.receipt()).toMatchObject({ dimension: "files_changed", count: 3, newCap: 6 });
    expect(f.scope.decide(f.message("continue", "files"), true).state, "SCOPE_OTHER_DIMENSION_RETAINS_GRANT").toBe("accepted");
    writeFileSync(join(f.brain, ".brain/scratch/loom"), "87654321"); f.journal.observe();
    expect(f.receipt()).toMatchObject({ dimension: "turn_bytes", count: 18, cap: 16, overshoot: 2 }); expect(f.receipt().newCap).toBeUndefined();
    f.scope.decide(f.message("stop", "bytes-stop"), true); await child.exited;
  } finally { child?.kill("SIGKILL"); if (child) await child.exited; f.close(); }
});

test("connected pause has no scope expiry; disconnect lifetime, reconnect and restart never resume automatically", async () => {
  let clock = Date.now(); const f = scopeFixture({ max_tool_calls: 1 }, () => clock); let child: ReturnType<typeof f.worker> | undefined;
  try {
    f.begin(); child = f.worker('while :; do sleep 1; done'); f.scope.toolCall("voyage", "loom");
    clock += SCOPE_DISCONNECTED_MS * 2; f.journal.observe(); expect(f.receipt().state).toBe("paused");
    f.disconnect(); f.journal.observe(); clock += SCOPE_DISCONNECTED_MS - 1; f.journal.observe(); expect(f.receipt().state).toBe("paused");
    f.reconnect(); f.journal.observe(); expect(f.receipt().state, "SCOPE_RECONNECT_NEVER_RESUMES").toBe("paused");
    f.disconnect(); f.journal.observe(); clock += SCOPE_DISCONNECTED_MS; f.journal.observe();
    expect(f.receipt().state).toBe("ended_before_answer"); expect(f.scope.decide(f.message("continue"), true).state).toBe("ended_before_answer"); await child.exited;
  } finally { child?.kill("SIGKILL"); if (child) await child.exited; f.close(); }
});

test("true voice stops without a grant and preserves partial work", async () => {
  const f = scopeFixture({ max_tool_calls: 1 }); let child: ReturnType<typeof f.worker> | undefined;
  try {
    f.begin("voice"); child = f.worker('printf Ithaca > voice-note; while :; do sleep 1; done');
    await wait(() => Bun.file(join(f.brain, "voice-note")).size > 0); f.scope.toolCall("voyage", "loom"); await child.exited;
    expect(f.receipt()).toMatchObject({ state: "voice_stopped", cap: 1, frozen: true }); expect(f.receipt().newCap).toBeUndefined();
    expect(f.scope.decide(f.message("continue"), true).state).toBe("answered_elsewhere"); expect(f.stopped).toContain("I stopped");
    expect(await Bun.file(join(f.brain, "voice-note")).text()).toBe("Ithaca");
  } finally { child?.kill("SIGKILL"); if (child) await child.exited; f.close(); }
});

test("one long single Bash loop is frozen by the real 15-second observation before finishing", async () => {
  const f = scopeFixture({ max_files_changed: 20 }); let child: ReturnType<typeof f.worker> | undefined, monitor: ReturnType<typeof Bun.spawn> | undefined;
  try {
    f.begin();
    const samples = join(f.root, "external-counts.jsonl");
    // A separate host process observes progress while synchronous CAS retention
    // occupies the test host. Receipt time truthfully follows that capture.
    monitor = Bun.spawn([process.execPath, "--no-env-file", "-e", 'const fs=require("node:fs"); setInterval(()=>{fs.appendFileSync(process.argv[2],JSON.stringify({at:Date.now(),count:fs.readdirSync(process.argv[1]).length})+"\\n");},20);', join(f.brain, ".brain/scratch"), samples], { stdout: "ignore", stderr: "pipe" });
    child = f.worker('i=0; while [ "$i" -lt 10000 ]; do i=$((i+1)); printf Ithaca > .brain/scratch/sail-$i; sleep 0.05; done; printf done > finished');
    let frozenAt = 0; const freeze = child.freeze; child.freeze = () => { freeze(); frozenAt ||= Date.now(); };
    await wait(() => { if (readdirSync(join(f.brain, ".brain/scratch")).length >= 20) return true; return false; });
    await wait(() => f.journal.summary("voyage").scope!.receipts.length > 0, 16_000);
    const receipt = f.receipt(), count = readdirSync(join(f.brain, ".brain/scratch")).length;
    const progress = readFileSync(samples, "utf8").trim().split("\n").map(line => JSON.parse(line) as { at: number; count: number });
    const crossing = progress.find(sample => sample.count >= 20)!;
    expect(receipt.dimension).toBe("files_changed");
    expect(frozenAt - crossing.at, "SCOPE_FROZEN_WITHIN_OBSERVATION_INTERVAL").toBeLessThanOrEqual(15_000);
    expect(progress.at(-1)!.count, "SCOPE_EXTERNAL_WRITER_PROGRESS_STOPS_BEFORE_RETENTION").toBe(count);
    expect(progress.some(sample => sample.at > frozenAt + 150 && sample.count === count), "SCOPE_EXTERNAL_OBSERVER_CONFIRMS_PAUSE_DURING_CAPTURE").toBe(true);
    console.log("SCOPE_EXTERNAL_TIMING", JSON.stringify({ crossingAt: crossing.at, frozenAt, receiptAt: receipt.observedAt, finalCount: count }));
    expect(receipt.count, "SCOPE_COUNT_TAKEN_AFTER_CONFIRMED_FREEZE").toBe(count);
    expect(receipt.overshoot).toBe(count - 20); expect(receipt.overshoot, "SCOPE_OBSERVATION_RATE_BOUND").toBeLessThanOrEqual(300);
    await Bun.sleep(150); expect(readdirSync(join(f.brain, ".brain/scratch")).length, "SCOPE_LONG_BASH_REALLY_FROZEN").toBe(count);
    expect(await Bun.file(join(f.brain, "finished")).exists()).toBe(false);
    f.scope.decide(f.message("stop"), true); await child.exited;
  } finally { monitor?.kill("SIGKILL"); if (monitor) await monitor.exited; child?.kill("SIGKILL"); if (child) await child.exited; f.close(); }
// Cold retained-version capture follows the independently asserted 15s freeze.
}, 60_000);

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
}, 30_000);

test("real host restart kills its paused namespace, records interruption and never grants a retained answer", async () => {
  const host = Bun.spawn([Bun.which("bwrap")!, "--unshare-user", "--unshare-net", "--bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
    process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/scope-restart-probe.ts")], { cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
  let root = "";
  try {
    const reader = host.stdout.getReader(), first = await reader.read();
    const packet = JSON.parse(new TextDecoder().decode(first.value).trim()) as { root: string; brain: string; workerPid: number; serverPid: number; state: string }; root = packet.root;
    expect(packet.state).toBe("paused"); process.kill(packet.serverPid, "SIGKILL"); await host.exited;
    await wait(() => { try { return readFileSync(`/proc/${packet.workerPid}/stat`, "utf8").replace(/^.*\) /s, "").startsWith("Z"); } catch { return true; } });
    const path = join(root, "ui.db"), db = createUiDb(path), journal = createTurnJournal(db, { brainPath: packet.brain, dbPath: path, objectsRoot: join(root, "objects") });
    const recovered = createTurnScope(db, { brainPath: packet.brain, journal, connected: () => true, changed: () => {} });
    try {
      const receipt = journal.summary("voyage").scope!.receipts[0]!;
      expect(receipt.state, "SCOPE_RESTART_INTERRUPTION_RECEIPT").toBe("ended_before_answer"); expect(receipt.reason).toContain("Host restarted");
      expect(journal.summary("voyage").state).toBe("partial");
      expect(recovered.decide({ type: "scope_decision", eventId: receipt.eventId, turnId: "voyage", sessionId: "ithaca", submissionId: "late-device", action: "continue" }, true).state).toBe("ended_before_answer");
      expect(db.query("SELECT count(*) AS n FROM governance_events WHERE kind='roadblock'").get(), "SCOPE_RESTART_RETAINS_ROADBLOCK").toEqual({ n: 1 });
      expect(await Bun.file(join(packet.brain, "restart-note")).text()).toBe("Ithaca");
    } finally { recovered.close(); journal.close(); db.close(); }
  } finally { host.kill("SIGKILL"); await host.exited; if (root) rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test("wall time uses the frozen policy independently of later edits and hard limits, then allows only one finite grant", async () => {
  let clock = Date.now(); const f = scopeFixture({ max_minutes: .25 }, () => clock); let child: ReturnType<typeof f.worker> | undefined;
  try {
    f.begin(); child = f.worker('while :; do sleep 1; done'); f.policy.scope.max_minutes = 90; clock += 15_001; f.journal.observe();
    expect(f.receipt()).toMatchObject({ dimension: "minutes", cap: .25, newCap: .5, frozen: true });
    expect(f.scope.decide(f.message("continue"), true).state).toBe("accepted");
    clock += 15_001; f.journal.observe(); expect(f.receipt()).toMatchObject({ cap: .5, state: "paused" }); expect(f.receipt().newCap).toBeUndefined();
    f.scope.decide(f.message("stop", "time-stop"), true); await child.exited;
  } finally { child?.kill("SIGKILL"); if (child) await child.exited; f.close(); }
});

test("namespace freeze never signals the host or an unrelated worker", async () => {
  expect(() => createWorkerFreezer(process.pid), "SCOPE_HOST_NAMESPACE_REFUSED_BEFORE_SIGNAL").toThrow("verified private PID namespace");
  const f = scopeFixture({ max_tool_calls: 1 }), neighborBrain = mkdtempSync(join(tmpdir(), "odysseus-scope-neighbor-")); let own: ReturnType<typeof f.worker> | undefined, neighbor: ReturnType<typeof launchAgentWorker> | undefined;
  try {
    f.begin(); own = f.worker('while :; do printf x >> own-heartbeat; sleep 0.02; done');
    neighbor = launchAgentWorker({ brainPath: neighborBrain, sandbox: prepareWorkerSandbox(neighborBrain, { profile: "governed", areas: [] }),
      command: ["/bin/sh", "-c", 'while :; do printf x >> neighbor-heartbeat; sleep 0.02; done'], env: { PATH: "/usr/bin:/bin" } });
    neighbor.stdout.resume(); neighbor.stderr.resume(); neighbor.stdin.end();
    await wait(() => Bun.file(join(f.brain, "own-heartbeat")).size > 0 && Bun.file(join(neighborBrain, "neighbor-heartbeat")).size > 0);
    f.scope.toolCall("voyage", "loom");
    const ownBytes = Bun.file(join(f.brain, "own-heartbeat")).size, neighborBytes = Bun.file(join(neighborBrain, "neighbor-heartbeat")).size;
    await Bun.sleep(100);
    expect(Bun.file(join(f.brain, "own-heartbeat")).size).toBe(ownBytes);
    expect(Bun.file(join(neighborBrain, "neighbor-heartbeat")).size, "SCOPE_UNRELATED_NAMESPACE_STAYS_RUNNING").toBeGreaterThan(neighborBytes);
    expect(f.scope.decide(f.message("stop"), true).state, "SCOPE_UNRELATED_WORKER_STOP_ACKNOWLEDGED").toBe("accepted"); await own.exited;
  } finally { own?.kill("SIGKILL"); neighbor?.kill("SIGKILL"); if (own) await own.exited; if (neighbor) await neighbor.exited; f.close(); rmSync(neighborBrain, { recursive: true, force: true }); }
});

test("failed freeze or resume stops the real worker, retains work and exposes an ended readback without a second effect", async () => {
  for (const failure of ["freeze", "resume"] as const) {
    const f = scopeFixture({ max_tool_calls: 1 }); let child: ReturnType<typeof f.worker> | undefined;
    try {
      f.begin(); child = f.worker('printf Ithaca > partial-note; while :; do sleep 1; done');
      await wait(() => Bun.file(join(f.brain, "partial-note")).size > 0);
      if (failure === "freeze") child.freeze = () => { throw Error("Freeze could not be confirmed"); };
      f.scope.toolCall("voyage", "loom");
      if (failure === "resume") {
        child.resume = () => { throw Error("Resume failed"); };
        const message = f.message("continue"); expect(f.scope.decide(message, true).state).toBe("failed");
        expect(f.scope.decide({ ...message, action: "readback" }, true).state, "SCOPE_FAILED_RESUME_ENDED_READBACK").toBe("ended_before_answer");
        expect(f.receipt().state).toBe("ended_before_answer");
      } else {
        expect(f.receipt()).toMatchObject({ state: "stopped", frozen: false }); expect(f.receipt().newCap).toBeUndefined();
        expect(f.db.query("SELECT count(*) AS n FROM governance_events WHERE kind='scope_cap'").get()).toEqual({ n: 1 });
      }
      await child.exited; expect(await Bun.file(join(f.brain, "partial-note")).text()).toBe("Ithaca");
    } finally { child?.kill("SIGKILL"); if (child) await child.exited; f.close(); }
  }
});


test("periodic capture resumes a productive worker and snapshot failure terminates its held worker", async () => {
  for (const failCapture of [false, true]) {
    const f = scopeFixture(); let child: ReturnType<typeof f.worker> | undefined;
    try {
      f.begin(); child = f.worker('while :; do printf x >> heartbeat; sleep 0.02; done');
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
        expect(f.stopped).toContain("journal");
        expect(f.journal.summary("voyage").state).toBe("partial");
      } else {
        expect(captureWitness!.after, "SCOPE_PERIODIC_CAPTURE_STOPS_PRODUCTIVE_WORKER").toBe(captureWitness!.before);
        const before = Bun.file(join(f.brain, "heartbeat")).size;
        await wait(() => Bun.file(join(f.brain, "heartbeat")).size > before);
        expect(resumes, "SCOPE_PRODUCTIVE_OBSERVATION_RESUMES_ONLY_TEMPORARY_HOLD").toBe(1);
        expect(f.journal.summary("voyage").scope!.receipts).toEqual([]);
      }
    } finally { child?.kill("SIGKILL"); if (child) await child.exited; chmodSync(join(f.root, "objects"), 0o700); f.close(); }
  }
}, 45_000);

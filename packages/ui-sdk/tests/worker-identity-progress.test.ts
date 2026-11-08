// #3664: a separate-UID readiness timeout names the supervisor's last recorded setup step.
import { expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { launchAgentWorker, launchAgentWorkerAsync } from "../src/server/worker-launcher";
import * as identity from "../src/server/worker-identity";
import { runWorkerStepsAsync } from "../src/server/worker-steps";
import { createFixtureWorkerStartupView } from "./helpers/worker-startup-view-fixture.js";
import { identityControl } from "./helpers/identity-control-fixture.js";

const ROOT = resolve(import.meta.dir, "../../..");
const IDENTITY_HELPER = "/usr/lib/odysseus/identity-helper";
type Broker = ReturnType<typeof identity.prepareWorkerIdentity>;

function fixture() {
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  const root = mkdtempSync(join(ROOT, "tmp/identity-progress-"));
  const brain = join(root, "brain");
  mkdirSync(join(brain, "notes"), { recursive: true });
  return { root, brain, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const readyPath = (broker: Broker) => (JSON.parse(broker.command.at(-1)!) as { ready: string }).ready;

/**
 * `prepareWorkerIdentity` at the launcher's seam, with its real `readySteps`:
 * the supervisor never publishes `ready`, so the launch reaches its own
 * deadline. `progress` is the record the supervisor would have left. The close
 * runs the real control client against a stand-in socket.
 */
function timeoutSeam(progress?: object) {
  const prepare = identity.prepareWorkerIdentity;
  const controls: ReturnType<typeof identityControl>[] = [], brokers: Broker[] = [];
  const spy = spyOn(identity, "prepareWorkerIdentity").mockImplementation((...args: Parameters<typeof prepare>) => {
    const real = prepare(...args);
    brokers.push(real);
    controls.push(identityControl(real, { delayMs: 50 }));
    if (progress) writeFileSync(`${readyPath(real)}.progress`, JSON.stringify(progress), { mode: 0o600 });
    return { ...real, command: ["/bin/sh", "-c", "exec sleep 30"] };
  });
  return {
    operations: () => controls.map(control => control.operations()),
    released: () => brokers.map(broker => existsSync(dirname(readyPath(broker)))),
    restore: async () => { spy.mockRestore(); for (const control of controls) await control.stop(); for (const broker of brokers) broker.discard(); },
  };
}

async function timedOutLaunch(progress: object | undefined, form: "async" | "sync") {
  const f = fixture(), view = createFixtureWorkerStartupView(f.brain);
  const helper = spyOn(identity, "workerIdentityHelper").mockReturnValue(IDENTITY_HELPER);
  const seam = timeoutSeam(progress);
  try {
    const input = { brainPath: f.brain, startupView: view, command: ["/bin/true"], env: {} };
    const started = Date.now();
    const work = form === "async" ? launchAgentWorkerAsync(input) : Promise.resolve().then(() => launchAgentWorker(input));
    const refusal = await work.then(() => new Error("launch_succeeded"), (error: unknown) => error) as Error & { requirement?: string; errorClass?: string };
    return { refusal, elapsed: Date.now() - started, operations: seam.operations(), released: seam.released() };
  } finally { await seam.restore(); helper.mockRestore(); view.cleanup(); f.cleanup(); }
}

test("a readiness timeout names the supervisor's last recorded step, keeps its class and still closes the broker", async () => {
  const { refusal, elapsed, operations, released } = await timedOutLaunch({ step: "launch-sent", ms: 312, wallMs: Date.now() + 40 }, "async");
  expect(refusal.name, "TIMEOUT_REFUSES_AS_WORKER_HOST_ERROR").toBe("WorkerHostError");
  expect(refusal.errorClass).toBe("worker_host_unsupported");
  expect(refusal.requirement, "TIMEOUT_REQUIREMENT_NAMES_RECORDED_STEP")
    .toMatch(/^worker_identity_setup_timed_out \(step: launch-sent, ms: 312, sinceSpawnMs: -?\d+\)$/);
  expect(refusal.message).toStartWith("Agent worker boundary unavailable: worker_identity_setup_timed_out (step: launch-sent, ms: 312, ");
  // The unchanged deadline and the unchanged confirmed close.
  expect(elapsed).toBeGreaterThanOrEqual(5_000);
  expect(operations, "TIMEOUT_STILL_CLOSES_BROKER").toEqual([["close", "close:answered"]]);
  expect(released, "CONFIRMED_CLOSE_STILL_RELEASES_BROKER").toEqual([false]);
}, 30_000);

test("a readiness timeout with no progress record says step: none", async () => {
  const { refusal, operations } = await timedOutLaunch(undefined, "sync");
  expect(refusal.errorClass).toBe("worker_host_unsupported");
  expect(refusal.requirement, "MISSING_RECORD_READS_AS_NONE").toBe("worker_identity_setup_timed_out (step: none)");
  expect(operations).toEqual([["close", "close:answered"]]);
}, 30_000);

test("the progress read refuses an oversized, linked, non-regular or malformed record without reading through it", () => {
  const broker = identity.prepareWorkerIdentity(IDENTITY_HELPER, ["/bin/true"], []);
  const outside = mkdtempSync(join(ROOT, "tmp/identity-progress-outside-"));
  try {
    const record = `${readyPath(broker)}.progress`, spawnedAt = Date.now();
    const valid = JSON.stringify({ step: "mounts-acked", ms: 20, wallMs: spawnedAt + 25 });
    writeFileSync(record, valid);
    expect(broker.setupProgress(spawnedAt)).toBe("step: mounts-acked, ms: 20, sinceSpawnMs: 25");
    writeFileSync(record, JSON.stringify({ step: "launch-sent", ms: 1, wallMs: spawnedAt, pad: "x".repeat(100) }));
    expect(broker.setupProgress(spawnedAt), "OVERSIZED_RECORD_REFUSED").toBe("step: refused (oversized)");
    rmSync(record);
    // A link to a well-formed record elsewhere is refused, not followed.
    const target = join(outside, "progress");
    writeFileSync(target, valid);
    symlinkSync(target, record);
    expect(broker.setupProgress(spawnedAt), "LINKED_RECORD_REFUSED").toBe("step: refused (symlink)");
    rmSync(record);
    mkdirSync(record);
    expect(broker.setupProgress(spawnedAt), "DIRECTORY_RECORD_REFUSED").toBe("step: refused (not a regular file)");
    rmSync(record, { recursive: true });
    if (Bun.spawnSync(["mkfifo", record]).exitCode === 0) {
      // A FIFO with no writer neither blocks the read nor counts as a record.
      expect(broker.setupProgress(spawnedAt), "FIFO_RECORD_REFUSED").toBe("step: refused (not a regular file)");
      rmSync(record);
    }
    for (const body of ["{", JSON.stringify({ step: "bwrap-exec", ms: 1, wallMs: spawnedAt }), JSON.stringify({ step: "started", ms: -1, wallMs: spawnedAt }), "null"]) {
      writeFileSync(record, body);
      expect(broker.setupProgress(spawnedAt), `MALFORMED_RECORD_REFUSED ${body}`).toBe("step: refused (malformed)");
    }
  } finally { broker.discard(); rmSync(outside, { recursive: true, force: true }); }
});

test("the real supervisor records each setup step it reaches: a helper that never acknowledges launch leaves launch-sent", async () => {
  const work = mkdtempSync(join(ROOT, "tmp/identity-progress-supervisor-"));
  const pidFile = join(work, "helper.pid"), helper = join(work, "never-acknowledges");
  // Stands in for the root helper: it starts its `launch` operation and never answers it.
  writeFileSync(helper, `#!/bin/sh\necho $$ > ${pidFile}\nexec /bin/sleep 20\n`);
  chmodSync(helper, 0o700);
  const bwrap = "/usr/lib/odysseus/bwrap";
  const broker = identity.prepareWorkerIdentity(helper, [bwrap, "--", "/bin/true"], []);
  const command = broker.command.slice(0, -1);
  const config = { ...JSON.parse(broker.command.at(-1)!) as object, bwrap };
  const spawnedAt = Date.now();
  const supervisor = Bun.spawn([...command, JSON.stringify(config)], { env: {}, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  try {
    const record = `${readyPath(broker)}.progress`;
    const deadline = Date.now() + 10_000;
    while (!broker.setupProgress(spawnedAt).startsWith("step: launch-sent")) {
      if (supervisor.exitCode !== null || Date.now() >= deadline)
        throw new Error(`supervisor never recorded launch-sent: ${broker.setupProgress(spawnedAt)}`);
      await Bun.sleep(5);
    }
    // The host's real wait reaches its own deadline and reads the same record.
    const refusal = await runWorkerStepsAsync(broker.readySteps(supervisor.pid, Date.now() + 200)).then(() => undefined, (error: Error) => error.message);
    expect(refusal).toBe("worker_identity_setup_timed_out");
    expect(broker.setupProgress(spawnedAt), "REAL_SUPERVISOR_RECORDS_LAUNCH_SENT").toMatch(/^step: launch-sent, ms: \d+, sinceSpawnMs: \d+$/);
    // A private record in the server's private directory: no new path for anyone else.
    const info = statSync(record), directory = statSync(dirname(record));
    expect({ mode: info.mode & 0o777, uid: info.uid, size: info.size <= 128, directory: directory.mode & 0o777 })
      .toEqual({ mode: 0o600, uid: process.getuid!(), size: true, directory: 0o700 });
    expect(existsSync(`${record}.tmp`), "NO_TEMPORARY_RECORD_REMAINS").toBe(false);
  } finally {
    supervisor.kill("SIGKILL"); await supervisor.exited;
    try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* It may never have started, or already ended. */ }
    broker.discard(); rmSync(work, { recursive: true, force: true });
  }
}, 30_000);

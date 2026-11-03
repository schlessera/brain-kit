import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchAgentWorker, prepareWorkerSandbox } from "../src/server/worker-launcher.js";
import { createWorkerStatusPipe, type WorkerStatusSupervisor } from "../src/server/worker-status.js";

// bubblewrap's --block-fd starts the sandbox on its gate's EOF as on a byte, so
// a refused launch must not close the gate while a gated process lives
// (#3387). Each case delays every kill, of bubblewrap and, for longer, of any
// process signalled by PID, standing in for processes the scheduler has not
// yet let die. Only a gate that waits for their deaths keeps the payload out.
// The live launch now gates in the sandbox and refuses EOF itself (#3392); the
// fixtures below keep bubblewrap's EOF-opening --block-fd on purpose, so they
// prove this ordering as a guard of its own.
const SIGNAL_DELAY_MS = 200;
const PID_SIGNAL_DELAY_MS = 2 * SIGNAL_DELAY_MS;

const roots: string[] = [];
let processKill: ReturnType<typeof spyOn<typeof process, "kill">> | undefined;
beforeEach(() => {
  const kill = process.kill.bind(process);
  processKill = spyOn(process, "kill").mockImplementation((pid: number, signal?: NodeJS.Signals | number) => {
    if (signal !== "SIGKILL" && signal !== 9) return kill(pid, signal);
    setTimeout(() => { try { kill(pid, signal); } catch { /* gone meanwhile */ } }, PID_SIGNAL_DELAY_MS);
    return true;
  });
});
afterEach(() => {
  processKill?.mockRestore(); processKill = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function delayedKills<T extends { kill(signal?: NodeJS.Signals | number): void }>(child: T): T {
  const kill = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number) => {
    if (signal === "SIGSTOP") kill(signal);
    else setTimeout(() => kill(signal), SIGNAL_DELAY_MS);
  };
  return child;
}

test("a refused governed launch never starts its payload when bubblewrap dies late", async () => {
  const brain = mkdtempSync(join(tmpdir(), "refused-gate-")); roots.push(brain);
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  writeFileSync(join(brain, "context/policies/governance.md"), "Athena sets the policy.\n");
  mkdirSync(join(brain, "group/private"), { recursive: true });
  const sandbox = prepareWorkerSandbox(brain, { profile: "governed", areas: [], folderPaths: ["group/private"] });
  expect(sandbox.profile, sandbox.fallbackReason).toBe("governed");
  const spawn = Bun.spawn;
  let supervisor: ReturnType<typeof Bun.spawn> | undefined;
  const hook = spyOn(Bun, "spawn").mockImplementation((...args: any[]) => {
    const launch = !supervisor && args[1]?.env?.BRAIN_WORKER_LAUNCH;
    if (launch) {
      // Swap the qualified folder after planning, so the launch is refused after
      // its mounts exist and its gated sandbox process is waiting.
      renameSync(join(brain, "group"), join(brain, "retired-group"));
      mkdirSync(join(brain, "group/private"), { recursive: true });
    }
    const child = (spawn as any)(...args);
    if (launch) supervisor = delayedKills(child);
    return child;
  });
  let refusal: unknown;
  try {
    launchAgentWorker({ brainPath: brain, sandbox, env: {}, stateBytes: 1024 * 1024,
      populateState: () => {
        renameSync(join(brain, "group"), join(brain, "replacement-group"));
        renameSync(join(brain, "retired-group"), join(brain, "group"));
      },
      command: ["/bin/sh", "-c", "printf Odysseus > payload-started.md"] });
  } catch (error) { refusal = error; } finally { hook.mockRestore(); }
  expect(supervisor, "the launch spawned bubblewrap").toBeDefined();
  await supervisor!.exited;
  // The gate closes only after the supervisor's exit; give a released payload time to write.
  await Bun.sleep(3 * PID_SIGNAL_DELAY_MS);
  expect(String(refusal)).toContain("retained folder mount points are unavailable");
  expect(existsSync(join(brain, "payload-started.md")), "UNQUALIFIED_FOLDER_PAYLOAD_NEVER_STARTS").toBe(false);
}, 20_000);

test("closing an unreleased gate kills a sandbox whose status was never read", async () => {
  const root = mkdtempSync(join(tmpdir(), "refused-gate-")); roots.push(root);
  const marker = join(root, "payload-started.md");
  const channel = createWorkerStatusPipe();
  // No --die-with-parent: only the refusal itself can kill the gated sandbox.
  const child = Bun.spawn(["/bin/sh", "-c", 'exec 3>"$1"; exec 4<"$2"; shift 2; exec "$@"', "refused-gate-fixture", channel.source, channel.gateSource,
    Bun.which("bwrap")!, "--json-status-fd", "3", "--block-fd", "4", "--unshare-user", "--unshare-pid",
    "--bind", "/", "/", "--proc", "/proc", "--", "/bin/sh", "-c", 'printf Odysseus > "$0"', marker],
  { env: {}, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const supervisor: WorkerStatusSupervisor = delayedKills(child);
  try {
    // Wait until bubblewrap has forked its gated sandbox process.
    const deadline = Date.now() + 5_000;
    const children = () => { try { return readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim(); } catch { return ""; } };
    while (!children() && child.exitCode === null && Date.now() < deadline) await Bun.sleep(5);
    expect(children(), "bubblewrap forked its sandbox").not.toBe("");
    channel.close(supervisor);
    await child.exited;
    await Bun.sleep(3 * PID_SIGNAL_DELAY_MS);
    expect(existsSync(marker), "REFUSED_GATE_PAYLOAD_NEVER_STARTS").toBe(false);
  } finally { child.kill("SIGKILL"); await child.exited; }
}, 20_000);

test("closing an unreleased gate kills a verified sandbox that outlived its reaped bubblewrap", async () => {
  const root = mkdtempSync(join(tmpdir(), "refused-gate-")); roots.push(root);
  const marker = join(root, "payload-started.md");
  const channel = createWorkerStatusPipe();
  // Even with --die-with-parent, bubblewrap's gated child outlives a killed
  // bubblewrap; the gate is then all that holds it.
  const child = Bun.spawn(["/bin/sh", "-c", 'exec 3>"$1"; exec 4<"$2"; shift 2; exec "$@"', "refused-gate-fixture", channel.source, channel.gateSource,
    Bun.which("bwrap")!, "--json-status-fd", "3", "--block-fd", "4", "--unshare-user", "--unshare-pid", "--die-with-parent",
    "--bind", "/", "/", "--proc", "/proc", "--", "/bin/sh", "-c", 'printf Odysseus > "$0"', marker],
  { env: {}, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  let gated: number | undefined;
  try {
    gated = channel.childPid(child.pid, Date.now() + 5_000);
    channel.closeWriter();
    child.kill("SIGKILL");
    await child.exited;
    expect(child.signalCode, "bubblewrap was reaped").toBe("SIGKILL");
    channel.close(child);
    await Bun.sleep(3 * PID_SIGNAL_DELAY_MS);
    expect(existsSync(marker), "ORPHANED_GATED_PAYLOAD_NEVER_STARTS").toBe(false);
  } finally {
    processKill?.mockRestore();
    if (gated !== undefined) try { process.kill(gated, "SIGKILL"); } catch { /* already gone */ }
  }
}, 20_000);

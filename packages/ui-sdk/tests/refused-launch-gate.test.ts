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
// prove this ordering as a guard of its own. The delays are real time: they
// stand in for scheduler latency before a native process dies, which a fake
// clock cannot hold back.
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

/** `/proc/<pid>/stat` after the command name: [state, ppid, ..., starttime at 19]. */
function stat(pid: number): string[] | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" "); } catch { return undefined; }
}
/** A process by PID and kernel start time, so a recycled PID never matches. */
function identity(pid: number) { return { pid, start: stat(pid)?.[19] }; }
const childrenOf = (pid: number) => { try { return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim(); } catch { return ""; } };
/**
 * Resolves once none of these gated sandbox processes can run code: gone,
 * recycled or a zombie. Each is its PID namespace's first process, so its
 * death ends every process that could start the payload, and a payload the
 * gate released has written its marker by then.
 */
async function sandboxesDead(gated: { pid: number; start: string | undefined }[]) {
  const deadline = Date.now() + 10_000;
  const running = ({ pid, start }: { pid: number; start: string | undefined }) => {
    const fields = stat(pid);
    return fields !== undefined && fields[19] === start && !["Z", "X", "x"].includes(fields[0]!);
  };
  while (gated.some(running)) {
    if (Date.now() >= deadline) throw Error(`GATED_SANDBOX_NEVER_DIED ${JSON.stringify(gated.filter(running))}`);
    await Bun.sleep(5);
  }
}

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
  // The refusal stopped bubblewrap; its kill is still delayed, so it has not reaped its sandbox.
  const gated = childrenOf(supervisor!.pid).split(/\s+/).filter(Boolean).map(pid => identity(Number(pid)));
  expect(gated, "bubblewrap forked its sandbox").not.toEqual([]);
  await supervisor!.exited;
  // The gate closes only after the supervisor's exit, and a released payload runs before its sandbox dies.
  await sandboxesDead(gated);
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
    const children = () => childrenOf(child.pid);
    while (!children() && child.exitCode === null && Date.now() < deadline) await Bun.sleep(5);
    expect(children(), "bubblewrap forked its sandbox").not.toBe("");
    const gated = children().split(/\s+/).map(pid => identity(Number(pid)));
    channel.close(supervisor);
    await child.exited;
    await sandboxesDead(gated);
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
    const sandbox = identity(gated);
    channel.closeWriter();
    child.kill("SIGKILL");
    await child.exited;
    expect(child.signalCode, "bubblewrap was reaped").toBe("SIGKILL");
    channel.close(child);
    await sandboxesDead([sandbox]);
    expect(existsSync(marker), "ORPHANED_GATED_PAYLOAD_NEVER_STARTS").toBe(false);
  } finally {
    processKill?.mockRestore();
    if (gated !== undefined) try { process.kill(gated, "SIGKILL"); } catch { /* already gone */ }
  }
}, 20_000);

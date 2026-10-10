import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { BackendRequestError } from "./backend.js";
import { createWorkerPipes } from "./worker-pipes.js";

/** Concrete first-party worker boundary; not an optional exec wrapper. */
export const WORKER_SCRATCH = "/tmp/brain-worker-scratch";
export const WORKER_HOST_ROUTE = "Use a verified Linux or qualifying WSL2 host with bubblewrap and unprivileged user namespaces.";

export interface WorkerLaunch {
  brainPath: string;
  /** Mount location only; always a fresh tmpfs, never host-backed writable storage. */
  scratchPath?: string;
  /** Absolute executable and literal arguments. No shell is inserted. */
  command: readonly string[];
  /** The complete worker environment; nothing is inherited by default. */
  env: Readonly<Record<string, string>>;
}

export class WorkerHostError extends BackendRequestError {
  readonly errorClass = "worker_host_unsupported";
  constructor(requirement: string) {
    super(`Agent worker boundary unavailable: ${requirement}. ${WORKER_HOST_ROUTE}`);
    this.name = "WorkerHostError";
  }
}

/** The only argv builder used by both live workers and the actual host probe. */
export function workerCommand(input: WorkerLaunch): string[] {
  if (process.platform !== "linux") throw new WorkerHostError("Linux namespaces are required");
  const bwrap = Bun.which("bwrap");
  if (!bwrap) throw new WorkerHostError("bubblewrap is missing");
  if (!isAbsolute(input.brainPath) || !input.command[0] || !isAbsolute(input.command[0])) {
    throw new WorkerHostError("an absolute brain path and worker executable are required");
  }
  const brain = realpathSync(input.brainPath);
  const scratch = input.scratchPath ? realpathSync(normalize(input.scratchPath)) : WORKER_SCRATCH;
  if (!isAbsolute(scratch) || scratch === brain || scratch.startsWith(`${brain}/`)
    || brain.startsWith(`${scratch}/`) || scratch === "/" || brain === "/" || brain === "/tmp") {
    throw new WorkerHostError("scratch must be a separate location outside the authoritative brain and its ancestors");
  }
  const argv = [bwrap, "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/", "/",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", brain, brain,
    "--tmpfs", scratch, "--clearenv"];
  for (const [key, value] of Object.entries(input.env)) argv.push("--setenv", key, value);
  argv.push("--setenv", "BRAIN_WORKER_SCRATCH", scratch,
    "--chdir", brain, "--", ...input.command);
  return argv;
}

/** Private trusted bootstrap. It validates/clears descriptors before exec. */
export function workerBootstrap(input: WorkerLaunch): { command: string[]; env: Record<string, string> } {
  // Resolve using this package's source/build output, never the brain's module resolver.
  const entry = Bun.resolveSync("./worker-entry", import.meta.dir);
  return { command: [process.execPath, entry], env: {
    BRAIN_WORKER_LAUNCH: JSON.stringify({ ...input, argv: workerCommand(input) }),
  } };
}

/** All three protocol channels are new pipes. No stdio/extra-fd override exists. */
export function launchAgentWorker(input: WorkerLaunch) {
  const boot = workerBootstrap(input);
  const pipes = createWorkerPipes();
  try {
    const child = Bun.spawn(boot.command, { env: boot.env,
      stdin: pipes.child[0], stdout: pipes.child[1], stderr: pipes.child[2] });
    pipes.closeChild();
    const streams = pipes.streams();
    return { ...streams, pid: child.pid, exited: child.exited, kill: (signal?: NodeJS.Signals) => child.kill(signal) };
  } catch (error) { pipes.cleanup(); throw error; }
}

export type WorkerHostProbe = { ok: true } | { ok: false; requirement: string };

/** Runs the real launcher before each turn; a version/OS check is insufficient. */
export function probeWorkerHost(brainPath: string): WorkerHostProbe {
  let fixture: string | undefined;
  try {
    if (process.platform !== "linux") throw new Error("Linux namespaces are required");
    brainPath = realpathSync(brainPath);
    // The host owns this disposable sentinel on the configured brain filesystem.
    // Even a broken launcher can only change these newly minted fixture bytes.
    fixture = mkdtempSync(join(brainPath, ".worker-host-probe-"));
    const target = join(fixture, "sentinel");
    const golden = "Odysseus: authoritative bytes.\n";
    writeFileSync(target, golden);
    const program = `import {writeFileSync,readFileSync} from "node:fs";
      let denied=false; try {writeFileSync(${JSON.stringify(target)},"changed")} catch {denied=true}
      const scratch=process.env.BRAIN_WORKER_SCRATCH+"/positive";
      writeFileSync(scratch,"Odysseus: scratch works.");
      if(!denied || readFileSync(scratch,"utf8")!=="Odysseus: scratch works.") process.exit(1);
      console.log("worker-boundary-pass");`;
    const boot = workerBootstrap({ brainPath, command: [process.execPath, "-e", program], env: {} });
    const pipes = createWorkerPipes();
    try {
      const child = Bun.spawnSync(boot.command, { env: boot.env, stdin: pipes.child[0],
        stdout: pipes.child[1], stderr: pipes.child[2], timeout: 5_000 });
      pipes.closeChild(); pipes.closeInput();
      const output = readFileSync(pipes.parent[1], "utf8");
      const errors = readFileSync(pipes.parent[2], "utf8");
      if (child.exitCode !== 0 || output.trim() !== "worker-boundary-pass" || readFileSync(target, "utf8") !== golden) {
        throw new Error(`bubblewrap namespaces, read-only brain, writable scratch or pipe/descriptor validation failed (${errors.trim().slice(0, 400)})`);
      }
    } finally { pipes.cleanup(); }
    return { ok: true };
  } catch (error) {
    return { ok: false, requirement: error instanceof Error ? error.message : String(error) };
  } finally {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
  }
}

/** Concrete probe object permits test spies, with no production disable flag. */
export const workerHostBoundary = { probe: probeWorkerHost };
export function requireWorkerHost(brainPath: string): void {
  let result: WorkerHostProbe;
  try {
    result = workerHostBoundary.probe(brainPath);
  } catch (error) {
    if (error instanceof WorkerHostError) throw error;
    throw new WorkerHostError(error instanceof Error ? error.message : String(error));
  }
  if (!result.ok) throw new WorkerHostError(result.requirement);
}

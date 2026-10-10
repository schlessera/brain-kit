import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { BackendRequestError } from "./backend.js";
import { createWorkerPipes } from "./worker-pipes.js";
import { WORKER_INFERENCE_DIR } from "./inference-relay.js";

/** Concrete first-party worker boundary; not an optional exec wrapper. */
export const WORKER_SCRATCH = "/tmp/brain-worker-scratch";
export const WORKER_HOST_ROUTE = "Use a verified Linux or qualifying WSL2 host with bubblewrap and unprivileged user namespaces.";

export interface WorkerLaunch {
  brainPath: string;
  /** Mount location only; always a fresh tmpfs, never host-backed writable storage. */
  scratchPath?: string;
  /** Fresh runtime state on a separate tmpfs device; never a brain inode alias. */
  statePath?: string;
  /** Absolute executable and literal arguments. No shell is inserted. */
  command: readonly string[];
  /** The complete worker environment; nothing is inherited by default. */
  env: Readonly<Record<string, string>>;
  /**
   * The restricted envelope for untrusted (autonomous) execution (#676): a
   * private network namespace with only loopback, and an explicit read
   * envelope instead of the host root. Absent for interactive and voice turns.
   */
  restricted?: RestrictedEnvelope;
}

export interface RestrictedEnvelope {
  /** Host files and directories mounted read-only at their own paths. Nothing else from the host is. */
  readPaths: readonly string[];
  /** Private host directory holding the server-owned inference relay socket. */
  inferenceDir: string;
}

/**
 * The minimal system view of the restricted envelope: binaries, libraries and
 * the dynamic-linker and name-service files they need. No home, run, var,
 * mount or device directory of the host, and no other `/etc` file.
 */
const SYSTEM_DIRECTORIES = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];
const SYSTEM_ETC = ["ld.so.cache", "ld.so.conf", "ld.so.conf.d", "alternatives", "passwd", "group",
  "nsswitch.conf", "hosts", "localtime", "os-release"];

function restrictedMounts(envelope: RestrictedEnvelope, brain: string): string[] {
  const argv: string[] = [];
  for (const path of SYSTEM_DIRECTORIES) {
    if (!existsSync(path)) continue;
    const info = lstatSync(path);
    if (info.isSymbolicLink()) argv.push("--symlink", readlinkSync(path), path);
    else if (info.isDirectory()) argv.push("--ro-bind", path, path);
  }
  for (const name of SYSTEM_ETC) {
    const path = `/etc/${name}`;
    if (existsSync(path)) argv.push("--ro-bind", realpathSync(path), path);
  }
  const seen = new Set<string>();
  for (const requested of envelope.readPaths) {
    if (!isAbsolute(requested)) throw new WorkerHostError("restricted read paths must be absolute");
    const path = realpathSync(requested);
    // The read envelope is explicit. The host root, a home or a whole system
    // tree would make it the old read-only host view under another name.
    if (path === "/" || path === "/tmp" || path === "/home" || path === "/etc" || path === "/run" || path === "/var" || path === "/proc"
      || brain === path || brain.startsWith(`${path}/`)) {
      throw new WorkerHostError(`restricted read path ${path} is broader than an explicit envelope`);
    }
    if (seen.has(path)) continue;
    seen.add(path);
    argv.push("--ro-bind", path, path);
  }
  const inference = realpathSync(envelope.inferenceDir);
  if (!lstatSync(inference).isDirectory() || (statSync(inference).mode & 0o077) !== 0) {
    throw new WorkerHostError("the inference relay directory must be a private directory");
  }
  argv.push("--ro-bind", inference, WORKER_INFERENCE_DIR);
  return argv;
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
  let state: string | undefined;
  if (input.statePath) {
    state = realpathSync(input.statePath);
    if (state !== input.statePath || lstatSync(state).isSymbolicLink() || !lstatSync(state).isDirectory()
      || state === brain || state.startsWith(`${brain}/`) || brain.startsWith(`${state}/`)
      || state === scratch || state.startsWith(`${scratch}/`) || scratch.startsWith(`${state}/`)
      || statSync(state).dev === statSync(brain).dev || statfsSync(state).type !== 0x01021994) {
      throw new WorkerHostError("runtime state must be a separate, non-aliasing tmpfs directory outside the brain and scratch");
    }
  }
  const argv = [bwrap, "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    ...(input.restricted ? ["--unshare-net"] : []),
    "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    // The restricted envelope starts from an empty root; others see the host read-only.
    ...(input.restricted ? [] : ["--ro-bind", "/", "/"]),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ...(input.restricted ? restrictedMounts(input.restricted, brain) : []),
    "--ro-bind", brain, brain,
    "--tmpfs", scratch, "--clearenv"];
  if (state) argv.push("--bind", state, state);
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

export interface WorkerHostProbeOptions {
  /** Also establish the restricted envelope: a private network namespace and an explicit read envelope. */
  restricted?: boolean;
}

/** Runs the real launcher before each turn; a version/OS check is insufficient. */
export function probeWorkerHost(brainPath: string, options: WorkerHostProbeOptions = {}): WorkerHostProbe {
  let fixture: string | undefined;
  let relayDir: string | undefined;
  try {
    if (process.platform !== "linux") throw new Error("Linux namespaces are required");
    brainPath = realpathSync(brainPath);
    // The host owns this disposable sentinel on the configured brain filesystem.
    // Even a broken launcher can only change these newly minted fixture bytes.
    fixture = mkdtempSync(join(brainPath, ".worker-host-probe-"));
    const target = join(fixture, "sentinel");
    const golden = "Odysseus: authoritative bytes.\n";
    writeFileSync(target, golden);
    let restricted: RestrictedEnvelope | undefined;
    if (options.restricted) {
      relayDir = mkdtempSync(join(tmpdir(), "brain-inference-probe-"));
      chmodSync(relayDir, 0o700);
      restricted = { readPaths: [process.execPath], inferenceDir: relayDir };
    }
    const program = `import {writeFileSync,readFileSync,existsSync} from "node:fs";
      let denied=false; try {writeFileSync(${JSON.stringify(target)},"changed")} catch {denied=true}
      const scratch=process.env.BRAIN_WORKER_SCRATCH+"/positive";
      writeFileSync(scratch,"Odysseus: scratch works.");
      if(!denied || readFileSync(scratch,"utf8")!=="Odysseus: scratch works.") process.exit(1);
      ${options.restricted ? `const links=readFileSync("/proc/net/dev","utf8").split("\\n").slice(2).map(l=>l.split(":")[0].trim()).filter(Boolean);
      if(links.join()!=="lo") process.exit(2);
      if(!existsSync(${JSON.stringify(WORKER_INFERENCE_DIR)})) process.exit(4);` : ""}
      console.log("worker-boundary-pass");`;
    const boot = workerBootstrap({ brainPath, command: [process.execPath, "-e", program], env: {}, restricted });
    const pipes = createWorkerPipes();
    try {
      const child = Bun.spawnSync(boot.command, { env: boot.env, stdin: pipes.child[0],
        stdout: pipes.child[1], stderr: pipes.child[2], timeout: 5_000 });
      pipes.closeChild(); pipes.closeInput();
      const output = readFileSync(pipes.parent[1], "utf8");
      const errors = readFileSync(pipes.parent[2], "utf8");
      if (child.exitCode !== 0 || output.trim() !== "worker-boundary-pass" || readFileSync(target, "utf8") !== golden) {
        const what = child.exitCode === 2 ? "a private network namespace with only loopback"
          : child.exitCode === 4 ? "the inference relay mount"
          : "bubblewrap namespaces, read-only brain, writable scratch or pipe/descriptor validation";
        throw new Error(`${what} failed (${errors.trim().slice(0, 400)})`);
      }
    } finally { pipes.cleanup(); }
    return { ok: true };
  } catch (error) {
    return { ok: false, requirement: error instanceof Error ? error.message : String(error) };
  } finally {
    if (fixture) rmSync(fixture, { recursive: true, force: true });
    if (relayDir) rmSync(relayDir, { recursive: true, force: true });
  }
}

/** Concrete probe object permits test spies, with no production disable flag. */
export const workerHostBoundary = { probe: probeWorkerHost };
export function requireWorkerHost(brainPath: string, options: WorkerHostProbeOptions = {}): void {
  let result: WorkerHostProbe;
  try {
    result = workerHostBoundary.probe(brainPath, options);
  } catch (error) {
    if (error instanceof WorkerHostError) throw error;
    throw new WorkerHostError(error instanceof Error ? error.message : String(error));
  }
  if (!result.ok) throw new WorkerHostError(result.requirement);
}

/**
 * The read envelope a restricted worker needs to run code that lives in
 * installed packages: the Bun runtime, every `node_modules` directory on each
 * entry's ancestor chain, the targets of linked workspace packages in them,
 * and each entry's own package. No sibling file of an install root (for
 * example an `.env` beside `node_modules`) and no home directory is included.
 */
export function restrictedReadPaths(entries: readonly string[]): string[] {
  const paths = new Set<string>([realpathSync(process.execPath)]);
  for (const entry of entries) {
    const real = realpathSync(entry);
    let dir = dirname(real);
    let owner: string | undefined;
    for (;;) {
      if (!owner && existsSync(join(dir, "package.json"))) owner = dir;
      const modules = join(dir, "node_modules");
      if (existsSync(modules) && lstatSync(modules).isDirectory()) {
        paths.add(realpathSync(modules));
        for (const name of readdirSync(modules)) {
          const entries = name.startsWith("@") && lstatSync(join(modules, name)).isDirectory()
            ? readdirSync(join(modules, name)).map(child => join(modules, name, child)) : [join(modules, name)];
          for (const path of entries) if (lstatSync(path).isSymbolicLink() && existsSync(path)) paths.add(realpathSync(path));
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    paths.add(owner ?? real);
  }
  return [...paths];
}

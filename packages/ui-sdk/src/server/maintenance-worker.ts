/**
 * Maintenance workers (#1648): the server's own work on a brain that a
 * `governed` turn may have written. Indexing, application planning, every
 * server-spawned `brain` command and every git invocation evaluate files the
 * brain supplies (its config and the config's imports, a `bunfig.toml`
 * preload, an `.env`, git includes, filters and refs). Run on the host, any of
 * them would execute what an agent wrote. Run here, they execute inside the
 * same bubblewrap launcher the agent workers use, with the brain writable and
 * the host read-only, masked and unreachable
 * (docs/decisions/governed-writable-workers.md, "The host execution boundary").
 */
import { closeSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { prepareWorkerOutput } from "./worker-output.js";
import { prepareNativeWorkerOutput, type WorkerOutputStorage } from "./worker-native-output.js";
import { createWorkerPipes, fifoStream } from "./worker-pipes.js";
import { MAINTENANCE_HOME, MAINTENANCE_XDG_DIRS, workerBootstrap, WorkerHostError, type WorkerLaunch } from "./worker-launcher.js";
import { createWorkerStartupView, type WorkerStartupView } from "./worker-startup-view.js";
import { hostMaintenanceTempLimits } from "./maintenance-temp-limits.js";
import { reserveMaintenanceTemp, type MaintenanceTempDomain } from "./maintenance-temp-budget.js";
import { resolveMaintenanceTempLimits, type WorkerStateLimits } from "./worker-state-limits.js";
import { WorkerStateError } from "./worker-state-budget.js";

/** Environment names a credential-free maintenance worker keeps: plain settings, never a key or a token. */
export const CREDENTIAL_FREE_ENV = ["PATH", "BRAIN_PATH", "BRAIN_ROOT", "NODE_ENV", "TZ", "LANG", "LC_ALL", "NO_COLOR",
  "BRAIN_RERANK_MODE", "XDG_BIN_HOME", "GIT_DISCOVERY_ACROSS_FILESYSTEM"] as const;

export interface MaintenanceCommand {
  /** Trusted, resolved host limits; separate from agent turn temp and output staging. */
  tempLimits?: WorkerStateLimits;
  /** Existing host operational-state identity; absent standalone callers use their private domain. */
  tempDomain?: MaintenanceTempDomain;
  brainPath: string;
  startupView?: WorkerStartupView;
  /** Host-chosen output workspace; never mounted over the configuration view. */
  output?: { source: string; target: string; storage?: WorkerOutputStorage };
  /** A server-built Git adapter: immutable config and program inputs, writable metadata. */
  git?: { source: string; target: string; entry: string; binary: string };
  /** Absolute executable and literal arguments, run with the brain as working directory. */
  command: readonly string[];
  /** The complete environment. `PATH` gains the server's Bun directory first. */
  env: Readonly<Record<string, string | undefined>>;
  /** Credentialed: network, the server's home and the brain's `.env*`. Credential-free: none of them. */
  credentials: boolean;
  /** The host network. Defaults to `credentials`. */
  network?: boolean;
  /** The server's home, shown to a credentialed worker. */
  home?: string;
  /** More host paths the command needs below a masked directory. */
  readPaths?: readonly string[];
  /** More host directories to mask, such as the server's database directory. */
  maskPaths?: readonly string[];
  /** Existing host files the command may append to, such as a span sink. */
  writeFiles?: readonly string[];
  /** Host-selected storage only: writable object/ref directories of a private sync mirror. */
  writeDirectories?: readonly string[];
  /** Host-selected Git overrides, applied after environment filtering. Never contains credentials. */
  gitConfig?: readonly (readonly [string, string])[];
  /** Credentialed host transport; replaces the maintenance envelope and never binds the brain. */
  transport?: NonNullable<WorkerLaunch["transport"]>;
}

/** Trusted helper configuration shared by hosted startup and short Git checks. */
export interface MaintenanceHost {
  /** A host-prepared immutable input lease, acquired before a synchronous reader. */
  startupView?: WorkerStartupView;
  tempLimits?: WorkerStateLimits;
  tempDomain?: MaintenanceTempDomain;
  maskPaths?: readonly string[];
}

export interface MaintenanceResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Killed for its deadline or an abort. */
  killed: boolean;
}

/** The launch for one maintenance command: the worker sees the Bun that runs this server, and nothing else of its runtime. */
export function maintenanceLaunch(input: MaintenanceCommand): WorkerLaunch {
  const bun = realpathSync(process.execPath);
  const env: Record<string, string> = {};
  // A credential-free command gets plain settings only, whatever its caller passed.
  for (const [key, value] of Object.entries(input.env)) {
    if (value !== undefined && (input.credentials || (CREDENTIAL_FREE_ENV as readonly string[]).includes(key))) env[key] = value;
  }
  env.PATH = [dirname(bun), env.PATH].filter(Boolean).join(":");
  if (input.gitConfig) {
    env.GIT_CONFIG_COUNT = String(input.gitConfig.length);
    input.gitConfig.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
  }
  if (input.output) {
    env.BRAIN_ROOT = input.output.target;
    env.BRAIN_WORKER_DATA_ROOT = input.output.target;
    env.BRAIN_WORKER_CONFIG_ROOT = input.brainPath;
  }
  if (input.git) {
    env.BRAIN_MAINTENANCE_GIT = `${input.git.target}/config.json`;
    env.PATH = `${input.git.target}/bin:${env.PATH}`;
  }
  env.TMPDIR = "/tmp";
  Object.assign(env, MAINTENANCE_XDG_DIRS);
  if (!input.credentials) {
    // The home is masked; tools that want one get a private, empty directory.
    env.HOME = MAINTENANCE_HOME;
    // No Bun process in the worker loads an `.env`, whatever the brain links
    // it to at the moment it starts; the masks below cover the files too.
    env.BUN_OPTIONS = "--no-env-file";
  }
  const home = input.credentials && input.home ? realpathSync(input.home) : undefined;
  return {
    brainPath: input.brainPath,
    ...(input.startupView ? { startupView: input.startupView } : {}),
    command: input.command,
    env,
    ...(input.transport ? { transport: { ...input.transport,
      tempBytes: (input.tempLimits ? resolveMaintenanceTempLimits(input.tempLimits) : hostMaintenanceTempLimits()).allowanceBytes } } : { maintenance: {
      tempBytes: (input.tempLimits ? resolveMaintenanceTempLimits(input.tempLimits) : hostMaintenanceTempLimits()).allowanceBytes,
      network: input.network ?? input.credentials,
      credentials: input.credentials,
      ...(home ? { home: { path: home, overlay: false } } : {}),
      readPaths: [process.execPath, ...(input.readPaths ?? [])],
      ...(input.maskPaths ? { maskPaths: input.maskPaths } : {}),
      ...(input.writeFiles ? { writeFiles: input.writeFiles } : {}),
      ...(input.writeDirectories ? { writeDirectories: input.writeDirectories } : {}),
      ...(input.output ? { output: input.output } : {}),
      ...(input.git ? { git: input.git } : {}),
    } }),
  };
}

export interface MaintenanceWorker {
  /** Writes the command's whole input, then closes its stdin. */
  input(data: string): Promise<void>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  pid: number;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

/** Shared host state can never be writable repository input. */
function tempDomain(input: MaintenanceCommand): MaintenanceTempDomain | undefined {
  if (!input.tempDomain) return undefined;
  let statePath: string;
  try { statePath = realpathSync(input.tempDomain.statePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    statePath = join(realpathSync(dirname(input.tempDomain.statePath)), basename(input.tempDomain.statePath));
  }
  const brain = realpathSync(input.brainPath);
  const parent = dirname(statePath);
  if (parent === brain || parent.startsWith(`${brain}/`)) throw new WorkerHostError("maintenance admission state must be outside the authoritative brain");
  return { statePath };
}

/**
 * Starts a maintenance worker and hands back its streams. The trusted
 * bootstrap starts outside the brain, so no Bun configuration the brain holds
 * reaches the launcher process either.
 */
export function launchMaintenanceWorker(input: MaintenanceCommand): MaintenanceWorker {
  const limits = input.tempLimits ? resolveMaintenanceTempLimits(input.tempLimits) : hostMaintenanceTempLimits();
  const reservation = reserveMaintenanceTemp(limits, tempDomain(input));
  let startupView: WorkerStartupView | undefined;
  let pipes: ReturnType<typeof createWorkerPipes> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    startupView = input.startupView ?? (input.transport ? undefined : createWorkerStartupView(realpathSync(input.brainPath)));
    const boot = workerBootstrap({ ...maintenanceLaunch({ ...input, startupView, tempLimits: limits }), maintenanceReservation: reservation });
    pipes = createWorkerPipes();
    child = Bun.spawn(boot.command, { cwd: "/", env: boot.env,
      stdin: pipes.child[0], stdout: pipes.child[1], stderr: pipes.child[2] });
    pipes.closeChild();
    const ends = pipes.take();
    let inputClosed = false;
    const closeInput = () => { if (!inputClosed) { inputClosed = true; closeSync(ends.stdin); } };
    const running = child;
    return {
      async input(data) {
        try {
          // Bun's file sink polls the FIFO as well, so a large input waits for
          // the worker to read without holding a thread.
          const sink = Bun.file(ends.stdin).writer();
          // A large input's write settles later; await it here so a worker
          // that exits unread fails this try rather than the server.
          if (data) await sink.write(data);
          await sink.end();
        } catch { /* A command that never reads its input. */ } finally { closeInput(); }
      },
      stdout: fifoStream(ends.stdout),
      stderr: fifoStream(ends.stderr),
      pid: running.pid,
      exited: running.exited.finally(() => { try { closeInput(); } finally { try { if (!input.startupView) startupView?.cleanup(); } finally { reservation.release(); } } }),
      kill: (signal?: NodeJS.Signals) => killWorker(running, signal),
    };
  } catch (error) {
    try { if (child) killWorker(child, "SIGKILL"); } finally {
      try { pipes?.cleanup(); } finally { try { if (!input.startupView) startupView?.cleanup(); } finally { reservation.release(); } }
    }
    throw error;
  }
}

/**
 * Stops a worker whole. The pid the server holds is bubblewrap's outer
 * process; its child is the init of the worker's PID namespace. Killing that
 * init first makes the kernel kill and reap every process in the namespace
 * before the init's exit completes, and bubblewrap exits only after it, so
 * `exited` settles once nothing of the worker is left. Killing only the
 * outer process would let it exit while the namespace is still tearing down.
 */
function killWorker(child: { pid: number; kill(signal?: NodeJS.Signals): void }, signal: NodeJS.Signals = "SIGKILL"): void {
  let inits: number[] = [];
  try {
    inits = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  } catch { /* Already gone, or no children list: the outer kill below still applies. */ }
  // A namespace init takes only SIGKILL from outside; the outer process then
  // exits on its own once the namespace is empty.
  let reached = false;
  for (const pid of inits) { try { process.kill(pid, "SIGKILL"); reached = true; } catch { /* Raced away. */ } }
  if (!reached) child.kill(signal);
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

/** Runs one maintenance command to completion. An abort or the deadline kills the whole worker. */
export async function runMaintenanceWorker(input: MaintenanceCommand & {
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<MaintenanceResult> {
  input.signal?.throwIfAborted();
  const worker = launchMaintenanceWorker(input);
  let killed = false;
  const kill = () => { killed = true; worker.kill("SIGKILL"); };
  input.signal?.addEventListener("abort", kill, { once: true });
  const timer = input.timeoutMs ? setTimeout(kill, input.timeoutMs) : undefined;
  try {
    void worker.input(input.stdin ?? "");
    const [stdout, stderr, exitCode] = await Promise.all([collect(worker.stdout), collect(worker.stderr), worker.exited]);
    input.signal?.throwIfAborted();
    return { stdout, stderr, exitCode, killed };
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", kill);
  }
}

/** Native writable qualification prepares asynchronously and awaits ownership cleanup. */
export async function probeNativeMaintenanceWorker(brainPath: string, tempLimits: WorkerStateLimits | undefined, tempDomain: MaintenanceTempDomain | undefined, startupView: WorkerStartupView, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; requirement: string }> {
  let outputs: Awaited<ReturnType<typeof prepareNativeWorkerOutput>> | undefined;
  try {
    outputs = await prepareNativeWorkerOutput(realpathSync(brainPath), { startupView, signal });
    const result = await runMaintenanceWorker({ brainPath, startupView: outputs.view, output: { ...outputs.output, target: "/tmp/brain-maintenance-output" },
      command: ["/bin/sh", "-c", 'printf "qualified" > "$BRAIN_ROOT/.brain-maintenance-probe"'], env: { PATH: "/usr/bin:/bin" }, credentials: false,
      ...(tempLimits ? { tempLimits } : {}), ...(tempDomain ? { tempDomain } : {}), signal, timeoutMs: 5_000 });
    if (result.exitCode === 0) return { ok: true };
    return { ok: false, requirement: `a credential-free maintenance worker could not start (${result.stderr.trim().slice(0,300) || `exit ${result.exitCode}`})` };
  } catch (error) {
    if (signal?.aborted || error instanceof WorkerStateError) throw error;
    return { ok: false, requirement: `a credential-free maintenance worker could not start (${error instanceof Error ? error.message : String(error)})` };
  } finally { await outputs?.cleanup(); }
}

const EMPTY_REPOSITORY = "/tmp/brain-empty-repository";

/**
 * Exit code of `git <args>` run against the brain, with the brain as working
 * directory, always in a credential-free maintenance worker (#1648). Git
 * reads the brain's configuration, its includes and its ignore files, and
 * its only callers serve a turn, which needs the worker boundary anyway; so
 * the server never runs it on the host against the brain. Where no worker
 * can run, the answer is 127, a refusal. The brain is named a safe directory
 * on the command line: the worker sees no home, and the server already
 * trusts the brain it serves. `emptyRepository` asks through a fresh empty
 * repository inside the worker, for a brain outside any repository.
 */
export function brainGitSync(brain: string, args: readonly string[], options: { emptyRepository?: boolean; timeoutMs?: number } & MaintenanceHost = {}): number {
  const git = Bun.which("git");
  if (!git) return 127;
  const root = realpathSync(brain);
  // A brain inside a parent repository: the worker sees that repository
  // read-only, so git answers about the brain as it does on the host. Found
  // by looking, never by running git here. The command stays the server's
  // own, with no network and no credential beside it.
  let parent: string | undefined;
  for (let dir = dirname(root); !options.emptyRepository && !parent && !existsSync(join(root, ".git")); dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) parent = dir;
    if (dir === "/") break;
  }
  const safe = ["-c", `safe.directory=${root}`, ...(parent ? ["-c", `safe.directory=${parent}`] : [])];
  const command = options.emptyRepository
    ? ["/bin/sh", "-c", 'r="$1"; shift; "$0" init -q --bare "$r" >/dev/null 2>&1 && exec "$0" --git-dir="$r" --work-tree=. "$@"', git, EMPTY_REPOSITORY, ...safe, ...args]
    : [git, ...safe, ...args];
  try {
    return runMaintenanceWorkerSync({ ...options, brainPath: brain, command, ...(parent ? { readPaths: [parent] } : {}), env: { PATH: [dirname(git), "/usr/bin:/bin"].join(":"), GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" },
      credentials: false, timeoutMs: options.timeoutMs ?? 10_000 }).exitCode;
  } catch (error) { if (error instanceof WorkerStateError) throw error; return 127; }
}

/**
 * Whether a credential-free maintenance worker (masks, read-write brain,
 * private network namespace) starts on this host for this brain. The
 * ordinary worker host probe does not cover the private network namespace.
 */
export function probeMaintenanceWorker(brainPath: string, tempLimits?: WorkerStateLimits, tempDomain?: MaintenanceTempDomain, startupView?: WorkerStartupView): { ok: true } | { ok: false; requirement: string } {
  let outputs: ReturnType<typeof prepareWorkerOutput> | undefined;
  try {
    outputs = prepareWorkerOutput(realpathSync(brainPath), { startupView });
    const result = runMaintenanceWorkerSync({ brainPath, startupView: outputs.view, output: outputs.output,
      command: ["/bin/sh", "-c", 'printf "qualified" > "$BRAIN_ROOT/.brain-maintenance-probe"'], env: { PATH: "/usr/bin:/bin" },
      credentials: false, ...(tempLimits ? { tempLimits } : {}), ...(tempDomain ? { tempDomain } : {}), timeoutMs: 5_000 });
    if (result.exitCode === 0) return { ok: true };
    return { ok: false, requirement: `a credential-free maintenance worker could not start (${result.stderr.trim().slice(0, 300) || `exit ${result.exitCode}`})` };
  } catch (error) {
    if (error instanceof WorkerStateError) throw error;
    return { ok: false, requirement: `a credential-free maintenance worker could not start (${error instanceof Error ? error.message : String(error)})` };
  } finally { outputs?.cleanup(); }
}

/**
 * The synchronous form, for a short query on a synchronous path (a git
 * `check-ignore`). No input is passed; the deadline is required.
 */
export function runMaintenanceWorkerSync(input: MaintenanceCommand & { timeoutMs: number }): MaintenanceResult {
  const limits = input.tempLimits ? resolveMaintenanceTempLimits(input.tempLimits) : hostMaintenanceTempLimits();
  const reservation = reserveMaintenanceTemp(limits, tempDomain(input));
  let startupView: WorkerStartupView | undefined;
  let pipes: ReturnType<typeof createWorkerPipes> | undefined;
  try {
    startupView = input.startupView ?? (input.transport ? undefined : createWorkerStartupView(realpathSync(input.brainPath)));
    const boot = workerBootstrap({ ...maintenanceLaunch({ ...input, startupView, tempLimits: limits }), maintenanceReservation: reservation });
    pipes = createWorkerPipes();
    const child = Bun.spawnSync(boot.command, { cwd: "/", env: boot.env, stdin: pipes.child[0],
      stdout: pipes.child[1], stderr: pipes.child[2], timeout: input.timeoutMs });
    pipes.closeChild(); pipes.closeInput();
    return { stdout: readFileSync(pipes.parent[1], "utf8"), stderr: readFileSync(pipes.parent[2], "utf8"),
      exitCode: child.exitCode ?? 1, killed: child.exitCode === null };
  } finally { try { pipes?.cleanup(); } finally { try { if (!input.startupView) startupView?.cleanup(); } finally { reservation.release(); } } }
}

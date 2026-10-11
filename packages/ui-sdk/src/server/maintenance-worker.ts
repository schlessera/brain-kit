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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createWorkerPipes } from "./worker-pipes.js";
import { MAINTENANCE_HOME, probeHomeOverlay, workerBootstrap, type WorkerLaunch } from "./worker-launcher.js";

/** Environment names a credential-free maintenance worker keeps: plain settings, never a key or a token. */
export const CREDENTIAL_FREE_ENV = ["PATH", "BRAIN_PATH", "BRAIN_ROOT", "NODE_ENV", "TZ", "LANG", "LC_ALL", "NO_COLOR",
  "BRAIN_RERANK_MODE", "XDG_BIN_HOME"] as const;

export interface MaintenanceCommand {
  brainPath: string;
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
}

export interface MaintenanceResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Killed for its deadline or an abort. */
  killed: boolean;
}

const overlays = new Map<string, boolean>();

/** Whether `home` can be overlaid on this host; measured once per brain and home. */
function overlayable(brain: string, home: string): boolean {
  const key = `${brain}\0${home}`;
  let known = overlays.get(key);
  if (known === undefined) {
    known = probeHomeOverlay(brain, home) === true;
    overlays.set(key, known);
  }
  return known;
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
    command: input.command,
    env,
    maintenance: {
      network: input.network ?? input.credentials,
      credentials: input.credentials,
      ...(home ? { home: { path: home, overlay: overlayable(realpathSync(input.brainPath), home) } } : {}),
      readPaths: [process.execPath, ...(input.readPaths ?? [])],
      ...(input.maskPaths ? { maskPaths: input.maskPaths } : {}),
      ...(input.writeFiles ? { writeFiles: input.writeFiles } : {}),
    },
  };
}

export interface MaintenanceWorker {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  pid: number;
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Starts a maintenance worker and hands back its streams. The trusted
 * bootstrap starts outside the brain, so no Bun configuration the brain holds
 * reaches the launcher process either.
 */
export function launchMaintenanceWorker(input: MaintenanceCommand): MaintenanceWorker {
  const boot = workerBootstrap(maintenanceLaunch(input));
  const pipes = createWorkerPipes();
  try {
    const child = Bun.spawn(boot.command, { cwd: "/", env: boot.env,
      stdin: pipes.child[0], stdout: pipes.child[1], stderr: pipes.child[2] });
    pipes.closeChild();
    const streams = pipes.streams();
    return { ...streams, pid: child.pid, exited: child.exited, kill: (signal?: NodeJS.Signals) => killWorker(child, signal) };
  } catch (error) { pipes.cleanup(); throw error; }
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

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
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
    worker.stdin.on("error", () => { /* A command that never reads its input. */ });
    worker.stdin.end(input.stdin ?? "");
    const [stdout, stderr, exitCode] = await Promise.all([collect(worker.stdout), collect(worker.stderr), worker.exited]);
    input.signal?.throwIfAborted();
    return { stdout, stderr, exitCode, killed };
  } finally {
    if (timer) clearTimeout(timer);
    input.signal?.removeEventListener("abort", kill);
  }
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
export function brainGitSync(brain: string, args: readonly string[], options: { emptyRepository?: boolean; timeoutMs?: number } = {}): number {
  const git = Bun.which("git");
  if (!git) return 127;
  const root = realpathSync(brain);
  // A brain inside a parent repository: the worker sees that repository
  // read-only, so git answers about the brain as it does on the host. Found
  // by looking, never by running git here. The command stays the server's
  // own, with no network and no credential beside it.
  let parent: string | undefined;
  for (let dir = dirname(root); !parent && !existsSync(join(root, ".git")); dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) parent = dir;
    if (dir === "/") break;
  }
  const safe = ["-c", `safe.directory=${root}`, ...(parent ? ["-c", `safe.directory=${parent}`] : [])];
  const command = options.emptyRepository
    ? ["/bin/sh", "-c", 'r="$1"; shift; "$0" init -q --bare "$r" >/dev/null 2>&1 && exec "$0" --git-dir="$r" --work-tree=. "$@"', git, EMPTY_REPOSITORY, ...safe, ...args]
    : [git, ...safe, ...args];
  try {
    return runMaintenanceWorkerSync({ brainPath: brain, command, ...(parent ? { readPaths: [parent] } : {}), env: { PATH: [dirname(git), "/usr/bin:/bin"].join(":") },
      credentials: false, timeoutMs: options.timeoutMs ?? 10_000 }).exitCode;
  } catch { return 127; }
}

/**
 * Whether a credential-free maintenance worker (masks, read-write brain,
 * private network namespace) starts on this host for this brain. The
 * ordinary worker host probe does not cover the private network namespace.
 */
export function probeMaintenanceWorker(brainPath: string): { ok: true } | { ok: false; requirement: string } {
  try {
    const result = runMaintenanceWorkerSync({ brainPath, command: ["/bin/sh", "-c", "exit 0"], env: { PATH: "/usr/bin:/bin" },
      credentials: false, timeoutMs: 5_000 });
    if (result.exitCode === 0) return { ok: true };
    return { ok: false, requirement: `a credential-free maintenance worker could not start (${result.stderr.trim().slice(0, 300) || `exit ${result.exitCode}`})` };
  } catch (error) {
    return { ok: false, requirement: `a credential-free maintenance worker could not start (${error instanceof Error ? error.message : String(error)})` };
  }
}

/**
 * The synchronous form, for a short query on a synchronous path (a git
 * `check-ignore`). No input is passed; the deadline is required.
 */
export function runMaintenanceWorkerSync(input: MaintenanceCommand & { timeoutMs: number }): MaintenanceResult {
  const boot = workerBootstrap(maintenanceLaunch(input));
  const pipes = createWorkerPipes();
  try {
    const child = Bun.spawnSync(boot.command, { cwd: "/", env: boot.env, stdin: pipes.child[0],
      stdout: pipes.child[1], stderr: pipes.child[2], timeout: input.timeoutMs });
    pipes.closeChild(); pipes.closeInput();
    return { stdout: readFileSync(pipes.parent[1], "utf8"), stderr: readFileSync(pipes.parent[2], "utf8"),
      exitCode: child.exitCode ?? 1, killed: child.exitCode === null };
  } finally { pipes.cleanup(); }
}

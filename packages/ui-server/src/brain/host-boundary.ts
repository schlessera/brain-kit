/**
 * The host execution boundary (#1648; docs/decisions/governed-writable-workers.md,
 * "The host execution boundary").
 *
 * > No host process evaluates repository-supplied code, or runs git or the
 * > `brain` CLI against the brain, once a `governed` turn may have changed it.
 *
 * Under `governed` the brain is writable from inside a turn. Its config and
 * whatever the config imports, a `bunfig.toml` preload, an `.env`, git
 * includes, filters and refs are then all agent-writable inputs, and any host
 * process that evaluates them runs what an agent wrote. So while the boundary
 * is in force, every such evaluation runs in a maintenance worker: the same
 * launcher the agent workers use, with the brain writable, the host read-only
 * and its runtime and home directories masked.
 *
 * The boundary is in force when `governed` is available on this host (it is
 * the default profile), and from then on whenever a governed turn has ever
 * run on this brain, a fact kept in the UI database. It is not in force where
 * no governed turn can run: a server whose working directory or database is
 * inside the brain, or a host without the worker boundary. There the brain is
 * only ever written through the server's own routes, as before 0.42.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Logger } from "@opentelemetry/api-logs";
import {
  CREDENTIAL_FREE_ENV, execWrapperSpawnOptions, launchMaintenanceWorker, probeMaintenanceWorker, restrictedReadPaths, runMaintenanceWorker, workerHostBoundary,
  runMaintenanceWorkerSync, workerHostProven, type MaintenanceCommand, type WorkerHostProbe,
} from "@schlessera/brain-ui-sdk/internal";
import { killWrapped, wrapCommand, type ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import type { GateHold, GateMode, WriterGate } from "./writer-gate.js";
import type { GovernedStatus, GovernedUnavailableReason } from "@schlessera/brain-ui-sdk/protocol";

/** Why `governed` cannot run on this server. */
export type { GovernedUnavailableReason };

export type GovernedAvailability =
  | { available: true }
  | { available: false; reason: GovernedUnavailableReason; detail: string };

/** How a command meets the writer gate: not at all (a reader), shared, or exclusively. */
export type GateUse = "none" | GateMode;

/** One evaluation of the brain's own code: its working directory is the brain. */
export interface BrainExecution {
  /** Program and arguments. A bare program name is resolved on the worker's PATH. */
  argv: readonly string[];
  /** The environment a credentialed command receives; a credential-free one gets only its plain settings. */
  env: Readonly<Record<string, string | undefined>>;
  /** Whether the command receives credentials (keys, the network, the server's home). */
  credentials: boolean;
  gate: GateUse;
  /** Named on the gate and in errors. */
  purpose: string;
  stdin?: string;
  signal?: AbortSignal;
  /** Host-side Bun options for the old unwrapped path, such as SIGKILL on abort. */
  killSignal?: NodeJS.Signals;
  timeoutMs?: number;
  /** Existing host files the command may append to (a cron span sink). */
  writeFiles?: readonly string[];
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** A maintenance worker killed at its deadline (an abort throws instead). */
  timedOut?: boolean;
}

export interface StreamingExecution {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  readonly signalCode: string | null;
  kill(signal?: NodeJS.Signals): void;
}

/** Environment names a credential-free maintenance worker keeps: plain settings, never a key or a token. */
export { CREDENTIAL_FREE_ENV };

/**
 * How each `brain` subcommand the server spawns meets the boundary. Every
 * maintenance worker binds the brain read-write and runs code the brain
 * supplies, so even a "reader" can write: each takes the gate at least
 * shared, and nothing runs beside an exclusive holder. The work a turn may
 * wait on (hygiene, skills, scratch, module settings, the readers) is
 * credential-free and shared. Search is the one credentialed command held
 * shared: it embeds its query with the provider key, and a search must not
 * wait for every running turn. Everything else that holds a key or the
 * network, and any unknown command, is credentialed and exclusive.
 */
export function brainCommandClass(args: readonly string[]): { credentials: boolean; gate: GateUse } {
  const [command] = args;
  switch (command) {
    case "--version": case "briefing": case "stats": case "list": case "read": case "validate":
    case "hygiene": case "skills": case "scratch":
      return { credentials: false, gate: "shared" };
    case "search": return { credentials: true, gate: "shared" };
    // A module action runs the module's own code, which may call out.
    case "module": return args.includes("--action") ? { credentials: true, gate: "exclusive" } : { credentials: false, gate: "shared" };
    default: return { credentials: true, gate: "exclusive" };
  }
}

/** The cron jobs the generated crontab names; a module or hand-written job is credentialed and exclusive. */
export function cronJobClass(jobName: string): { credentials: boolean; gate: GateUse } {
  switch (jobName) {
    case "validate": return { credentials: false, gate: "shared" };
    case "hygiene": return { credentials: false, gate: "shared" };
    default: return { credentials: true, gate: "exclusive" };
  }
}

/** Concrete probe object permits test spies, with no production disable flag. */
export const hostExecution = {
  /** The same probe a turn's gate runs, so a test double stands in for both. */
  probe: (brainPath: string): WorkerHostProbe => workerHostBoundary.probe(brainPath),
  /** A credential-free maintenance worker, network namespace included, which the ordinary probe does not cover. */
  maintenanceProbe: (brainPath: string): WorkerHostProbe => probeMaintenanceWorker(brainPath),
  cwd: () => process.cwd(),
};

const within = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);
const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Whether `governed` can run for this server and brain, and if not, why. */
export function governedAvailability(input: { brainPath: string; dbPath?: string; workerHost: () => { ok: true } | { ok: false; requirement: string } }): GovernedAvailability {
  const brain = real(input.brainPath);
  const cwd = real(hostExecution.cwd());
  if (within(brain, cwd)) {
    return { available: false, reason: "server_cwd_in_brain",
      detail: `the server's working directory ${cwd} is inside the brain, so Bun loaded the brain's bunfig.toml and .env into the server itself; start the server from a directory outside the brain` };
  }
  if (input.dbPath && input.dbPath !== ":memory:" && within(brain, real(dirname(resolve(input.dbPath))))) {
    return { available: false, reason: "database_in_brain",
      detail: "the server's database is inside the brain, where a governed turn could write it; set DB_PATH to a path outside the brain" };
  }
  const probe = input.workerHost();
  if (!probe.ok) return { available: false, reason: "worker_host_unavailable", detail: probe.requirement };
  return { available: true };
}

export interface HostBoundary {
  readonly brainPath: string;
  /** Whether brain execution runs in maintenance workers. */
  isolated(): boolean;
  governed(): GovernedAvailability;
  /** Both, as `/api/status` reports them. */
  status(): GovernedStatus;
  /** Runs one command to completion, inside a maintenance worker while the boundary is in force. */
  run(execution: BrainExecution): Promise<ExecutionResult>;
  /** The same, with live output, for a streamed sync or a cron job. */
  launch(execution: BrainExecution): Promise<StreamingExecution>;
  /** A short synchronous query (git `check-ignore`). Takes no gate. */
  runSync(execution: Omit<BrainExecution, "gate" | "signal" | "stdin"> & { timeoutMs: number }): ExecutionResult;
  /** Runs `fn` while holding the gate, when there is one. */
  withGate<T>(mode: GateMode, purpose: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface HostBoundaryOptions {
  brainPath: string;
  exec?: ExecWrapperConfig;
  /** The UI database file; its directory is masked from every maintenance worker. */
  dbPath?: string;
  /** The writer gate, once the database is open. */
  gate?: () => WriterGate | null;
  /** Whether a governed turn has ever started on this brain: the durable record in the UI database. */
  history?: () => boolean;
  /** The latest ordinary worker host probe the server recorded; absent, the boundary probes once itself. */
  workerHost?: () => WorkerHostProbe | undefined;
  /** Refuse gated work while no gate is attached, instead of running it ungated (the cron runner). */
  requireGate?: boolean;
  /** The server's home, which a credentialed worker sees. */
  home?: string;
  log?: Logger;
}

/** The program a worker runs, made absolute: in the brain, the server's Bun, or on the worker's PATH. */
function absoluteArgv(brain: string, argv: readonly string[], path: string): string[] {
  const [program, ...args] = argv;
  if (!program) throw new Error("a maintenance command needs a program");
  // The server's own Bun, however it is named (a `latest` alias), is the binary the worker is given.
  if (isAbsolute(program)) return [real(program) === real(process.execPath) ? real(process.execPath) : program, ...args];
  if (program === "bun") return [realpathSync(process.execPath), ...args];
  if (program.includes("/")) return [join(brain, program), ...args];
  const found = Bun.which(program, { PATH: path });
  if (!found) throw new Error(`Cannot run ${JSON.stringify(program)} in a maintenance worker: it is not on the worker's PATH (${path})`);
  return [found, ...args];
}

/** The server's maintenance program; `bun` resolves its source, the build its output. */
export const MAINTENANCE_ENTRY = Bun.resolveSync("./maintenance-entry", import.meta.dir);

let serverRuntime: string[] | undefined;
/**
 * The server's own installation, read-only: this package with the
 * `node_modules` chain it resolves from and the packages linked into it, as
 * the restricted envelope's read paths are built. Where that sits below a
 * masked directory (an install under a home), each path is bound back; where
 * it does not, it is visible anyway. The maintenance entry imports core from
 * here. Only the server chooses these paths. Neither an argument (a search
 * query can look like a path) nor a path the brain supplies (a CLI link in
 * its `node_modules`) earns a bind: either would let something other than
 * the server choose what of the host the worker sees.
 */
function serverInstallation(): string[] {
  return serverRuntime ??= restrictedReadPaths([MAINTENANCE_ENTRY]);
}

export function createHostBoundary(options: HostBoundaryOptions): HostBoundary {
  const brain = real(options.brainPath);
  const exec = options.exec ?? {};
  let probed: WorkerHostProbe | undefined;
  // The latest ordinary probe: the server's own record when it keeps one,
  // otherwise one probe of this boundary's.
  // A passing ordinary probe still needs a maintenance worker that starts,
  // private network namespace and all: governed is unavailable without one.
  // A pass is kept; a failure is asked again after a minute.
  let maintenance: { probe: WorkerHostProbe; at: number } | undefined;
  const workerHost = (): WorkerHostProbe => {
    const ordinary = options.workerHost?.() ?? (probed ??= hostExecution.probe(brain));
    if (!ordinary.ok) return ordinary;
    if (!maintenance || (!maintenance.probe.ok && Date.now() - maintenance.at > 60_000)) {
      maintenance = { probe: hostExecution.maintenanceProbe(brain), at: Date.now() };
    }
    return maintenance.probe;
  };
  const governed = () => governedAvailability({ brainPath: brain, dbPath: options.dbPath, workerHost });
  // Sticky: a host whose worker boundary a real probe proved could have run a
  // governed turn, so a later failing probe never hands the brain's code back
  // to the host. Only a server that never could run one keeps it there.
  const isolated = () => {
    if (options.history?.() === true) return true;
    const availability = governed();
    return availability.available || (availability.reason === "worker_host_unavailable" && workerHostProven(brain));
  };

  const maskPaths = options.dbPath && options.dbPath !== ":memory:" ? [dirname(resolve(options.dbPath))] : [];
  const workerPath = (env: BrainExecution["env"]) => [join(brain, "node_modules", ".bin"), env.PATH ?? "/usr/local/bin:/usr/bin:/bin"].join(":");
  const command = (execution: BrainExecution | Parameters<HostBoundary["runSync"]>[0]): MaintenanceCommand => {
    const path = workerPath(execution.env);
    const env: Record<string, string | undefined> = execution.credentials ? { ...execution.env }
      : Object.fromEntries(CREDENTIAL_FREE_ENV.map(name => [name, execution.env[name]]));
    env.PATH = path;
    if (execution.credentials && options.home) env.HOME = options.home;
    const argv = absoluteArgv(brain, execution.argv, path);
    // The wrapper runs inside the worker; one that is not there fails here, as a host spawn of it would.
    if (exec.wrapper && !existsSync(exec.wrapper)) throw new Error(`The exec wrapper ${exec.wrapper} does not exist`);
    return {
      brainPath: brain,
      // The operator's exec wrapper runs inside the worker, as it does for agent workers.
      command: wrapCommand(argv, exec.wrapper),
      env,
      credentials: execution.credentials,
      ...(execution.credentials && options.home ? { home: options.home } : {}),
      readPaths: [...(exec.wrapper ? [exec.wrapper] : []), ...serverInstallation()],
      maskPaths,
      ...(execution.writeFiles?.length ? { writeFiles: execution.writeFiles } : {}),
    };
  };
  async function holdGate(mode: GateMode, purpose: string, signal?: AbortSignal): Promise<GateHold | null> {
    const gate = options.gate?.();
    if (gate) return gate.acquire(mode, purpose, { signal });
    if (options.requireGate) throw new Error(`${purpose} needs the brain's writer gate, and the UI database that holds it is unavailable`);
    return null;
  }
  async function withGate<T>(mode: GateMode, purpose: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const hold = await holdGate(mode, purpose, signal);
    try { return await fn(); } finally { hold?.release(); }
  }
  const gated = <T>(execution: BrainExecution, fn: () => Promise<T>) =>
    execution.gate === "none" ? fn() : withGate(execution.gate, execution.purpose, fn, execution.signal);

  /** The pre-boundary path: a host process with the brain as its working directory. */
  function hostSpawn(execution: BrainExecution) {
    const signal = execution.signal;
    const proc = Bun.spawn(wrapCommand(execution.argv, exec.wrapper), {
      cwd: brain,
      stdin: execution.stdin !== undefined ? new TextEncoder().encode(execution.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...execution.env },
      ...(signal && !exec.wrapper ? { signal, killSignal: execution.killSignal ?? "SIGKILL" } : {}),
      ...execWrapperSpawnOptions(exec.wrapper),
    });
    const onAbort = () => killWrapped(proc, exec, "SIGKILL");
    if (signal && exec.wrapper) signal.addEventListener("abort", onAbort, { once: true });
    void proc.exited.finally(() => signal?.removeEventListener("abort", onAbort));
    return proc;
  }

  return {
    brainPath: brain,
    isolated,
    governed,
    status: () => ({ hostExecution: isolated() ? "worker" : "host", ...governed() }),
    withGate,
    async run(execution) {
      execution.signal?.throwIfAborted();
      if (!isolated()) {
        const proc = hostSpawn(execution);
        try {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
          execution.signal?.throwIfAborted();
          return { stdout, stderr, exitCode };
        } catch (error) {
          if (execution.signal) { killWrapped(proc, exec, "SIGKILL"); await proc.exited; }
          throw error;
        }
      }
      return gated(execution, async () => {
        const result = await runMaintenanceWorker({ ...command(execution), stdin: execution.stdin,
          ...(execution.signal ? { signal: execution.signal } : {}), ...(execution.timeoutMs ? { timeoutMs: execution.timeoutMs } : {}) });
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, ...(result.killed ? { timedOut: true } : {}) };
      });
    },
    async launch(execution) {
      if (!isolated()) {
        const proc = hostSpawn(execution);
        return { stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited,
          get signalCode() { return proc.signalCode; }, kill: (signal?: NodeJS.Signals) => killWrapped(proc, exec, signal ?? "SIGTERM") };
      }
      const hold = execution.gate === "none" ? null : await holdGate(execution.gate, execution.purpose, execution.signal);
      let worker: ReturnType<typeof launchMaintenanceWorker>;
      try { worker = launchMaintenanceWorker(command(execution)); }
      catch (error) { hold?.release(); throw error; }
      worker.stdin.on("error", () => { /* A command that never reads its input. */ });
      worker.stdin.end(execution.stdin ?? "");
      let signalCode: string | null = null;
      const exited = worker.exited.finally(() => hold?.release());
      const toWeb = (stream: NodeJS.ReadableStream) => new ReadableStream<Uint8Array>({
        async start(controller) {
          try { for await (const chunk of stream as AsyncIterable<Buffer | string>) controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)); }
          catch (error) { controller.error(error); return; }
          controller.close();
        },
      });
      const kill = (signal: NodeJS.Signals = "SIGTERM") => { signalCode = signal; worker.kill(signal); };
      execution.signal?.addEventListener("abort", () => kill("SIGKILL"), { once: true });
      return { stdout: toWeb(worker.stdout), stderr: toWeb(worker.stderr), exited, get signalCode() { return signalCode; }, kill };
    },
    runSync(execution) {
      if (!isolated()) {
        const result = Bun.spawnSync([...execution.argv], { cwd: brain, env: { ...execution.env }, stdout: "pipe", stderr: "pipe", timeout: execution.timeoutMs });
        return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode ?? 1 };
      }
      const result = runMaintenanceWorkerSync({ ...command({ ...execution, gate: "none" } as BrainExecution), timeoutMs: execution.timeoutMs });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  };
}

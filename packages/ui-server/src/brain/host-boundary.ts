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
 * no governed turn can run: a server whose working directory is
 * inside the brain, or a host without the worker boundary. There the brain is
 * only ever written through the server's own routes, as before 0.42.
 */
import { brainWorkerPath } from "@schlessera/brain-common/internal/worker-areas";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Logger } from "@opentelemetry/api-logs";
import {
  WorkerStateError, workerIdentityHelper, CREDENTIAL_FREE_ENV, execWrapperSpawnOptions, launchMaintenanceWorker, probeNativeMaintenanceWorker, restrictedReadPaths, runMaintenanceWorker, workerHostBoundary,
  runMaintenanceWorkerSync, workerHostProven, hostMaintenanceTempLimits, resolveMaintenanceTempLimits, type WorkerStateLimits, type MaintenanceCommand, type WorkerHostProbe,
  prepareNativeWorkerStartupView, type WorkerStartupView,
  acquireHostCredentialExclusion, type HostCredentialDomain,
} from "@schlessera/brain-ui-sdk/internal";
import { createKeyedLock, type KeyedLock, killWrapped, wrapCommand, type ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import { markUnpinnedHostWriter, type GateHold, type GateMode, type WriterGate } from "./writer-gate.js";
import type { GovernedStatus, GovernedUnavailableReason } from "@schlessera/brain-ui-sdk/protocol";
import { runMirrorSync, syncMirrorPath } from "./sync-mirror.js";
import { resolveWorkerProtection } from "@schlessera/brain-ui-sdk/internal";
import { prepareMaintenanceOutput } from "./maintenance-output.js";
import { operationalStateMasks, operationalStateRefusal, type OperationalStateLayout } from "./operational-state.js";
import { prepareMaintenanceGit } from "./maintenance-git.js";

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
  /** @internal Storage owner operations recheck authority after admission/preparation. */
  assertAuthorized?: () => void;
  /** @internal Distinguish pre-launch owner refusal from an interrupted effect. */
  onExecute?: () => void;
  /** @internal Combined output bound for an explicitly bounded operation. */
  outputBytes?: number;
  /** @internal A consequence reader discards every worker output, including Git side effects. */
  publish?: false;
  /** @internal Fixed host-selected publication areas, never supplied by a request. */
  outputAreas?: readonly string[];
  /** Existing host files the command may append to (a cron span sink). */
  writeFiles?: readonly string[];
  /** A complete hosted sync: its only credentialed part is the host mirror transport. */
  sync?: boolean;
  /** @internal Take the contention lock after writer-gate admission, never before it. */
  lock?: { keyed: import("@schlessera/brain-ui-sdk/server").KeyedLock; key: string };
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
    // Automatic plain index is keyword-only. Provider/flagged operations keep
    // the conservative credentialed exclusive envelope.
    case "index": return args.length === 1 ? { credentials: false, gate: "shared" } : { credentials: true, gate: "exclusive" };
    case "storage": return args.length === 3 && args[1] === "pack" && args[2] === "--json" ? { credentials: false, gate: "shared" } : { credentials: true, gate: "exclusive" };
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
  maintenanceProbe: (brainPath: string, tempLimits: WorkerStateLimits, tempDomain: MaintenanceCommand["tempDomain"] | undefined, startupView: WorkerStartupView, signal?: AbortSignal): WorkerHostProbe | Promise<WorkerHostProbe> => probeNativeMaintenanceWorker(brainPath, tempLimits, tempDomain, startupView, signal),
  cwd: () => process.cwd(),
};

const within = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);
const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Whether `governed` can run for this server and brain, and if not, why. */
export function governedAvailability(input: OperationalStateLayout & { workerHost: () => { ok: true } | { ok: false; requirement: string } }): GovernedAvailability {
  const brain = real(input.brainPath);
  const cwd = real(hostExecution.cwd());
  if (within(brain, cwd)) {
    return { available: false, reason: "server_cwd_in_brain",
      detail: `the server's working directory ${cwd} is inside the brain, so Bun loaded the brain's bunfig.toml and .env into the server itself; start the server from a directory outside the brain` };
  }
  const refusal = operationalStateRefusal(input);
  if (refusal) return refusal;
  const probe = input.workerHost();
  if (!probe.ok) return { available: false, reason: "worker_host_unavailable", detail: probe.requirement };
  return { available: true };
}

export interface HostBoundary {
  /** Internal trusted admission settings, shared with hosted startup and short Git helpers. */
  readonly maintenance?: import("@schlessera/brain-ui-sdk/internal").MaintenanceHost;
  readonly brainPath: string;
  /** Whether brain execution runs in maintenance workers. */
  isolated(): boolean;
  governed(startupView?: WorkerStartupView): GovernedAvailability;
  /** Qualifies maintenance with a fresh native input lease, then awaits release. */
  prepare(signal?: AbortSignal, startupView?: WorkerStartupView): Promise<GovernedAvailability>;
  /** Both, as `/api/status` reports them. */
  status(): GovernedStatus;
  /** Runs one command to completion, inside a maintenance worker while the boundary is in force. */
  run(execution: BrainExecution): Promise<ExecutionResult>;
  /** The same, with live output, for a streamed sync or a cron job. */
  launch(execution: BrainExecution): Promise<StreamingExecution>;
  /** A short synchronous query (git `check-ignore`). Takes no gate. */
  runSync(execution: Omit<BrainExecution, "gate" | "signal" | "stdin"> & { timeoutMs: number; startupView?: WorkerStartupView }): ExecutionResult;
  /** Runs `fn` while holding the gate, when there is one. */
  withGate<T>(mode: GateMode, purpose: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface HostBoundaryOptions {
  /** Trusted shared host credential state; omitted server/cron instances use the per-UID domain. */
  credentialDomain?: HostCredentialDomain;
  /** The one configured host manager; never discovered through the repository. */
  nativeManager?: Parameters<typeof prepareNativeWorkerStartupView>[1];
  profile?: "governed" | "strict";
  /** Resolved once at the server/cron host edge. */
  maintenanceTemp?: WorkerStateLimits;
  brainPath: string;
  exec?: ExecWrapperConfig;
  /** The UI database file; its directory is masked from every maintenance worker. */
  dbPath?: string;
  privateStatePaths?: OperationalStateLayout["privateStatePaths"];
  /** Exact root-private paths verified by the configured native manager. */
  nativeMaskPaths?: readonly string[];
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

/** Cancelling an output reader discards output; it cannot interrupt lifecycle cleanup. */
function syncOutput() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { closed = true; } });
  return { stream,
    write(text: string) { if (!closed && text) controller.enqueue(new TextEncoder().encode(text)); },
    close() { if (!closed) { closed = true; controller.close(); } },
  };
}

let serverRuntime: string[] | undefined;
/** Preserve streaming/backpressure; cancellation discards while still draining native output. */
function credentialOutput(stream: ReadableStream<Uint8Array>, kill: () => void) {
  const reader = stream.getReader();
  let finished = false, discarded = false;
  let resolveDone!: () => void;
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  let reading: ReturnType<typeof reader.read> | undefined;
  const next = () => reading ??= reader.read().finally(() => { reading = undefined; });
  const finish = () => { if (!finished) { finished = true; reader.releaseLock(); resolveDone(); } };
  return { done, stream: new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await next();
        if (result.done) { finish(); if (!discarded) controller.close(); }
        else if (!discarded) controller.enqueue(result.value);
      } catch (error) { kill(); finish(); if (!discarded) controller.error(error); }
    },
    async cancel() {
      discarded = true;
      try { while (!finished) { if ((await next()).done) finish(); } }
      catch { kill(); finish(); }
    },
  }) };
}

/** Process exit alone need not mean its descendants released inherited output descriptors. */
function retainExecutionAdmission(execution: StreamingExecution,
  hold: { release(): void } | undefined): StreamingExecution {
  if (!hold) return execution;
  const kill = () => execution.kill("SIGKILL");
  const stdout = credentialOutput(execution.stdout, kill), stderr = credentialOutput(execution.stderr, kill);
  void Promise.allSettled([execution.exited, stdout.done, stderr.done]).then(() => hold.release());
  return { stdout: stdout.stream, stderr: stderr.stream, exited: execution.exited,
    get signalCode() { return execution.signalCode; }, kill: execution.kill };
}
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

// Maintenance readers can write derived projections and frozen Git objects
// into their private outputs. Serialize that lifecycle per canonical brain,
// including across independently constructed clients; governed peers still
// use the existing gate and publication revalidation.
const OUTPUT_LOCK = Symbol.for("@schlessera/brain-ui-server/maintenance-output-lock");
const outputSlot = globalThis as { [OUTPUT_LOCK]?: KeyedLock };
const outputLock = outputSlot[OUTPUT_LOCK] ??= createKeyedLock();
// Reuse only a completed successful maintenance qualification for the same
// brain, admission domain and limits. Independent clients must not probe
// before their shared output lock while another qualified client is running.
const MAINTENANCE_PROBES = Symbol.for("@schlessera/brain-ui-server/maintenance-probes");
const probeSlot = globalThis as { [MAINTENANCE_PROBES]?: Map<string, Extract<WorkerHostProbe, { ok: true }>> };
const passedMaintenanceProbes = probeSlot[MAINTENANCE_PROBES] ??= new Map();


export function createHostBoundary(options: HostBoundaryOptions): HostBoundary {
  const maintenanceTemp = options.maintenanceTemp ? resolveMaintenanceTempLimits(options.maintenanceTemp) : hostMaintenanceTempLimits();
  const brain = real(options.brainPath);
  if (options.credentialDomain) {
    const credentialState = real(options.credentialDomain.directory);
    if (within(brain, credentialState) || within(credentialState, brain)) throw new Error("Host credential state must be separate from repository input.");
  }
  const tempDomain = options.dbPath && options.dbPath !== ":memory:" ? { statePath: resolve(options.dbPath) } : undefined;
  const exec = options.exec ?? {};
  let mirror: string | undefined;
  let probed: WorkerHostProbe | undefined;
  // The latest ordinary probe: the server's own record when it keeps one,
  // otherwise one probe of this boundary's.
  // A passing ordinary probe still needs a maintenance worker that starts,
  // private network namespace and all: governed is unavailable without one.
  // A pass is kept; a failure is asked again after a minute.
  let maintenance: { probe: WorkerHostProbe; at: number } | undefined;
  let maintenanceResourceRefused = false;
  const maintenanceKey = JSON.stringify([brain, tempDomain ? real(tempDomain.statePath) : null,
    maintenanceTemp.allowanceBytes, maintenanceTemp.budgetBytes]);
  const workerHost = (startupView?: WorkerStartupView): WorkerHostProbe => {
    const ordinary = options.workerHost?.() ?? (probed ??= hostExecution.probe(brain));
    if (!ordinary.ok) return ordinary;
    if (!maintenance || (!maintenance.probe.ok && Date.now() - maintenance.at > 60_000)) {
      try {
        const known = passedMaintenanceProbes.get(maintenanceKey);
        if (!known && !startupView) return { ok: false, requirement: "a prepared native maintenance probe input is required; await boundary.prepare() before admission" };
        const checked = known ?? { ok: false as const, requirement: "native maintenance qualification requires awaited boundary.prepare()" };
        maintenanceResourceRefused = false;
        maintenance = { probe: checked, at: Date.now() };
        if (checked.ok) passedMaintenanceProbes.set(maintenanceKey, checked);
      } catch (error) {
        if (!(error instanceof WorkerStateError)) throw error;
        // Capacity says nothing about host capability. Do not cache this as a
        // containment failure or select host execution; next admission retries.
        maintenanceResourceRefused = true;
        return { ok: false, requirement: error.message };
      }
    }
    return maintenance.probe;
  };
  const governed = (startupView?: WorkerStartupView) => governedAvailability({ brainPath: brain, dbPath: options.dbPath, privateStatePaths: options.privateStatePaths, workerHost: () => workerHost(startupView) });
  const prepareInput = (signal?: AbortSignal) => {
    if (!options.nativeManager) throw new Error("Maintenance execution requires the configured native managed-storage manager; full-copy fallback is unavailable.");
    return prepareNativeWorkerStartupView(brain, options.nativeManager, signal);
  };
  // Sticky: a host whose worker boundary a real probe proved could have run a
  // governed turn, so a later failing probe never hands the brain's code back
  // to the host. Only a server that never could run one keeps it there.
  const isolated = () => {
    // Configured managed mode never hands executable repository inputs to
    // the host because a capability probe or native preparation failed.
    if (options.nativeManager) return true;
    if (options.history?.() === true) return true;
    const availability = governed();
    return availability.available || (availability.reason === "worker_host_unavailable" && (maintenanceResourceRefused || workerHostProven(brain)));
  };

  const maskPaths = [...operationalStateMasks({ brainPath: brain, dbPath: options.dbPath, privateStatePaths: options.privateStatePaths }), ...(options.nativeMaskPaths ?? [])];
  const command = (execution: BrainExecution | Parameters<HostBoundary["runSync"]>[0], startupView?: WorkerStartupView): MaintenanceCommand => {
    const path = brainWorkerPath(brain, execution.env.PATH);
    const env: Record<string, string | undefined> = execution.credentials ? { ...execution.env }
      : Object.fromEntries(CREDENTIAL_FREE_ENV.map(name => [name, execution.env[name]]));
    env.PATH = path;
    // Git credentials belong only to the mirror transport, including while
    // provider-credentialed maintenance remains an interim exposure.
    delete env.GITHUB_TOKEN;
    delete env.BRAIN_UI_SYNC_GITHUB_TOKEN;
    if (execution.credentials && options.home) env.HOME = options.home;
    const argv = absoluteArgv(brain, execution.argv, path);
    // The wrapper runs inside the worker; one that is not there fails here, as a host spawn of it would.
    if (exec.wrapper && !existsSync(exec.wrapper)) throw new Error(`The exec wrapper ${exec.wrapper} does not exist`);
    return {
      brainPath: brain,
      ...(startupView ? { startupView } : {}),
      tempLimits: maintenanceTemp,
      ...("outputBytes" in execution && execution.outputBytes ? { outputBytes: execution.outputBytes } : {}),
      ...(tempDomain ? { tempDomain } : {}),
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
  async function withGate<T>(mode: GateMode, purpose: string, fn: (hold: GateHold | null) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const hold = await holdGate(mode, purpose, signal);
    try { return await fn(hold); } finally { hold?.release(); }
  }
  const gated = <T>(execution: BrainExecution, fn: (hold: GateHold | null) => Promise<T>) =>
    execution.gate === "none" ? fn(null) : withGate(execution.gate, execution.purpose, fn, execution.signal);
  // Writer admission comes first. A running turn's host auth reader takes
  // only this credential exclusion and never asks for an exclusive writer.
  const credentialHold = (execution: BrainExecution, mirrorTransport = false) => execution.credentials && !mirrorTransport
    ? acquireHostCredentialExclusion({ domain: options.credentialDomain, signal: execution.signal,
      timeoutMs: execution.timeoutMs ?? 30_000 }) : Promise.resolve(undefined);
  const credentialed = async <T>(execution: BrainExecution, fn: () => Promise<T>, mirrorTransport = false): Promise<T> => {
    const hold = await credentialHold(execution, mirrorTransport);
    try { return await fn(); } finally { hold?.release(); }
  };

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
    maintenance: {tempLimits:maintenanceTemp,maskPaths,...(tempDomain ? {tempDomain} : {})},
    isolated,
    governed,
    async prepare(signal, preparedView) {
      signal?.throwIfAborted();
      // Capability proof is already complete. A maintenance output operation
      // has its own lease and must not delay this cached admission fact.
      if (passedMaintenanceProbes.has(maintenanceKey)) return governed();
      return outputLock.withLock(brain, async () => {
      signal?.throwIfAborted();
      const ordinary = options.workerHost?.() ?? (probed ??= hostExecution.probe(brain));
      if (!ordinary.ok) return governed();
      if (passedMaintenanceProbes.has(maintenanceKey) || (maintenance && !maintenanceResourceRefused && !maintenance.probe.ok && Date.now() - maintenance.at <= 60_000)) return governed();
      const view = preparedView ?? await prepareInput(signal);
      try {
        signal?.throwIfAborted();
        const checked = await hostExecution.maintenanceProbe(brain, maintenanceTemp, tempDomain, view, signal);
        maintenanceResourceRefused = false; maintenance = { probe: checked, at: Date.now() };
        if (checked.ok) passedMaintenanceProbes.set(maintenanceKey, checked);
        return governed();
      } catch (error) {
        if (!(error instanceof WorkerStateError)) throw error;
        signal?.throwIfAborted();
        // A transient resource refusal keeps the UI available and execution
        // isolated. The next explicit preparation retries immediately.
        maintenanceResourceRefused = true;
        maintenance = { probe: { ok: false, requirement: error.message }, at: Date.now() };
        return governed();
      }
      finally { if (!preparedView) await view.cleanup(); }
      }, { signal });
    },
    status: () => {
      const availability = governed();
      const ordinary = options.workerHost?.() ?? (probed ??= hostExecution.probe(brain));
      let configuredIdentity = false;
      try { configuredIdentity = Boolean(workerIdentityHelper()); } catch { configuredIdentity = true; }
      const identity = ordinary.ok && ordinary.identity === "separate_uid"
        ? { identity: "separate_uid" as const, workerUid: ordinary.workerUid }
        : configuredIdentity ? {} : { identity: "shared_uid" as const };
      const protection = resolveWorkerProtection(brain);
      const profile = options.profile === "strict" || !availability.available || protection.reason ? "strict" : "governed";
      return { hostExecution: isolated() ? "worker" : "host", ...availability, profile,
        protectedPaths: protection.protection.paths.map(({ rel, mode, reason }) => ({ path: rel, mode, reason })),
        ...(protection.reason ? { profileFallback: protection.reason } : {}),
        ...identity, configurationView: profile === "governed" ? "live" : "startup" };
    },
    withGate,
    async run(execution) {
      execution.signal?.throwIfAborted();
      execution.assertAuthorized?.();
      return gated(execution, async hold => {
        execution.signal?.throwIfAborted();
        if (!isolated()) {
          const result = await credentialed(execution, async () => {
            execution.signal?.throwIfAborted();
            // Another shared turn can establish sticky worker history while
            // credential exclusion waits. Release credentials before rerouting.
            if (isolated()) return undefined;
            if (execution.outputBytes !== undefined || execution.publish === false) throw Error("Bounded Storage maintenance requires the qualified worker boundary");
            execution.assertAuthorized?.();
            if (hold) markUnpinnedHostWriter(hold);
            execution.onExecute?.();
            const proc = hostSpawn(execution);
            const completion = [new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited] as const;
            try {
              const [stdout, stderr, exitCode] = await Promise.all(completion);
              execution.signal?.throwIfAborted();
              return { stdout, stderr, exitCode };
            } catch (error) {
              // A read can reject without a caller signal. Kill the command and
              // settle every native pipe/exit before releasing credential access;
              // descendants may still own the other inherited output descriptor.
              try { killWrapped(proc, exec, "SIGKILL"); }
              finally { await Promise.allSettled(completion); }
              throw error;
            }
          });
          if (result) return result;
        }
        return credentialed(execution, async () => {
          if (execution.sync) return outputLock.withLock(brain, () => runMirrorSync({ nativeManager: options.nativeManager, folderPaths: hold?.folderPaths, command: command(execution), transportEnv: execution.env, mirror: mirror ??= syncMirrorPath(brain, options.dbPath),
            ...(execution.signal ? { signal: execution.signal } : {}), ...(execution.timeoutMs ? { timeoutMs: execution.timeoutMs } : {}) }), { signal: execution.signal });
          const run = async () => {
            execution.assertAuthorized?.();
            const view = await prepareInput(execution.signal);
            let outputs: Awaited<ReturnType<typeof prepareMaintenanceOutput>> | undefined;
            try {
              execution.signal?.throwIfAborted();
              outputs = await prepareMaintenanceOutput(brain, { startupView: view, folderPaths: hold?.folderPaths, signal: execution.signal, areas: execution.outputAreas });
              const launch = command(execution);
              const git = await prepareMaintenanceGit(launch, outputs, execution.signal);
              execution.signal?.throwIfAborted(); execution.assertAuthorized?.();
              execution.onExecute?.();
              const result = await runMaintenanceWorker({ ...launch, startupView: outputs.view, output: outputs.output, ...(git ? { git } : {}), stdin: execution.stdin,
                ...(execution.signal ? { signal: execution.signal } : {}), ...(execution.timeoutMs ? { timeoutMs: execution.timeoutMs } : {}), ...(execution.outputBytes ? { outputBytes: execution.outputBytes } : {}) });
              if (!result.killed && execution.publish !== false) {
                execution.assertAuthorized?.();
                if (execution.lock) await outputs.publishLocked(execution.lock.keyed);
                else await outputs.publish();
              }
              return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, ...(result.killed ? { timedOut: true } : {}) };
            } finally { try { await outputs?.cleanup(); } finally { await view.cleanup(); } }
          };
          return outputLock.withLock(brain, () => execution.lock
            ? execution.lock.keyed.withLock(execution.lock.key, run, { signal: execution.signal }) : run(), { signal: execution.signal });
        }, execution.sync === true);
      });
    },
    async launch(execution) {
      execution.signal?.throwIfAborted();
      const hold = execution.gate === "none" ? null : await holdGate(execution.gate, execution.purpose, execution.signal);
      let hostFallback: boolean;
      try { execution.signal?.throwIfAborted(); hostFallback = !isolated(); }
      catch (error) { hold?.release(); throw error; }
      if (hostFallback) {
        let credential: Awaited<ReturnType<typeof acquireHostCredentialExclusion>> | undefined;
        try {
          credential = await credentialHold(execution);
          execution.signal?.throwIfAborted();
          if (isolated()) { credential?.release(); credential = undefined; }
          else {
            if (execution.publish === false) throw Error("A discarded read requires the qualified worker boundary");
            if (hold) markUnpinnedHostWriter(hold);
            const proc = hostSpawn(execution);
            return retainExecutionAdmission({ stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited,
              get signalCode() { return proc.signalCode; }, kill: (signal?: NodeJS.Signals) => killWrapped(proc, exec, signal ?? "SIGTERM") },
              credential || hold ? { release() { try { credential?.release(); } finally { hold?.release(); } } } : undefined);
          }
        } catch (error) { try { credential?.release(); } finally { hold?.release(); } throw error; }
      }
      let credential: Awaited<ReturnType<typeof acquireHostCredentialExclusion>> | undefined;
      let releaseOutput: () => void;
      try {
        credential = await credentialHold(execution, execution.sync === true);
        execution.signal?.throwIfAborted(); releaseOutput = await outputLock.acquire(brain, { signal: execution.signal });
      }
      catch (error) { credential?.release(); hold?.release(); execution.signal?.throwIfAborted(); throw error; }
      if (execution.sync) {
        try {
          // An abort can arrive while the gate is resolving. Check it before
          // preparation; attaching a listener alone would miss that event.
          execution.signal?.throwIfAborted();
          const selectedCommand = command(execution);
          const selectedMirror = mirror ??= syncMirrorPath(brain, options.dbPath);
          const abort = new AbortController();
          const stdout = syncOutput();
          const stderr = syncOutput();
          let signalCode: string | null = null;
          const onAbort = () => abort.abort(execution.signal?.reason);
          execution.signal?.addEventListener("abort", onAbort, { once: true });
          const exited = runMirrorSync({ nativeManager: options.nativeManager, folderPaths: hold?.folderPaths, command: selectedCommand, transportEnv: execution.env, mirror: selectedMirror, signal: abort.signal,
            ...(execution.timeoutMs ? { timeoutMs: execution.timeoutMs } : {}) }).then(result => {
            stdout.write(result.stdout); stderr.write(result.stderr); return result.exitCode;
          }, error => { stderr.write(error instanceof Error ? error.message : String(error)); return 1; })
            .finally(() => {
              try { stdout.close(); } finally {
                try { stderr.close(); } finally {
                  try { execution.signal?.removeEventListener("abort", onAbort); } finally { try { releaseOutput(); } finally { hold?.release(); } }
                }
              }
            });
          return { stdout: stdout.stream, stderr: stderr.stream, exited, get signalCode() { return signalCode; },
            kill(signal: NodeJS.Signals = "SIGTERM") { signalCode = signal; abort.abort(new Error(`sync killed by ${signal}`)); } };
        } catch (error) { try { releaseOutput(); } finally { try { credential?.release(); } finally { hold?.release(); } } throw error; }
      }
      let worker: ReturnType<typeof launchMaintenanceWorker>;
      let outputs: Awaited<ReturnType<typeof prepareMaintenanceOutput>> | undefined;
      let view: WorkerStartupView | undefined;
      try {
        execution.signal?.throwIfAborted();
        view = await prepareInput(execution.signal);
        execution.signal?.throwIfAborted();
        outputs = await prepareMaintenanceOutput(brain, { startupView: view, folderPaths: hold?.folderPaths, signal: execution.signal, areas: execution.outputAreas });
        const launch = command(execution);
        const git = await prepareMaintenanceGit(launch, outputs, execution.signal);
        execution.signal?.throwIfAborted();
        worker = launchMaintenanceWorker({ ...launch, startupView: outputs.view, output: outputs.output, ...(git ? { git } : {}) });
      }
      catch (error) { try { await outputs?.cleanup(); } finally { try { await view?.cleanup(); } finally { try { releaseOutput(); } finally { try { credential?.release(); } finally { hold?.release(); } } } } throw error; }
      void worker.input(execution.stdin ?? "");
      let signalCode: string | null = null;
      const exited = worker.exited.then(async code => {
        if (!signalCode && execution.publish !== false) {
          if (execution.lock) await outputs!.publishLocked(execution.lock.keyed);
          else await outputs!.publish();
        }
        return code;
      })
        .finally(async () => { try { await outputs!.cleanup(); } finally { try { await view!.cleanup(); } finally { try { releaseOutput(); } finally { hold?.release(); } } } });
      const kill = (signal: NodeJS.Signals = "SIGTERM") => { signalCode = signal; worker.kill(signal); };
      execution.signal?.addEventListener("abort", () => kill("SIGKILL"), { once: true });
      return retainExecutionAdmission({ stdout: worker.stdout, stderr: worker.stderr, exited, get signalCode() { return signalCode; }, kill }, credential);
    },
    runSync(execution) {
      if (execution.credentials) throw new Error("Credentialed maintenance requires asynchronous execution.");
      if (!isolated()) {
        if (execution.publish === false) throw Error("A discarded read requires the qualified worker boundary");
        const result = Bun.spawnSync([...execution.argv], { cwd: brain, env: { ...execution.env }, stdout: "pipe", stderr: "pipe", timeout: execution.timeoutMs });
        return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode ?? 1 };
      }
      if (!execution.startupView) throw new Error("A synchronous maintenance reader requires its caller's prepared immutable startupView; native preparation must be awaited before runSync.");
      const result = runMaintenanceWorkerSync({ ...command({ ...execution, gate: "none" } as BrainExecution, execution.startupView), timeoutMs: execution.timeoutMs });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  };
}

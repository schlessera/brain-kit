/** Unconditional isolated Claude child; project MCP, tools and descendants inherit it. */
import { EventEmitter } from "node:events";
import { deferredWorkerSpawn } from "./deferred-worker-spawn.js";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createTurnTempPromoter, launchAgentWorker, prepareNativeWorkerOutput, type PreparedWorkerOutput, mergeLimitReports, mib, requireWorkerHost, resolveTurnTempLimits, resolveWorkerStateLimits, retainWorkerStartupView,
  WORKER_SCRATCH, WORKER_STATE, type LaunchedWorker, type TurnTempPromotionRecord, type WorkerLimitReport,
  type WorkerLimitsPlan, type WorkerSandbox, type WorkerStateHandle, type WorkerStateLimits } from "@schlessera/brain-ui-sdk/internal";
import { FIRST_PARTY_FAILURE_CLASSES, type StateRoomObservation } from "@schlessera/brain-ui-sdk/protocol";
import { wrapCommand, type ExecWrapperConfig, type TurnFailure, type KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { restoreArchivedSession } from "./transcript-archive.js";
import { processStateLedger } from "./worker-state-budget.js";
import { createClaudeWorkerState, validateSessionId, workerStateSaveFailure, workerStateSaveReason } from "./worker-state.js";

/** Promotion of what an answer links in turn temp (#1655), for a turn that keeps its transcript. */
export interface WorkerPromotion {
  /** The host's turn id; absent from an older host. */
  turnId: string | undefined;
  /** What happened to each linked file; called once per worker, after it exited. */
  report(records: TurnTempPromotionRecord[]): void;
  log(level: "warn", message: string): void;
}

/** What the runtime prints when a write to its full tmpfs fails. */
const NO_SPACE = /ENOSPC|no space left on device/i;

/**
 * Whether a worker's runtime state filled its allowance (#1625): the private
 * tmpfs has no whole page left, or a write error names that state mount.
 * Generic ENOSPC may come from turn temp and must not claim lost runtime
 * state. The filesystem limit itself is the enforcement; this only names it.
 */
export function stateExhausted(state: Pick<WorkerStateHandle, "space">, diagnostics: string): boolean {
  if (diagnostics.split("\n").some(line => NO_SPACE.test(line) && line.includes(WORKER_STATE))) return true;
  try { return state.space().free < 4096; } catch { return false; }
}

export function exceededFailure(bytes: number, copyOut?: unknown): TurnFailure {
  return { errorClass: FIRST_PARTY_FAILURE_CLASSES.worker_state_exceeded,
    message: `This turn's runtime state filled the worker's ${mib(bytes)} allowance, so the runtime could not save all `
      + "of the turn. " + (copyOut === undefined ? "What it wrote before then is kept; the rest was not saved. "
        : `Its runtime state could not be saved in full either: ${workerStateSaveReason(copyOut)} `)
      + "If this recurs, continue in a new conversation." };
}

/** A worker-state refusal from any copy of this package, recognized by its class. */
export function workerStateClass(error: unknown): TurnFailure["errorClass"] | undefined {
  const errorClass = (error as { errorClass?: unknown } | null)?.errorClass;
  return errorClass === FIRST_PARTY_FAILURE_CLASSES.worker_state_busy || errorClass === FIRST_PARTY_FAILURE_CLASSES.worker_state_exceeded
    ? errorClass : undefined;
}

/** Validate before either archive or live storage is addressed. */
export function resumedSessionId(args: string[]): string | undefined {
  // The Agent SDK passes `--resume=<id>` as one token; accept the two-token
  // CLI form as well.
  const joined = args.find(arg => arg.startsWith("--resume="));
  const position = args.indexOf("--resume");
  if (joined === undefined && position === -1) return undefined;
  const id = joined !== undefined ? joined.slice("--resume=".length) : args[position + 1] ?? "";
  validateSessionId(id);
  return id;
}

/** The restore and snapshot are one synchronous operation before native spawn. */
export function prepareClaudeWorkerState(brainPath: string, env: Record<string, string | undefined>, args: string[],
  options: Parameters<typeof createClaudeWorkerState>[2] = {}) {
  const resume = options.ephemeral ? undefined : resumedSessionId(args);
  // Admitted before an archived session is restored, so a busy refusal
  // changes nothing on disk (#1625). Turn temp is admitted with it (#1703).
  const reservation = options.reservation ?? (options.ledger ?? processStateLedger())
    .reserve(options.limits ?? resolveWorkerStateLimits({}), options.turnTempLimits);
  try { if (resume) restoreArchivedSession(resume, { brainPath, env }); }
  catch (error) { reservation.release(); throw error; }
  return createClaudeWorkerState(brainPath, env, { ...options, resume, reservation });
}

/**
 * `restricted` selects the autonomous envelope (#676): a private network
 * namespace, an explicit read envelope holding only the executable, empty
 * runtime state, and the relay directory as the one route out.
 */
export function createWorkerSpawn(brainPath: string, config: ExecWrapperConfig, immediateSignal: AbortSignal,
  restricted?: { inferenceDir: string }, sandbox?: WorkerSandbox, limitsPlan?: WorkerLimitsPlan, promotion?: WorkerPromotion,
  stateOptions: Pick<NonNullable<Parameters<typeof createClaudeWorkerState>[2]>, "limits" | "ledger" | "turnTempLimits"> = {},
  outputLock?: KeyedLock, workerStarted?: import("@schlessera/brain-ui-sdk/server").StartTurnRequest["workerStarted"],
  startupView?: import("@schlessera/brain-ui-sdk/internal").WorkerStartupView) {
  const completions: Promise<void>[] = [];
  const reports: Array<() => WorkerLimitReport> = [];
  const limits = () => mergeLimitReports(reports.map(report => report()));
  const stateLimits = stateOptions.limits ?? resolveWorkerStateLimits({});
  // Every worker's /tmp is a private tmpfs of exactly this allowance (#1703).
  const turnTempLimits: WorkerStateLimits = stateOptions.turnTempLimits ?? resolveTurnTempLimits({});
  /** The running worker's turn temp, for the `turn_temp` tool and the pressure warnings. */
  let liveTurnTemp: WorkerStateHandle | undefined;
  let liveConfigurationRoot: string | undefined;
  let liveFileObserver: import("@schlessera/brain-ui-sdk/internal").LaunchedWorker["observeFile"];
  let observation: StateRoomObservation | undefined;
  /**
   * The first worker-state refusal or stop (#1625). The runtime only sees a
   * failed spawn or a write error, so the turn reports this instead.
   */
  let failure: TurnFailure | undefined;
  const record = (error: unknown) => {
    // By class, not constructor: the process ledger may come from another copy of this module.
    const errorClass = workerStateClass(error);
    if (!failure && errorClass) failure = { errorClass, message: (error as Error).message };
  };
  /** Live workers' exhaustion checks, so asking for the failure also checks now. */
  const checks = new Set<() => void>();
  function spawnNow({ command, args, env, signal }: SpawnOptions, preparedOutput?: PreparedWorkerOutput) {
      // The real launcher, with this worker's allowance, before anything is
      // restored, admitted or copied.
      requireWorkerHost(brainPath, { restricted: Boolean(restricted), stateBytes: stateLimits.allowanceBytes,
        turnTempBytes: turnTempLimits.allowanceBytes,
        ...(sandbox?.profile && sandbox.profile !== "restricted" ? { profile: sandbox.profile } : {}) });
      immediateSignal.throwIfAborted();
      let state: ReturnType<typeof createClaudeWorkerState>;
      try {
        state = prepareClaudeWorkerState(brainPath, env, args, { ...stateOptions, limits: stateLimits, turnTempLimits,
          ephemeral: Boolean(restricted) });
      } catch (error) { record(error); throw error; }
      const emitter = new EventEmitter();
      let worker: LaunchedWorker;
      try {
        const childEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
        childEnv.CLAUDE_CONFIG_DIR = WORKER_STATE;
        const populateState = (root: string) => { state.populate(root); observation = state.observation; };
        if (restricted) {
          // No host home exists in the envelope; runtime state is the fresh tmpfs.
          childEnv.HOME = WORKER_STATE;
          // The executable and any script it is handed, and nothing else of the
          // host. No operator exec wrapper: it is ambient host configuration.
          const readPaths = [command, ...args.filter(arg => isAbsolute(arg) && existsSync(arg) && statSync(arg).isFile())];
          worker = launchAgentWorker({ brainPath, stateBytes: state.bytes, turnTempBytes: state.turnTempBytes, populateState,
            ...(preparedOutput ? { preparedOutput } : startupView ? { startupView: retainWorkerStartupView(startupView) } : {}),
            command: [command, ...args], env: childEnv, ...(outputLock ? { outputLock } : {}),
            restricted: { readPaths, inferenceDir: restricted.inferenceDir }, ...(sandbox ? { sandbox } : {}),
            ...(limitsPlan ? { limits: limitsPlan } : {}) });
        } else {
          worker = launchAgentWorker({ brainPath, stateBytes: state.bytes, turnTempBytes: state.turnTempBytes, populateState,
            ...(preparedOutput ? { preparedOutput } : startupView && sandbox?.profile !== "governed" ? { startupView: retainWorkerStartupView(startupView) } : {}),
            command: wrapCommand([command, ...args], config.wrapper), env: childEnv, ...(outputLock ? { outputLock } : {}), ...(sandbox ? { sandbox } : {}),
            ...(limitsPlan ? { limits: limitsPlan } : {}) });
        }
      } catch (error) { record(error); state.release(); throw error; }
      let startFailure: unknown;
      reports.push(worker.limitReport);
      const handle = worker.state!;
      const turnTemp = worker.turnTemp;
      liveTurnTemp = turnTemp;
      liveConfigurationRoot = worker.configurationRoot;
      liveFileObserver = worker.observeFile;
      let killed = false, exitCode: number | null = null, signalCode: NodeJS.Signals | null = null;
      let exitEmitted = false;
      const emitExit = (code: number | null) => {
        if (exitEmitted) return;
        exitEmitted = true; emitter.emit("exit", killed ? null : code, signalCode);
      };
      let tail = "", noSpace = false;
      worker.stderr.setEncoding("utf8");
      worker.stderr.on("data", (data: string) => {
        // Sticky: later output must not push a reported write failure out of the tail.
        if (!noSpace && (tail.slice(-4096) + data).split("\n").some(line => NO_SPACE.test(line) && line.includes(WORKER_STATE))) noSpace = true;
        tail = (tail + data).slice(-65536);
      });
      worker.stderr.on("error", error => emitter.emit("error", error));
      // The final classification reads all of stderr: a write error can still
      // be buffered when the exit is observed. Bounded, should a pipe linger.
      const drained = new Promise<void>(done => {
        worker.stderr.once("end", done); worker.stderr.once("close", done); worker.stderr.once("error", () => done());
        const afterExit = () => { setTimeout(done, 2_000).unref?.(); };
        void worker.exited.then(afterExit, afterExit);
      });
      const kill = (sig: NodeJS.Signals): boolean => { killed = true; signalCode = sig; worker.kill(sig); return true; };
      const abort = () => kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || immediateSignal.aborted) abort();
      // Read when the turn asks and once the worker is gone; never polled.
      const check = () => { if (!failure && stateExhausted(handle, noSpace ? `ENOSPC ${WORKER_STATE}` : "")) failure = exceededFailure(state.bytes); };
      checks.add(check);
      const done = worker.exited.then(async code => {
        await drained;
        exitCode = code;
        signal.removeEventListener("abort", abort);
        if (startFailure !== undefined) throw startFailure;
        check();
        // Also record exhaustion in server diagnostics.
        if (failure?.errorClass === FIRST_PARTY_FAILURE_CLASSES.worker_state_exceeded) console.error(`Claude worker runtime state: ${failure.message}`);
        // bwrap's PID namespace dies with its init, including detached
        // children, so only the server touches the private tmpfs mounts now,
        // through the descriptors it holds. Runtime state is never turn temp,
        // though it is mounted below /tmp. Never for the restricted envelope.
        const promoter = turnTemp && promotion && sandbox && !restricted ? createTurnTempPromoter({ brain: sandbox.brain, tmp: turnTemp.root,
          turnId: promotion.turnId, scratch: WORKER_SCRATCH, exclude: [WORKER_STATE],
          scratchWritable: sandbox.areas.some(area => area.name === "scratch" && area.mount.writable) }) : undefined;
        try { state.persist(handle.root, promoter?.rewrite); } catch (error) {
          // The exhaustion message must not claim what the copy-out refused.
          if (failure?.errorClass === FIRST_PARTY_FAILURE_CLASSES.worker_state_exceeded) failure = exceededFailure(state.bytes, error);
          else if (!failure) failure = workerStateSaveFailure(error);
          // Record the raw exception only in host diagnostics, never the wire message.
          console.error("Claude worker runtime-state copy-out refused:", error);
        } finally { if (promoter?.records.length) promotion!.report(promoter.records); }
        if (code !== 0 && !killed && tail.trim()) console.error(`Claude worker exited ${code}: ${tail.trim()}`);
        emitExit(code);
      }).catch(error => {
        try { emitter.emit("error", error); } finally { emitExit(exitCode ?? 1); }
        throw error;
      })
        .finally(() => {
          checks.delete(check);
          if (liveTurnTemp === turnTemp) liveTurnTemp = undefined;
          try { handle.close(); turnTemp?.close(); } finally { state.release(); }
        });
      // Lifecycle is also awaited by the turn, so rejections cannot go unhandled.
      void done.catch(() => {});
      const process = { stdin: worker.stdin, stdout: worker.stdout, get killed() { return killed; },
        get exitCode() { return exitCode; }, get signalCode() { return signalCode; }, kill,
        on: emitter.on.bind(emitter), once: emitter.once.bind(emitter), off: emitter.off.bind(emitter) } as SpawnedProcess;
      try { workerStarted?.(worker); }
      catch (error) { startFailure = error ?? new Error("Worker start callback failed."); kill("SIGKILL"); }
      return { process, settled: done };
  }
  return {
    /** The resource limits this turn's workers hit so far (#1660). */
    limits,
    /** The turn-temp allowance each of this turn's workers is mounted with (#1703). */
    turnTempBytes: turnTempLimits.allowanceBytes,
    /** A server-side path to the running worker's `/tmp`, while one runs (#1703). */
    turnTempRoot: (): string | undefined => liveTurnTemp?.root,
    configurationRoot: (): string | undefined => liveConfigurationRoot,
    observeFile: (path: string) => liveFileObserver?.(path),
    stateRoom: (): StateRoomObservation | undefined => observation,
    /** The same, once the workers have exited or `waitMs` has passed. */
    async settledLimits(waitMs = 3_000): Promise<WorkerLimitReport> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(completions), new Promise(resolve => { timer = setTimeout(resolve, waitMs); })]);
      clearTimeout(timer);
      return limits();
    },
    spawn(options: SpawnOptions): SpawnedProcess {
      const areas = sandbox?.areas.filter(area => area.mount.writable).map(area => area.rel) ?? [];
      if (sandbox?.profile === "governed" || !areas.length) {
        const started = spawnNow(options);
        completions.push(started.settled);
        return started.process;
      }
      const deferred = deferredWorkerSpawn(async signal => {
        if (!startupView) throw new Error("Strict writable workers require a prepared native startup view.");
        let output: PreparedWorkerOutput;
        try { output = await prepareNativeWorkerOutput(brainPath, { startupView, areas, signal }); }
        catch (error) { record(error); throw error; }
        try {
          signal.throwIfAborted();
          return spawnNow({ ...options, signal }, output);
        } catch (error) { await output.cleanup(); throw error; }
      }, [immediateSignal, options.signal]);
      // Register preparation immediately: finish must own it even before a
      // native child exists, including a cancelled late preparation result.
      completions.push(deferred.settled);
      return deferred.process;
    },
    async finish() { await Promise.all(completions); },
    /** Why the worker's runtime state refused or stopped the turn, if it did (#1625). */
    failure(): TurnFailure | undefined { for (const check of checks) check(); return failure; },
  };
}

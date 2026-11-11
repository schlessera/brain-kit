/**
 * Worker admission, launch and lifecycle for one pi worker session (#2517).
 * Admission reads the native agent state the worker may receive, prepares
 * the inference relay and reserves the worker's turn temp; launch resolves
 * its sandbox and note and starts it; supervision owns what lives exactly as
 * long as the worker: its turn temp, relays, locks, stderr and limit reports.
 * Each step releases everything it acquired when it refuses.
 */
import { isWithin } from "@schlessera/brain-common/internal/safe-path";
import { brainWorkerPath } from "@schlessera/brain-common/internal/worker-areas";
import { processCleanupReconciler, type CleanupReconciler, workerCleanupUnconfirmed, reportStrandedWorkerCleanup, WORKER_PROVIDER_CREDENTIAL_ENV, workerProviderCredentials } from "@schlessera/brain-ui-sdk/internal";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { stateRoomCopy, stateRoomWarning, type StateRoomObservation } from "@schlessera/brain-ui-sdk/protocol";
import { getAgentDir, type FileEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { BackendRequestError, type compileConfirmPatterns, type ExecWrapperConfig } from "@schlessera/brain-ui-sdk/server";
import { workerOutwardNote, workerCommandPolicyNote, createLimitTracker, launchAgentWorkerAsync, launchLimits, prepareWorkerSandbox, prepareWorkerSandboxAsync, processStateLedger, retainWorkerStartupView, prepareNativeWorkerOutput, type PreparedWorkerOutput,
  outputStagingLimit, requireWorkerHostAsync, resolveTurnTempLimits, restrictedReadPaths, turnTempLimit, workerNoteLimits, WorkerResourceLimitError,
  workerSandboxNote, workerSandboxWarnings, WORKER_SCRATCH, WORKER_XDG_DIRS, type Reservation, type WorkerSandbox,
  type LaunchedWorker, type WorkerStateHandle, type WorkerNoteFacts, type sessionPromptContext } from "@schlessera/brain-ui-sdk/internal";

import { piAutonomousEnvelope } from "./autonomous-envelope.js";
import { preparePiHostInference, type PiHostInference } from "./host-inference.js";
import type { CreatePiBackendOptions, SessionEnv } from "./backend-options.js";
import { configuredProfiles } from "./profiles.js";
import type { TurnContext } from "./turn-context.js";
import { subprocessEnv, operatorAdmittedEnvNames } from "./config/env.js";
import { piSessionDirectory } from "./session-storage.js";
import { checkSessionSize, PI_WORKER_STATE, sendPipe } from "./worker-protocol.js";

/** The model a saved session last used: its latest model change, else its latest answer. */
export function savedModel(entries: FileEntry[]): { provider: string; id: string } | undefined {
  for (const entry of [...entries].reverse() as Array<Record<string, any>>) {
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") return { provider: entry.provider, id: entry.modelId };
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") return { provider: message.provider, id: message.model };
  }
  return undefined;
}

/** The host-only parts of a session's environment, never serialized into its worker. */
export type PiWorkerHostEnv = Pick<SessionEnv, "workerSandbox" | "workerProviderMasks" | "workerDataTree" | "workerLock" | "workerStarted"
  | "workerStartupView" | "workerSignal" | "toolExecution">;

export interface PiWorkerAdmissionRequest {
  backend: CreatePiBackendOptions;
  env: SessionEnv;
  declared: Model<any> | undefined;
  restricted: boolean;
  entries: FileEntry[] | undefined;
  resumeId: string | undefined;
  sessionId: string;
  profileId: string | undefined;
  promptContext: ReturnType<typeof sessionPromptContext> | undefined;
  exec: ExecWrapperConfig;
}

/** An admitted worker: what it may receive and the reservation that admitted it. */
export interface PiWorkerAdmission {
  agentDir: string;
  /** Native agent state files the worker receives, by name; syncAuth keeps auth.json current. */
  agentFiles: Record<string, string>;
  envelope: ReturnType<typeof piAutonomousEnvelope> | undefined;
  egress: WorkerSandbox["egress"] | undefined;
  hostInference: PiHostInference | undefined;
  cachedNpmModules: string | undefined;
  /** The worker's initialization message, without its sandbox note. */
  init: Record<string, unknown>;
  reservation: Reservation;
  admissionObservation: StateRoomObservation;
  identity: WorkerNoteFacts["identity"];
  hostEnv: PiWorkerHostEnv;
}

/**
 * Admits one worker: selects the native state it receives, prepares a
 * governed or strict turn's inference relay and reserves its turn temp
 * against the process ledger. A refusal stops every relay it started.
 */
export async function admitPiWorker(request: PiWorkerAdmissionRequest): Promise<PiWorkerAdmission> {
  const { backend, env, declared, restricted, entries, resumeId, sessionId, profileId, promptContext, exec } = request;
  const agentFiles: Record<string, string> = {};
  const agentDir = piSessionDirectory(backend.brainPath, getAgentDir());
  // A restricted autonomous turn copies no native state into the worker: no
  // stored login, provider override or settings (#676). The relay holds the key.
  const envelope = restricted ? piAutonomousEnvelope(declared, agentDir) : undefined;
  // A governed or strict turn on the turn proxy: the host holds the credential
  // and the worker's pi reaches inference only through the relay (#1665).
  const egress = !env.autonomous ? env.workerSandbox?.egress : undefined;
  const relayedModel = egress ? declared ?? (entries ? savedModel(entries) : undefined) : undefined;
  if (egress && !relayedModel) throw new BackendRequestError("A pi turn on the host inference relay needs a declared vendor/model profile.");
  // Provider folders admitted for a proven recipient (#2695): only its relay may carry this turn.
  const recipient = !env.autonomous ? env.workerSandbox?.inferenceRecipient : undefined;
  if (recipient && !egress) throw new BackendRequestError("This turn's provider folders were admitted for a recipient, but it has no inference relay to hold it to.");
  // Acquired inside the admission scope below, so every later failure releases it.
  let hostInference: PiHostInference | undefined;
  // A relayed worker gets only settings: the host keeps credentials and endpoints.
  if (!envelope) for (const name of egress ? ["settings.json"] : ["auth.json", "models.json", "settings.json"]) {
    const path = join(agentDir, name);
    if (existsSync(path)) agentFiles[name] = readFileSync(path, "utf8");
  }
  const { workerSandbox, workerProviderMasks, workerDataTree, workerLock, workerStarted, workerStartupView, workerSignal, toolExecution, cleanupActivity: _cleanupActivity, ...workerSessionEnv } = env;
  const npmPath = envelope ? undefined : join(agentDir, "npm", "node_modules");
  let cachedNpmModules: string | undefined;
  if (npmPath && existsSync(npmPath)) {
    const npmRoot = realpathSync(join(agentDir, "npm"));
    cachedNpmModules = realpathSync(npmPath);
    const descendant = (root: string, path: string) => { const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };
    if (!statSync(cachedNpmModules).isDirectory() || !descendant(agentDir, npmRoot)
      || !descendant(npmRoot, cachedNpmModules)) {
      throw new BackendRequestError("Pi prepared npm resources must be inside the selected agent directory's npm tree.");
    }
  }
  const init = { type: "init", governed: workerSandbox?.profile === "governed", dataTree: Boolean(workerSandbox?.dataTree ?? workerDataTree), sharedLock: Boolean(workerLock), backend: { exec, brainPath: backend.brainPath, profiles: configuredProfiles(backend), model: backend.model,
    loadExtensions: envelope ? false : backend.loadExtensions, systemPromptAppend: backend.systemPromptAppend }, env: workerSessionEnv, sessionId,
    resume: Boolean(resumeId), entries, profileId, agentFiles, fixedAppend: promptContext?.append(), ...(cachedNpmModules ? { cachedNpmModules } : {}), ...(envelope ? { inference: envelope.inference } : {}) };
  // Every worker's /tmp is a private tmpfs of exactly this allowance, which
  // holds the worker's session state too (#1703).
  const turnTempLimits = resolveTurnTempLimits({ ...backend.turnTemp,
    names: { allowance: "turnTemp.allowanceBytes", budget: "turnTemp.budgetBytes" } });
  let reservation: Reservation | undefined;
  let admissionObservation: StateRoomObservation;
  let identity: import("@schlessera/brain-ui-sdk/internal").WorkerNoteFacts["identity"];
  try {
    if (egress && relayedModel) {
      hostInference = await preparePiHostInference({ provider: relayedModel.provider, modelId: relayedModel.id, agentDir,
        ...(recipient ? { recipientOrigin: recipient.origin } : {}),
        brainPath: backend.brainPath, egress, environment: subprocessEnv(), ...(env.workerSignal ? { signal: env.workerSignal } : {}) });
      Object.assign(init, { relayed: hostInference.worker });
    }
    admissionObservation = checkSessionSize(init);
    const workerHost = await requireWorkerHostAsync(backend.brainPath, { restricted, turnTempBytes: turnTempLimits.allowanceBytes });
    if (workerHost?.identity === "separate_uid" && workerHost.workerUid !== undefined) identity = { kind: "separate_uid", workerUid: workerHost.workerUid };
    // Admitted against the same per-process ledger as Claude workers; a busy
    // budget refuses as worker_state_busy before anything launches.
    reservation = processStateLedger().reserve(undefined, turnTempLimits);
  } catch (error) { envelope?.relay.stop(); hostInference?.stop(); throw error; }
  return { agentDir, agentFiles, envelope, egress, hostInference, cachedNpmModules, init, reservation, admissionObservation, identity,
    hostEnv: { workerSandbox, workerProviderMasks, workerDataTree, workerLock, workerStarted, workerStartupView, workerSignal, toolExecution } };
}

export interface PiWorkerLaunchRequest {
  backend: CreatePiBackendOptions;
  env: SessionEnv;
  admission: PiWorkerAdmission;
  restricted: boolean;
  resumeId: string | undefined;
  execHelpers: string[];
  confirmPatterns: ReturnType<typeof compileConfirmPatterns>;
  startupStarted: number;
  turnContext: TurnContext;
}

/** A started worker, its resolved sandbox and the note its agent reads. */
export interface LaunchedPiWorker {
  child: LaunchedWorker;
  sandbox: WorkerSandbox;
  sandboxNote: string;
  turnTemp: WorkerStateHandle | undefined;
}

/**
 * Resolves the admitted worker's sandbox and note, then starts it. A failure
 * after launch stops and drains the owned child before its native stage and
 * reservation are released.
 */
export async function launchPiWorker(request: PiWorkerLaunchRequest): Promise<LaunchedPiWorker> {
  const { backend, env, admission, restricted, resumeId, execHelpers, confirmPatterns, startupStarted, turnContext } = request;
  const { envelope, egress, hostInference, cachedNpmModules, reservation, admissionObservation, identity } = admission;
  const { workerSandbox, workerProviderMasks, workerDataTree, workerLock, workerStarted, workerStartupView, workerSignal } = admission.hostEnv;
  const entry = Bun.resolveSync("./worker-entry", import.meta.dir);
  const workerEnv: Record<string, string> = envelope
    // The restricted envelope: minimum runtime variables only, the installed
    // runtime as the explicit read envelope, and the relay as the one route out.
    ? { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: WORKER_SCRATCH, BRAIN_ROOT: backend.brainPath }
    : { ...Object.fromEntries(Object.entries(subprocessEnv()).filter((pair): pair is [string, string] => pair[1] !== undefined)), BRAIN_ROOT: backend.brainPath };
  if (!envelope) workerEnv.PATH = brainWorkerPath(backend.brainPath, workerEnv.PATH);
  for (const name of hostInference?.credentialEnv ?? []) delete workerEnv[name];
  // The provider keys a governed or strict worker keeps (#1666). A relayed
  // worker keeps only what an operator admits. Without the relay, pi resolves
  // its own credentials in the worker and may read any of these, including
  // through a models.json `$NAME`, so they stay under the ruling that hosts
  // without managed native storage keep today's inference credentials (#2654).
  const credentialEnv = [...(hostInference ? [] : WORKER_PROVIDER_CREDENTIAL_ENV), ...operatorAdmittedEnvNames()];
  const providerKeys = workerProviderCredentials(workerEnv, credentialEnv).kept;
  workerEnv.PI_CODING_AGENT_DIR = PI_WORKER_STATE;
  // SDK offline mode silently skips missing sources. Validate prepared packages
  // explicitly in the child; the parent's environment remains unchanged.
  delete workerEnv.PI_OFFLINE;
  let child: LaunchedWorker;
  let launchedChild: LaunchedWorker | undefined;
  let preparedOutput: PreparedWorkerOutput | undefined;
  let sandboxNote: string;
  let sandbox: WorkerSandbox;
  // The worker's private /tmp, through the descriptor the server holds, so
  // what the answer links there can be promoted once the worker has exited
  // (#1655). An autonomous turn saves no answer.
  let turnTemp: WorkerStateHandle | undefined;
  try {
    // One resolution feeds the worker's mounts and the note its agent reads (#1626),
    // and one its resource limits and the note's limits section (#1660).
    sandbox = envelope ? { ...prepareWorkerSandbox(backend.brainPath, { restricted: true, maintenance: backend.maintenance }),
      ...(workerProviderMasks ? { providerMasks: workerProviderMasks } : {}), ...(workerDataTree ? { dataTree: workerDataTree } : {}) }
      : workerSandbox ?? await prepareWorkerSandboxAsync(backend.brainPath, { home: workerEnv.HOME, maintenance: backend.maintenance });
    if (hostInference) sandbox = { ...sandbox, maskPaths: [...sandbox.maskPaths ?? [], ...hostInference.maskPaths] };
    if (cachedNpmModules) {
      if (sandbox.maskPaths?.some(path => { try { const actual = realpathSync(path); return isWithin(cachedNpmModules, actual); } catch { return false; } })) {
        throw new BackendRequestError("Pi prepared npm resources cannot contain a private worker mask.");
      }
      sandbox = { ...sandbox, readPaths: [...(sandbox.readPaths ?? restrictedReadPaths([process.execPath, entry])), cachedNpmModules] };
    }
    // Worker-local tools run the host's helpers: each file alone, never its parent.
    if (execHelpers.length && !envelope) sandbox = { ...sandbox, readPaths: [...(sandbox.readPaths ?? restrictedReadPaths([process.execPath, entry])), ...execHelpers] };
    const limits = launchLimits({});
    sandboxNote = [workerSandboxNote(sandbox, { ...(identity ? { identity } : {}), ...(hostInference ? { egress: true } : {}), providerKeys, hardTimeoutMs: env.turnBudgetMs, limits: [...workerNoteLimits(limits.status),
      turnTempLimit(reservation.turnTempBytes, env.caps.turnTemp === true ? "turn_temp" : undefined),
      outputStagingLimit()] }), workerCommandPolicyNote(env.autonomous ? undefined : sandbox.commandPolicy, confirmPatterns), env.autonomous ? "" : workerOutwardNote(Boolean(hostInference), sandbox.commandPolicy?.taint?.())].filter(Boolean).join("\n\n");
    if (resumeId && !restricted && stateRoomWarning(admissionObservation)) {
      sandboxNote += `\n\n${stateRoomCopy(admissionObservation)} Continue in a new conversation before it is full. This one stays available.`;
    }
    for (const warning of workerSandboxWarnings(sandbox)) backend.log?.("warn", warning);
    if (workerStartupView && sandbox.profile !== "governed" && sandbox.areas.some(area => area.mount.writable)) {
      preparedOutput = await prepareNativeWorkerOutput(backend.brainPath, { startupView: workerStartupView, areas: sandbox.areas.filter(area => area.mount.writable).map(area => area.rel), folderPaths: sandbox.retainedFolders, signal: workerSignal });
    }
    workerSignal?.throwIfAborted();
    const spawning = performance.now();
    backend.log?.("debug", "Pi startup phase", { phase: "preparation", durationMs: spawning - startupStarted, elapsedMs: spawning - startupStarted });
    child = await launchAgentWorkerAsync({ brainPath: backend.brainPath, turnTempBytes: reservation.turnTempBytes,
      ...(preparedOutput ? { preparedOutput } : workerStartupView && sandbox.profile !== "governed" ? { startupView: retainWorkerStartupView(workerStartupView) } : {}),
      command: [process.execPath, entry], env: workerEnv, credentialEnv, sandbox, limits, ...(workerLock ? { outputLock: workerLock } : {}),
      ...(envelope ? { restricted: { readPaths: [...restrictedReadPaths([entry]), ...execHelpers], inferenceDir: envelope.relay.dir } } : {}),
      ...(hostInference && egress ? { egress: { proxyDir: egress.dir, directLoopback: true } } : {}),
    });
    launchedChild = child;
    backend.log?.("debug", "Pi startup phase", { phase: "spawn", durationMs: performance.now() - spawning, elapsedMs: performance.now() - startupStarted });
    turnTemp = child.turnTemp;
    turnContext.configurationRoot = child.configurationRoot;
    workerStarted?.(child);
  } catch (error) {
    // A post-launch callback can fail before the ordinary lifecycle handlers
    // exist. Stop and drain this owned child before deleting its native stage.
    const cleanupErrors: unknown[] = [];
    const attempt = async (cleanup: () => unknown | Promise<unknown>): Promise<boolean> => { try { await cleanup(); return true; } catch (failure) { cleanupErrors.push(failure); return false; } };
    if (launchedChild) {
      await attempt(() => launchedChild!.kill("SIGKILL"));
      await attempt(() => launchedChild!.exited);
      // Nothing reads its stdio yet: close the server's ends, then wait out Bun's duplicates (#2863).
      await attempt(() => { launchedChild!.stdin.end(); launchedChild!.stdout.destroy(); launchedChild!.stderr.destroy(); return launchedChild!.released(); });
    }
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      if (launchedChild) await launchedChild.turnTemp?.closeAsync();
      else if (workerCleanupUnconfirmed(error)) {
        if (!error.close) throw error;
        await error.close();
      }
      await preparedOutput?.cleanup();
    })().catch((failure: unknown) => { closing = undefined; throw failure; });
    try { await close(); reservation.release(); }
    catch (failure) {
      if (!launchedChild && workerCleanupUnconfirmed(error) && !error.close) reportStrandedWorkerCleanup("pi", reservation, error);
      else {
        cleanupErrors.push(failure);
        const activity = env.cleanupActivity ?? turnContext.bridge?.activity;
        processCleanupReconciler().retain({ bytes: reservation.bytes, turnTempBytes: reservation.turnTempBytes,
          close, release: () => reservation.release(), report: notice => activity?.({ kind: "worker_cleanup", ...notice }) }, failure);
      }
    }
    await attempt(() => envelope?.relay.stop());
    await attempt(() => hostInference?.stop());
    if (cleanupErrors.length) {
      try { backend.log?.("warn", `Pi startup cleanup retained failures after its original refusal: ${cleanupErrors.map(String).join("; ")}`); } catch { /* Reporting cannot replace the startup error. */ }
    }
    throw error;
  }
  return { child, sandbox, sandboxNote, turnTemp };
}

export interface PiWorkerSupervision {
  /** Frees the worker's turn temp once; a refused close is retried by the next call. */
  closeTurnTemp(): Promise<void>;
  /** Locks the worker holds, by lock id; all are released when it exits. */
  releases: Map<string, () => void>;
  /**
   * The caller awaits this worker's turn-temp close itself — `promote` after a
   * turn, an inactive abort, a startup failure — so its exit starts none. A
   * concurrent exit-driven close whose refusal resets the memo would otherwise
   * make the owner's awaited close a second attempt (#3544).
   */
  claimTurnTempClose(): void;
  /** The tail of the worker's stderr. */
  diagnostic(): string;
  reportLimitHits(): void;
  limitEnded(): Promise<WorkerResourceLimitError | undefined>;
  send(value: unknown): void;
  stdioReleased(): Promise<void>;
}

/**
 * Binds everything that lives exactly as long as the started worker: its
 * turn temp, relays, locks, stderr and host-limit reports.
 */
export function superviseWorker(worker: { child: LaunchedWorker; reservation: Reservation; turnTemp: WorkerStateHandle | undefined;
  env: SessionEnv; turnContext: TurnContext; admission: Pick<PiWorkerAdmission, "envelope" | "hostInference">; answerText(): string; cleanup?: CleanupReconciler }): PiWorkerSupervision {
  const { child, reservation, turnTemp, env, turnContext, answerText } = worker;
  const { envelope, hostInference } = worker.admission;
  const held = reservation;
  let turnTempClosing: Promise<void> | undefined;
  /**
   * Frees the worker's turn temp: the tmpfs goes once the worker is gone and
   * this descriptor is closed. The reservation is released only once a
   * separate-UID worker's broker cleanup is confirmed; a refusal keeps it
   * charged, and the next call tries again (#2854).
   */
  let released = false;
  const releaseReservation = () => { if (!released) { released = true; held.release(); } };
  const activity = env.cleanupActivity ?? turnContext.bridge?.activity;
  const cleanup = { bytes: held.bytes, turnTempBytes: held.turnTempBytes, close: () => closeStorage(), release: releaseReservation,
    report: (notice: import("@schlessera/brain-ui-sdk/internal").CleanupNotice) => activity?.({ kind: "worker_cleanup", ...notice }) };
  const closeStorage = (): Promise<void> => turnTempClosing ??= (async () => { await turnTemp?.closeAsync(); })()
    .catch((error: unknown) => {
      turnTempClosing = undefined;
      (worker.cleanup ?? processCleanupReconciler()).retain(cleanup, error);
      throw error;
    });
  const closeTurnTemp = async () => { await closeStorage(); releaseReservation(); };
  // The turn_temp tool reaches this worker's /tmp only while it runs (#1703).
  let workerLive = true;
  void child.exited.finally(() => { workerLive = false; }).catch(() => {});
  if (env.caps.turnTemp && turnTemp) {
    const root = turnTemp.root;
    turnContext.turnTemp = {
      root: () => workerLive ? root : undefined, allowanceBytes: held.turnTempBytes, scratch: WORKER_SCRATCH,
      exclude: [PI_WORKER_STATE], keep: [WORKER_SCRATCH, ...Object.values(WORKER_XDG_DIRS)],
      linkedText: () => answerText(),
    };
  }
  // The relay lives exactly as long as the worker it serves.
  if (envelope) void child.exited.finally(() => envelope.relay.stop()).catch(() => {});
  if (hostInference) void child.exited.finally(() => hostInference.stop()).catch(() => {});
  const releases = new Map<string, () => void>();
  void child.exited.finally(() => { for (const release of releases.values()) release(); releases.clear(); }).catch(() => {});
  // Only a worker no caller has claimed is closed by its exit — one disposed
  // without a turn. A prompted worker is cleaned up by `promote` once its
  // answer has been read; initialization failure and an inactive abort claim
  // the close before they kill the worker and await it themselves (#3544).
  let claimed = false;
  void child.exited.finally(() => claimed ? undefined : closeTurnTemp()).catch(() => {});
  child.stdin.on("error", () => {});
  let diagnostic = "";
  child.stderr.on("data", bytes => { diagnostic = (diagnostic + String(bytes)).slice(-4000); });
  // Each new host-limit hit is reported next to the step that caused it (#1660).
  const freshLimitHits = createLimitTracker();
  const reportLimitHits = (): void => {
    const fresh = freshLimitHits(child.limitReport());
    if (!fresh.length) return;
    try { turnContext.bridge?.activity?.({ kind: "resource_limit", limits: fresh, fatal: false }); } catch { /* observability only */ }
  };
  /**
   * Once the worker has exited: the limit that ended it, as the turn's
   * failure. Settled once, however many paths ask, and bounded: a worker that
   * closed its protocol but did not exit is not a limit's doing.
   */
  let limitSettlement: Promise<WorkerResourceLimitError | undefined> | undefined;
  const limitEnded = (): Promise<WorkerResourceLimitError | undefined> => limitSettlement ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([child.exited.then(() => true, () => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 3_000); })]);
    clearTimeout(timer);
    if (!exited) return undefined;
    const report = child.limitReport();
    if (!report.fatal) { reportLimitHits(); return undefined; }
    try { turnContext.bridge?.activity?.({ kind: "resource_limit", limits: report.hits, fatal: true }); } catch { /* observability only */ }
    return new WorkerResourceLimitError(report.hits);
  })();
  const send = (value: unknown) => sendPipe(child.stdin, value);
  /**
   * Once the worker has exited, its stdio can still be open here (#2863): Bun
   * closes its own duplicates of the FIFO descriptors on its pool after their
   * streams end. Prompt, refused initialization and pre-prompt cancellation
   * settle only after this, which resolves once they are closed or its bound expires.
   */
  const stdioReleased = (): Promise<void> => { child.stdin.end(); return child.released(); };
  return { closeTurnTemp, releases, claimTurnTempClose: () => { claimed = true; }, diagnostic: () => diagnostic, reportLimitHits, limitEnded, send, stdioReleased };
}

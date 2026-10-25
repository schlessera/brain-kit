import { brainWorkerPath } from "@schlessera/brain-common/internal/worker-areas";
import { workerCleanupUnconfirmed, sessionPromptContext, describeClient, workerExecHelpers, WORKER_PROVIDER_CREDENTIAL_ENV, workerProviderCredentials } from "@schlessera/brain-ui-sdk/internal";
import { safeResolve } from "@schlessera/brain/internal";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { stateRoomCopy, stateRoomWarning, type StateRoomObservation } from "@schlessera/brain-ui-sdk/protocol";
import { getAgentDir, SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { BackendRequestError, BRAIN_APPLICATION_TOOLS, brainApplicationInput, brainReadBaseInput, type BrainApplicationResult,
  compileConfirmPatterns, DEFAULT_CONFIRM_BASH_PATTERNS, isCompletedAutonomousToolCall } from "@schlessera/brain-ui-sdk/server";
import { bashLockKey, BRAIN_LOCK_KEY } from "@schlessera/brain-ui-sdk/server";
import { sessionReplay, NativeFileVersions, workerOutwardNote, workerCommandPolicyNote, createLimitTracker, createTurnTempPromoter, launchAgentWorkerAsync, launchLimits, prepareWorkerSandbox, prepareWorkerSandboxAsync, processStateLedger, retainWorkerStartupView, prepareNativeWorkerOutput, type PreparedWorkerOutput,
  outputStagingLimit, requireWorkerHostAsync, resolveTurnTempLimits, restrictedReadPaths, turnTempLimit, workerNoteLimits, WorkerResourceLimitError,
  workerSandboxNote, workerSandboxWarnings, WORKER_SCRATCH, WORKER_XDG_DIRS, type Reservation, type WorkerSandbox,
  type LaunchedWorker, type WorkerStateHandle } from "@schlessera/brain-ui-sdk/internal";

import { decidePiToolPermission } from "./permission-gate.js";
import { piAutonomousEnvelope } from "./autonomous-envelope.js";
import { piRelayOrigin, preparePiHostInference, type PiHostInference } from "./host-inference.js";
import type { CreatePiBackendOptions, PiSessionLike, SessionEnv } from "./backend-options.js";
import { configuredProfiles, resolveModelSpec, toModel } from "./profiles.js";
import { createTurnContext } from "./turn-context.js";
import { createPiBridgeTools, REQUEST_IMAGE_MASK_INPUT_SCHEMA } from "./bridge-tools.js";
import { DEFAULT_PI_ALLOWED_TOOLS } from "./tools.js";
import { subprocessEnv, ambientExecConfig, operatorAdmittedEnvNames } from "./config/env.js";
import { savePiSession, readPiSession, piSessionDirectory, syncPiAuth } from "./session-storage.js";
import { checkSessionSize, PI_WORKER_STATE, SessionTooLargeError, pipeMessages, sendPipe, piWorkerMessage, type PiWorkerMessage } from "./worker-protocol.js";

type Rpc = Extract<PiWorkerMessage, { type: "rpc" }>;
/** The model a saved session last used: its latest model change, else its latest answer. */
export function savedModel(entries: import("@earendil-works/pi-coding-agent").FileEntry[]): { provider: string; id: string } | undefined {
  for (const entry of [...entries].reverse() as Array<Record<string, any>>) {
    if (entry.type === "model_change" && typeof entry.provider === "string" && typeof entry.modelId === "string") return { provider: entry.provider, id: entry.modelId };
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") return { provider: message.provider, id: message.model };
  }
  return undefined;
}
/** What the host saw one call do: the RPCs it made, under the name it ran as (#2834). */
type CallExecution = { name: string; host: boolean; lock: boolean; phases: Set<string> };
/**
 * The execution path one completed call proved, from the host's own record of
 * its RPCs. Only an extension-free worker's calls are ever passed here: its
 * tools are the curated set, so a name names exactly one implementation.
 */
export function provenToolExecution(name: string, seen: CallExecution | undefined): "host_bridge" | "worker_read" | "worker_write" | undefined {
  if (!seen || seen.name !== name) return undefined;
  const phases = [...seen.phases].sort().join(",");
  // Its body ran in the host's handler: the worker side only forwarded it.
  if (seen.host) return !seen.lock && !phases ? "host_bridge" : undefined;
  if (name === "read_file") return !seen.lock && phases === "read_end,read_start" ? "worker_read" : undefined;
  if (name === "write_file" || name === "edit_file") return seen.lock && phases === "write_check,write_end" ? "worker_write" : undefined;
  return undefined;
}
/** The path a granted brain_read_base input names; undefined unless it is a valid input. */
function grantedReadBasePath(granted: string): string | undefined {
  try { const parsed = brainReadBaseInput.safeParse(JSON.parse(granted)); return parsed.success ? parsed.data.path : undefined; }
  catch { return undefined; }
}
/**
 * The exact origin a governed or strict turn's relay would reach (#2695): the
 * model `openPiWorkerSession` relays, resolved without opening a worker. A
 * new conversation uses the profile's declared model, a resumed one the
 * session's last model. Undefined when either cannot be resolved here.
 */
export async function piInferenceOrigin(backend: CreatePiBackendOptions, sessionDir: string, req: { profileId?: string; sessionId?: string }): Promise<string | undefined> {
  try {
    let ref: { provider: string; id: string } | undefined;
    if (req.sessionId) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(req.sessionId)) return undefined;
      ref = savedModel(readPiSession(join(sessionDir, `${req.sessionId}.jsonl`)));
    } else {
      const declared = toModel(resolveModelSpec(backend, req.profileId));
      ref = declared ? { provider: declared.provider, id: declared.id } : undefined;
    }
    return ref ? await piRelayOrigin({ provider: ref.provider, modelId: ref.id, agentDir: piSessionDirectory(backend.brainPath, getAgentDir()) }) : undefined;
  } catch { return undefined; }
}

export async function openPiWorkerSession(backend: CreatePiBackendOptions, sessionDir: string,
  env: SessionEnv, profileId?: string, resumeId?: string, nativeSessions = new Map<string, NativeFileVersions>()) {
  const startupStarted = performance.now();
  env.workerSignal?.throwIfAborted();
  const declared = resumeId ? undefined : toModel(resolveModelSpec(backend, profileId));
  const restricted = env.autonomous?.containment === "restricted";
  // Selected once per worker and serialized into its local tools. Helpers are
  // checked before any relay, reservation or worker exists (#1429).
  const exec = backend.exec ?? ambientExecConfig();
  const execHelpers = workerExecHelpers(exec);
  let entries: import("@earendil-works/pi-coding-agent").FileEntry[] | undefined;
  if (resumeId) {
    // Current server-owned transcripts have fixed UUID names. Opening one must
    // not parse every unrelated conversation just to discover that known path.
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(resumeId)) {
      throw new BackendRequestError(`Cannot resume unknown session: ${resumeId}`);
    }
    try { entries = readPiSession(join(sessionDir, `${resumeId}.jsonl`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Older SDK-managed filenames remain resumable; after the first turn the
      // existing persistence path writes the canonical server-owned filename.
      const info = (await SessionManager.list(backend.brainPath, sessionDir)).find(i => i.id === resumeId);
      if (info) entries = readPiSession(info.path);
    }
    const header = entries?.[0];
    if (header?.type !== "session" || header.id !== resumeId || header.cwd !== backend.brainPath) {
      throw new BackendRequestError(`Cannot resume unknown session: ${resumeId}`);
    }
  }
  const sessionId = resumeId ?? randomUUID();
  const promptContext = env.autonomous ? undefined : sessionPromptContext(sessionDir, backend.brainPath, sessionId);
  let ownedPrompt: { id: string; text: string; images: boolean } | undefined;
  const observationStorage = { directory: join(sessionDir, "native-observations"), brainPath: backend.brainPath, sessionId };
  const nativeVersions = nativeSessions.get(sessionId)
    ?? (!env.autonomous && resumeId ? await NativeFileVersions.restore(observationStorage) : new NativeFileVersions());
  if (!env.autonomous && !resumeId) await nativeVersions.retain(observationStorage);
  if (!env.autonomous) nativeSessions.set(sessionId, nativeVersions);
  /** Entries saved before this turn: only their own turn owns their display mappings. */
  const resumedIds = new Set((entries ?? []).map(entry => (entry as { id?: unknown }).id));
  const turnContext = createTurnContext();
  const allowedTools = new Set(env.autonomous?.allowedTools ?? backend.allowedTools ?? DEFAULT_PI_ALLOWED_TOOLS);
  const confirmPatterns = compileConfirmPatterns(backend.confirmBashPatterns ?? DEFAULT_CONFIRM_BASH_PATTERNS, () => {});
  const bridgeTools = createPiBridgeTools({ brainPath: backend.brainPath, turn: turnContext, capabilities: env.caps });
  const grants = new Map<string, { name: string; input: string }>();
  const replayTurnId = randomUUID();
  const display = sessionReplay(sessionDir, backend.brainPath, sessionId);
  const applications = new Map<string, { name: string; input: Record<string, unknown>; result: BrainApplicationResult; anchor?: string | null; output?: Awaited<ReturnType<(typeof bridgeTools)[number]["execute"]>> }>();
  let latestEntries: Record<string, unknown>[] = [];
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  let active = false;
  let initialized = false;
  let ended = false;
  let cost = 0;
  let thinkingLevel: ThinkingLevel | undefined;
  let levels: ThinkingLevel[] = [];
  let model: Model<any> | undefined;
  let lastRpcId = 0;
  let error: Error | undefined;
  const ready = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  // A rejection before prompt has no waiter yet; still retain it for prompt.
  void done.promise.catch(() => {});
  void ready.promise.catch(() => {});
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
  const { workerSandbox, workerProviderMasks, workerDataTree, workerLock, workerStarted, workerStartupView, workerSignal, toolExecution, ...workerSessionEnv } = env;
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
      if (sandbox.maskPaths?.some(path => { try { const actual = realpathSync(path); return actual === cachedNpmModules || actual.startsWith(cachedNpmModules + "/"); } catch { return false; } })) {
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
    let workerStorageReleased = !workerCleanupUnconfirmed(error);
    if (launchedChild) {
      await attempt(() => launchedChild!.kill("SIGKILL"));
      await attempt(() => launchedChild!.exited);
      workerStorageReleased = await attempt(() => launchedChild!.turnTemp?.closeAsync());
    }
    if (workerStorageReleased) await attempt(() => preparedOutput?.cleanup());
    await attempt(() => envelope?.relay.stop());
    await attempt(() => hostInference?.stop());
    if (workerStorageReleased) await attempt(() => reservation.release());
    if (cleanupErrors.length) {
      try { backend.log?.("warn", `Pi startup cleanup retained failures after its original refusal: ${cleanupErrors.map(String).join("; ")}`); } catch { /* Reporting cannot replace the startup error. */ }
    }
    throw error;
  }
  const held = reservation;
  let turnTempClosing: Promise<void> | undefined;
  /**
   * Frees the worker's turn temp: the tmpfs goes once the worker is gone and
   * this descriptor is closed. The reservation is released only once a
   * separate-UID worker's broker cleanup is confirmed; a refusal keeps it
   * charged, and the next call tries again (#2854).
   */
  const closeTurnTemp = (): Promise<void> => turnTempClosing ??= (async () => { await turnTemp?.closeAsync(); held.release(); })()
    .catch((error: unknown) => { turnTempClosing = undefined; throw error; });
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
  // A worker that never ran a turn has nothing to promote; one that did is
  // cleaned up by `promote` once its answer has been read. Initialization
  // failure and an inactive abort also await this close themselves.
  let prompted = false;
  void child.exited.finally(() => prompted ? undefined : closeTurnTemp()).catch(() => {});
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
  function live(): void {
    if (!active || ended || !turnContext.bridge || !turnContext.signal || turnContext.signal.aborted) {
      throw new Error("Pi worker RPC refused: turn is inactive, cancelled or revoked.");
    }
  }
  function fail(reason: unknown): void {
    // The first failure is the turn's: a later path cannot reclassify it.
    if (error) return;
    error = reason instanceof Error ? reason : new Error(String(reason));
    nativeVersions.cancelPending();
    ended = true;
    ready.reject(error); done.reject(error);
    child.kill("SIGKILL");
  }
  function persist(recoverMissing = false): void {
    if (env.autonomous) return;
    // Receipt ownership survives even when no runtime call or snapshot exists.
    // Never synthesize a model call or replace a runtime-written result.
    for (const [id, receipt] of applications) {
      const called = latestEntries.find(entry => !resumedIds.has(entry.id) && entry.type === "message"
        && (entry.message as any)?.role === "assistant" && (entry.message as any).content.some((part: any) => part.type === "toolCall" && part.id === id));
      if (typeof called?.id === "string") receipt.anchor = called.id;
      else if (receipt.anchor === undefined) {
        // Direct effects can precede every native message. Null is an owned
        // session-root position, not an anchor to a later worker snapshot.
        const prior = latestEntries.findLast(entry => entry.type === "message")
          ?? entries?.findLast(entry => entry.type === "message");
        receipt.anchor = typeof prior?.id === "string" ? prior.id : null;
      }
      display.retainReceipt({ id, name: receipt.name, input: receipt.input, anchor: receipt.anchor, turnId: replayTurnId,
        output: receipt.output?.content.filter(part => part.type === "text").map(part => part.text).join("") ?? JSON.stringify(receipt.result),
        isError: !receipt.result.ok });
    }
    if (!latestEntries.some(entry => entry.type === "message")) return;
    const saved = [...latestEntries];
    if (recoverMissing) for (const [id, receipt] of applications) {
      const called = saved.some(entry => !resumedIds.has(entry.id) && entry.type === "message" && (entry.message as any)?.role === "assistant"
        && (entry.message as any).content.some((part: any) => part.type === "toolCall" && part.id === id));
      const answered = saved.some(entry => !resumedIds.has(entry.id) && entry.type === "message" && (entry.message as any)?.role === "toolResult"
        && (entry.message as any).toolCallId === id);
      if (!called || answered) continue;
      // The installed Pi adapter repairs orphaned calls with "No result provided".
      // Preserve the committed effect instead, only after the runtime has exited.
      saved.push({ type: "message", id: randomUUID(), parentId: saved.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: id, toolName: receipt.name,
          content: receipt.output?.content ?? [{ type: "text", text: JSON.stringify(receipt.result) }],
          isError: !receipt.result.ok, timestamp: Date.now() } });
    }
    savePiSession(sessionDir, sessionId, saved);
  }

  /**
   * Once the worker has exited, copies what this turn's answers link in turn
   * temp into scratch, retains display mappings outside the transcript, and reports each
   * linked file to the host (#1655). Turn temp is removed either way.
   */
  async function promote(): Promise<void> {
    try {
      persist(true);
      if (!turnTemp || env.autonomous) return;
      const promoter = createTurnTempPromoter({ brain: sandbox.brain, tmp: turnTemp.root, turnId: turnContext.turnId, scratch: WORKER_SCRATCH,
        exclude: [PI_WORKER_STATE], scratchWritable: sandbox.areas.some(area => area.name === "scratch" && area.mount.writable) });
      for (const entry of latestEntries) {
        if (entry.type !== "message" || resumedIds.has(entry.id)) continue;
        const message = entry.message as { role?: unknown; content?: unknown } | undefined;
        if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const [index, part] of (message.content as Array<{ type?: unknown; text?: unknown }>).entries()) {
          if (part?.type !== "text" || typeof part.text !== "string") continue;
          await promoter.prepareRecovery(part.text, turnContext.signal ?? undefined);
          const next = promoter.rewrite(part.text);
          if (typeof entry.id === "string") display.retainText(entry.id, index, part.text, next);
        }
      }
      for (const record of promoter.records) {
        try { turnContext.bridge?.activity?.(record); } catch { /* Observability must not fail the observed turn. */ }
      }
    } catch (failure) {
      backend.log?.("warn", `promoting linked turn-temp files failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally { await closeTurnTemp(); }
  }
  /** The answer text of this turn's new assistant entries, as the worker has reported them. */
  function answerText(): string {
    const parts: string[] = [];
    for (const entry of latestEntries) {
      if (entry.type !== "message" || resumedIds.has(entry.id)) continue;
      const message = entry.message as { role?: unknown; content?: unknown } | undefined;
      if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const part of message.content as Array<{ type?: unknown; text?: unknown }>) {
        if (part?.type === "text" && typeof part.text === "string") parts.push(part.text);
      }
    }
    return parts.join("\n");
  }
  // Extension code runs on every tool event and can write at any time (#2834):
  // only a worker that loads none can prove a call's execution path. Proof
  // also ends, for the worker's lifetime, once it admits a call that can run
  // other code (bash, grep, brain-owned configuration through an index tool,
  // an application tool) or starts a call under a running call's identity:
  // from then on the worker's own reports are no evidence.
  const extensionFree = envelope !== undefined || backend.loadExtensions === false;
  const provableTools = new Set(["read_file", "write_file", "edit_file", "brain_read_base", ...bridgeTools.map(tool => tool.name)]);
  let provable = extensionFree;
  const running = new Set<string>();
  const executions = new Map<string, CallExecution>();
  const executed = (msg: Rpc): CallExecution => {
    let seen = executions.get(msg.toolCallId);
    if (!seen) executions.set(msg.toolCallId, seen = { name: msg.toolName, host: false, lock: false, phases: new Set() });
    // A call that names two tools proves neither.
    else if (seen.name !== msg.toolName) seen.name = "";
    return seen;
  };
  async function dispatch(msg: Rpc): Promise<unknown> {
    live();
    if (msg.id <= lastRpcId) throw new Error("Replayed pi worker RPC");
    lastRpcId = msg.id;
    const bridge = turnContext.bridge!;
    if (msg.method === "unlock") {
      if (typeof msg.input.lockId !== "string" || Object.keys(msg.input).length !== 1 || !releases.has(msg.input.lockId)) throw new Error("Unknown pi worker lock");
      releases.get(msg.input.lockId)!(); releases.delete(msg.input.lockId); return { ok: true };
    }
    if (msg.method === "lock") {
      const grant = grants.get(msg.toolCallId);
      if (!workerLock || !grant || grant.name !== msg.toolName) throw new Error("Pi worker lock has no server permission grant");
      const input = JSON.parse(grant.input);
      const fileTool = ["write_file", "edit_file"].includes(msg.toolName);
      // The worker locks the canonical contained target, including an internal
      // symlink or a missing leaf below an existing parent. Validate identically.
      const target = fileTool && typeof input.path === "string" ? safeResolve(backend.brainPath, input.path) : null;
      const key = msg.toolName === "bash" ? bashLockKey(input.command)
        : fileTool ? target && `path:${target}` : BRAIN_LOCK_KEY;
      if (typeof key !== "string" || msg.input.key !== key || Object.keys(msg.input).length !== 1) throw new Error("Pi worker lock does not match the authorized operation");
      const release = await workerLock.acquire(key, { signal: turnContext.signal ?? undefined });
      try { live(); } catch (error) { release(); throw error; }
      const lockId = randomUUID(); releases.set(lockId, release); executed(msg).lock = true; return { lockId };
    }
    if (msg.method === "fileObservation") {
      const grant = grants.get(msg.toolCallId);
      const input = grant && JSON.parse(grant.input);
      const phase = msg.input.phase;
      if (env.autonomous || sandbox.profile !== "governed" || !grant || grant.name !== msg.toolName
        || !["read_file", "write_file", "edit_file"].includes(msg.toolName)
        || typeof input.path !== "string" || msg.input.path !== input.path || Object.keys(msg.input).length !== 2
        || !(msg.toolName === "read_file" ? ["read_start", "read_end"] : ["write_check", "write_end"]).includes(phase as string)) {
        throw new Error("Native file observation has no matching granted operation");
      }
      const observed = child.observeFile?.(input.path);
      if (!observed) throw new Error("Native file observation is outside the worker file view");
      if (phase === "read_start") await nativeVersions.beginRead(msg.toolCallId, observed.key, observed.version);
      else if (phase === "read_end") await nativeVersions.finishRead(msg.toolCallId, observed.version, true);
      else if (phase === "write_check") {
        const refusal = nativeVersions.check(observed.key, observed.version);
        if (refusal) throw new Error(refusal);
        await nativeVersions.beginWrite(observed.key);
      } else await nativeVersions.finishWrite(observed.key, observed.version);
      executed(msg).phases.add(phase as string);
      return { ok: true };
    }
    if (msg.method === "syncAuth") {
      // A relayed worker's auth.json is a placeholder; the host refreshes its own store.
      if (hostInference) throw new Error("A relayed pi worker cannot write the host's credential state");
      if (Object.keys(msg.input).length !== 1 || typeof msg.input.content !== "string") throw new Error("Malformed native pi state request");
      syncPiAuth(agentDir, agentFiles["auth.json"], msg.input.content);
      agentFiles["auth.json"] = msg.input.content;
      return { ok: true };
    }
    if (msg.method === "permission") {
      if (!provableTools.has(msg.toolName)) provable = false;
      if (isCompletedAutonomousToolCall(turnContext.autonomous, msg.toolName, msg.input)) {
        return { behavior: "deny", message: "This call already completed before yielding; inspect its retained result instead of replaying it." };
      }
      const application = Object.values(BRAIN_APPLICATION_TOOLS).includes(msg.toolName as any)
        && !(workerSandbox?.profile === "governed" && ["write_file", "edit_file"].includes(msg.toolName));
      if (!turnContext.autonomous && application && !bridge.applyBrain) return { behavior: "deny", message: "No server application route is available in this turn." };
      if (application && bridge.applyBrain) {
        // Exact application authorization belongs to the server route.
        return { behavior: "allow" };
      }
      grants.delete(msg.toolCallId);
      const decision = await decidePiToolPermission({ turn: turnContext, allowedTools, confirmPatterns }, msg.toolName, msg.input, msg.toolCallId);
      live();
      if (decision.behavior === "allow") grants.set(msg.toolCallId, { name: msg.toolName, input: JSON.stringify(decision.updatedInput ?? msg.input) });
      return decision;
    }
    if (msg.method === "bridge") {
      const grant = grants.get(msg.toolCallId);
      grants.delete(msg.toolCallId);
      if (!grant || grant.name !== msg.toolName || grant.input !== JSON.stringify(msg.input)) {
        throw new Error("Pi worker bridge call has no matching server permission decision.");
      }
      const tool = bridgeTools.find(tool => tool.name === msg.toolName);
      if (!tool) throw new Error("Pi worker bridge is outside the turn's capability roster.");
      executed(msg).host = true;
      if (msg.toolName === "request_image_mask") {
        REQUEST_IMAGE_MASK_INPUT_SCHEMA.parse(msg.input);
        if (!bridge.applyImageMask) throw new Error("Hosted masks require the server-owned PNG application route.");
        const context = { ...turnContext, bridge: { ...bridge,
          requestMask: async (path: string, instruction?: string) => {
            live();
            const png = await bridge.requestMask!(path, instruction);
            live();
            return png;
          },
          applyImageMask: async (proposal: Parameters<NonNullable<typeof bridge.applyImageMask>>[0]) => {
            live();
            const result = await bridge.applyImageMask!(proposal);
            applications.set(msg.toolCallId, { name: msg.toolName, input: msg.input, result });
            persist();
            return result;
          },
        } };
        const selected = createPiBridgeTools({ brainPath: backend.brainPath, turn: context, capabilities: env.caps }).find(t => t.name === msg.toolName)!;
        const work = selected.execute(msg.toolCallId, msg.input, turnContext.signal!, undefined, undefined as never);
        turnContext.pendingMutations?.add(work);
        try {
          const output = await work;
          const receipt = applications.get(msg.toolCallId);
          if (receipt && !turnContext.signal?.aborted) { receipt.output = output; persist(); }
          return output;
        } finally { turnContext.pendingMutations?.delete(work); }
      }
      return tool.execute(msg.toolCallId, msg.input, turnContext.signal!, undefined, undefined as never);
    }
    if (msg.method === "readBase") {
      if (msg.toolName !== "brain_read_base" || Object.keys(msg.input).length !== 1 || typeof msg.input.path !== "string") {
        throw new Error("Malformed pi document-base request");
      }
      const grant = grants.get(msg.toolCallId);
      grants.delete(msg.toolCallId);
      // The grant covers the whole tool input (path plus any page range); the
      // server base request carries only its path, which must match exactly.
      if (!grant || grant.name !== "brain_read_base" || grantedReadBasePath(grant.input) !== msg.input.path) {
        throw new Error("Pi document-base request has no matching server permission decision.");
      }
      if (!bridge.readBrainBase) throw new Error("No server document-base reader is available.");
      executed(msg).host = true;
      return bridge.readBrainBase(msg.input.path);
    }
    const input = brainApplicationInput.parse(msg.input);
    if (!bridge.applyBrain) throw new Error("No authoritative server application route is available for this turn.");
    executed(msg).host = true;
    // applyBrain binds the principal and turn on the server, validates exact
    // membership/approvals/aliases and rechecks revocation under its write lock.
    const pending = bridge.applyBrain(input);
    turnContext.pendingMutations?.add(pending);
    try {
      const result = await pending;
      applications.set(msg.toolCallId, { name: BRAIN_APPLICATION_TOOLS[input.operation], input: msg.input, result });
      persist();
      return result;
    }
    finally { turnContext.pendingMutations?.delete(pending); }
  }
  const received = (async () => {
    for await (const raw of pipeMessages(child.stdout)) {
      const msg = piWorkerMessage.parse(raw);
      if (ended) throw new Error("Pi worker sent a message after turn completion");
      if (msg.type === "startup_timing") {
        backend.log?.("debug", "Pi startup phase", { phase: msg.phase, durationMs: msg.durationMs, elapsedMs: performance.now() - startupStarted });
      } else if (msg.type === "ready") {
        backend.log?.("debug", "Pi startup ready", { elapsedMs: performance.now() - startupStarted });
        if (msg.sessionId !== sessionId || initialized || active) throw new Error("Pi worker changed its server session identity");
        initialized = true;
        if (promptContext && msg.append !== undefined) promptContext.retainAppend(msg.append, env.sessionBudgetLimits ? { limits: env.sessionBudgetLimits } : {});
        model = msg.model as Model<any> | undefined;
        cost = msg.cost; thinkingLevel = msg.thinkingLevel as ThinkingLevel; levels = msg.levels as ThinkingLevel[];
        ready.resolve();
      } else if (msg.type === "prompt_prefix") {
        if (!active) throw new Error("Pi worker emitted a prefix outside the turn");
        if (!env.autonomous) {
          try { turnContext.bridge?.activity?.({ kind: "prompt_prefix", prefix: msg.prefix, resumed: Boolean(resumeId) }); }
          catch { /* Observability must not fail the observed turn. */ }
        }
      } else if (msg.type === "rpc") {
        // Do not block reading: a bridge may wait for user input while other
        // sibling calls, cancellation and model frames need to flow.
        void dispatch(msg).then(value => {
          if (!ended) send({ type: "answer", id: msg.id, value });
        }, refusal => {
          const message = refusal instanceof Error ? refusal.message : String(refusal);
          turnContext.bridge?.emit({ type: "error", code: "PI_WORKER_RPC_REFUSED", message, sessionId });
          if (!ended) send({ type: "answer", id: msg.id, error: message });
        }).catch(fail);
      } else if (msg.type === "event") {
        if (!active) throw new Error("Pi worker emitted an event outside the turn");
        if (msg.event.type === "tool_execution_start") {
          if (running.has(msg.event.toolCallId)) provable = false;
          running.add(msg.event.toolCallId);
        }
        if (msg.event.type === "tool_execution_end") {
          reportLimitHits();
          const started = running.delete(msg.event.toolCallId);
          const proven = provable && started ? provenToolExecution(msg.event.toolName, executions.get(msg.event.toolCallId)) : undefined;
          executions.delete(msg.event.toolCallId);
          if (proven) toolExecution?.(msg.event.toolCallId, proven);
          const receipt = applications.get(msg.event.toolCallId);
          if (receipt) {
            msg.event.result = receipt.output ? { content: receipt.output.content.map(part => ({ ...part })), details: receipt.output.details } : { content: [{ type: "text", text: JSON.stringify(receipt.result) }], details: receipt.result };
            msg.event.isError = !receipt.result.ok;
          }
        }
        for (const listener of listeners) listener(msg.event as AgentSessionEvent);
      } else if (msg.type === "snapshot") {
        if (!active) throw new Error("Pi worker sent transcript state outside the turn");
        const header = msg.entries[0];
        if (header?.type !== "session" || header.id !== sessionId || header.cwd !== backend.brainPath) {
          throw new Error("Pi worker sent an invalid transcript identity");
        }
        latestEntries = msg.entries;
        if (ownedPrompt) {
          for (const entry of latestEntries) {
            if (entry.type !== "message" || resumedIds.has(entry.id)) continue;
            const message = entry.message as { role?: string; content?: unknown } | undefined;
            const wire = Array.isArray(message?.content) ? message.content.filter(part => part.type === "text").map(part => part.text).join("") : message?.content;
            // The installed runtime appends image-normalization hints after the
            // exact submitted text. Bind the full observed bytes to this owned
            // turn now; replay never strips a suffix or matches host patterns.
            const delivered = typeof wire === "string" && (wire === ownedPrompt.text
              || ownedPrompt.images && wire.startsWith(ownedPrompt.text + "\n\n"));
            if (message?.role === "user" && delivered && typeof entry.id === "string") {
              promptContext?.acknowledge(ownedPrompt.id, entry.id, wire as string);
              ownedPrompt = undefined;
              break;
            }
          }
        }
        persist();
      } else if (msg.type === "done") {
        if (!active) throw new Error("Pi worker completed an inactive turn");
        // Hits after the last tool step, or in a turn without one, still count.
        reportLimitHits();
        cost = msg.cost; nativeVersions.cancelPending(); ended = true;
        if (msg.error) done.reject(new Error(msg.error)); else done.resolve();
      } else throw msg.errorClass === "session_too_large" ? new SessionTooLargeError() : new BackendRequestError(msg.message);
    }
    if (!ended) throw (await limitEnded()) ?? new Error(`Pi worker exited before completion: ${diagnostic || "protocol closed"}`);
  })().catch(async error => {
    // A worker a limit killed mid-message ends the protocol with a partial
    // message: if the worker is gone, settle the limit before blaming the
    // protocol. A live worker that broke the protocol is stopped at once.
    if (ended) return fail(error);
    const exited = await Promise.race([child.exited.then(() => true, () => true), Bun.sleep(250).then(() => false)]);
    fail((exited ? await limitEnded() : undefined) ?? error);
  });
  void child.exited.then(async code => {
    // The reader sees the worker's last frames first: an error it parsed, or
    // the limit that ended the worker, outranks a generic exit.
    await Promise.race([received, Bun.sleep(1_000)]);
    if (!ended) fail((await limitEnded()) ?? new BackendRequestError(`Pi worker exited (${code}): ${diagnostic}`));
  }).catch(fail);
  // Copy only native state files over the control pipe. No extension code or
  // SDK session is initialized in the privileged process.
  const abortInitialization = () => fail(workerSignal?.reason ?? new DOMException("Pi worker initialization cancelled", "AbortError"));
  workerSignal?.addEventListener("abort", abortInitialization, { once: true });
  try {
    workerSignal?.throwIfAborted();
    send({ ...init, sandboxNote });
    const timeout = setTimeout(() => fail(new BackendRequestError("Pi worker initialization timed out")), 30_000);
    try { await ready.promise; } finally { clearTimeout(timeout); }
  } catch (error) {
    fail(error); await child.exited;
    // A worker that never ran a turn frees its turn temp here, awaited (#2854).
    // A refused close keeps the reservation; the startup error stays the refusal.
    try { await closeTurnTemp(); }
    catch (failure) { try { backend.log?.("warn", `Pi worker turn-temp cleanup was not confirmed after its startup failure: ${String(failure)}`); } catch { /* Reporting cannot replace the startup error. */ } }
    throw error;
  }
  finally { workerSignal?.removeEventListener("abort", abortInitialization); }
  const session: PiSessionLike = {
    ...(resumeId && !restricted ? { stateRoom: admissionObservation } : {}),
    reportsPromptPrefix: true, sessionId, get model() { return model; }, get thinkingLevel() { return thinkingLevel; },
    getAvailableThinkingLevels: () => levels,
    setThinkingLevel(level) { thinkingLevel = level; send({ type: "thinking", level }); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async prompt(text, options) {
      if (options?.streamingBehavior === "followUp") { live(); send({ type: "followUp", text, options }); return; }
      if (error) throw error;
      if (active || ended) throw new Error("Pi worker turn already started or finished");
      active = true;
      prompted = true;
      // The send is inside the lifecycle: an oversized prompt still ends the
      // worker and removes its turn temp.
      const preparedPrompt = promptContext?.prepare(text, {
        device: env.client ? describeClient(env.client) : "Device unknown; hardware probe results are withheld until known.",
        sandbox: sandboxNote,
        capabilities: JSON.stringify({ ...(env.currentCaps ?? env.caps), ...env.currentSurface }),
        ...(env.turnBudgetMs && env.turnBudgetMs > 0 ? { timeout: `The host hard budget for this turn is ${env.turnBudgetMs} ms (about ${Math.round(env.turnBudgetMs / 60000)} minutes); finish inside this cap.` } : {}),
        ...(env.sessionBudgetLimits ? { limits: env.sessionBudgetLimits } : {}),
        ...(env.budgetContext ? { budget: env.budgetContext } : {}),
      });
      ownedPrompt = preparedPrompt ? { ...preparedPrompt, images: Boolean(options?.images?.length) } : undefined;
      try { send({ type: "prompt", text: ownedPrompt?.text ?? text, options }); await done.promise; }
      finally {
        child.stdin.end(); child.kill("SIGKILL");
        try { await child.exited; await received; await promote(); }
        finally { await closeTurnTemp(); }
      }
      if (error) throw error;
    },
    async abort() {
      if (ended) return;
      if (!active) { ended = true; child.kill("SIGKILL"); await child.exited; await closeTurnTemp(); return; }
      send({ type: "abort" });
      const deadline = setTimeout(() => { ended = true; done.resolve(); child.kill("SIGKILL"); }, 1000);
      try { await done.promise.catch(() => {}); }
      finally { clearTimeout(deadline); child.kill("SIGKILL"); await child.exited; }
    },
    getSessionStats: () => ({ cost }),
    dispose() { ended = true; child.stdin.end(); child.kill("SIGKILL"); },
  };
  return { session, turnContext };
}

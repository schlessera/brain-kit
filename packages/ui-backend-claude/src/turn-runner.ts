import { retainNativeRouteInputs } from "./native-route-inputs.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AccountInfo, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { FollowUpRequest, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { assertTurnPosture, BackendBusyError, BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { NativeFileVersions, requireWorkerHostAsync } from "@schlessera/brain-ui-sdk/internal";

import type { ClaudeBackendOptions, BackendLogFn } from "./options.js";
import { getProfile, type InferenceProfile } from "./profiles.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createClaudeSdkTurn, prepareClaudeTurnSandbox, turnEnv } from "./sdk-options.js";
import { StreamAdapter } from "./stream-adapter.js";
import { probeClaudeRuntime } from "./runtime-probe.js";
import type { ActiveTurn, TurnLockBinding } from "./turn-lock.js";
import { createTurnLockBinding } from "./turn-lock.js";
import { createTurnInput, type TurnInput } from "./turn-input.js";
import { DEFAULT_ALLOWED_TOOLS, VOICE_ALLOWED_TOOLS } from "./tool-policy.js";
import { ambientExecConfig } from "./config/env.js";
import { assertClaudeRuntime, claudeRuntimeRequirements } from "./version-requirements.js";
import type { KeyedLock } from "@schlessera/brain-ui-sdk/server";

import { archiveIdleSessions, transcriptPaths } from "./transcript-archive.js";
import { TurnInferenceRelay } from "./turn-inference-relay.js";
import { gatedPrompt, promptGateCheck } from "./turn-prompt-gate.js";
import { reportTurnRuntime, turnActivityReporter, WorkerLimitReporter } from "./turn-reporting.js";
import { runTurnStream } from "./turn-stream.js";
import { TurnFailureEscape, TurnFrames, TurnTerminal } from "./turn-terminal.js";

export { FOLLOW_UP_ACK_GRACE_MS } from "./turn-stream.js";

import type { SessionRetirement } from "@schlessera/brain-ui-sdk/internal";

const BACKEND_ID = "claude";

/** A running turn, with the input stream a follow-up is delivered into. */
interface RunningTurn extends ActiveTurn {
  /**
   * Set once the SDK turn is built, and only for an interactive turn: an
   * autonomous run is not a conversation and never takes a follow-up.
   */
  input?: TurnInput;
}

export interface ClaudeTurnRunner {
  startTurn(req: StartTurnRequest): Promise<void>;
  /** `AgentBackend.followUp`: deliver a message into the session's running turn. */
  followUp(req: FollowUpRequest): Promise<void>;
  /** Drop a retired session's in-memory observation cache once its turns drained (#3229). */
  forget(sessionId: string): void;
}

interface ClaudeTurnRunnerOptions {
  backend: ClaudeBackendOptions;
  resolveProfiles(): InferenceProfile[];
  confirmPatterns: readonly RegExp[];
  writeLock: KeyedLock;
  lockWaitMs: number;
  log: BackendLogFn;
  /** Explicit chat deletion (#3229): a retired session never resumes, and removal waits for its turn. */
  retirement?: Pick<SessionRetirement, "hold" | "isRetired">;
}

/** The runner's state shared by its turns. */
interface TurnRunnerState {
  options: ClaudeTurnRunnerOptions;
  // Busy-ness is PER SESSION: one running turn per session key. Resuming a
  // session that already has a running turn rejects BackendBusyError; a NEW
  // turn (no sessionId yet) gets a unique placeholder key, so two concurrent
  // new-session turns always coexist. The slot is re-keyed to the real session
  // id once the SDK reports it.
  activeTurns: Map<string, RunningTurn>;
  fileVersionsBySession: Map<string, NativeFileVersions>;
  queryFn: typeof query;
}

/** A turn that holds its session's slot and passed admission. */
interface ClaimedTurn {
  req: StartTurnRequest;
  turn: RunningTurn;
  /** The slot's key: a placeholder for a new session until the SDK reports its id. */
  key: string;
  /** The turn's own prompt, set once the SDK turn is built; the input pulls it then. */
  prompt: { value?: string | AsyncIterable<SDKUserMessage> };
  input: TurnInput;
  abortController: AbortController;
  onHostAbort: () => void;
  workerHost: Awaited<ReturnType<typeof requireWorkerHostAsync>>;
  profile: InferenceProfile;
  turnLock: TurnLockBinding;
  turnEnvironment: ReturnType<typeof turnEnv> | undefined;
  observationStorage: { directory: string; brainPath: string } | undefined;
  fileVersions: NativeFileVersions | undefined;
  /** Retirement holds (#3229), released by the turn's last cleanup step. */
  holds: Array<() => void>;
}

export function createClaudeTurnRunner(options: ClaudeTurnRunnerOptions): ClaudeTurnRunner {
  const runner: TurnRunnerState = {
    options,
    activeTurns: new Map(),
    fileVersionsBySession: new Map(),
    queryFn: options.backend.queryFn ?? query,
  };

  async function followUp(req: FollowUpRequest): Promise<void> {
    // Keyed by the real session id only once the SDK reported it, which is
    // also when the host first learns it: a placeholder key never matches.
    const turn = options.retirement?.isRetired(req.sessionId) ? undefined : runner.activeTurns.get(req.sessionId);
    if (!turn?.input?.push(req.prompt, req.attachments)) {
      throw new BackendRequestError(
        `No running turn for session ${req.sessionId} to deliver a follow-up to.`
      );
    }
  }

  return { startTurn: (req) => startTurn(runner, req), followUp,
    forget: (sessionId) => { runner.fileVersionsBySession.delete(sessionId); } };
}

async function startTurn(runner: TurnRunnerState, req: StartTurnRequest): Promise<void> {
  const { options, activeTurns, fileVersionsBySession } = runner;
  // Before anything is claimed or emitted: a refused posture rejects, per
  // the startTurn contract, and leaves no turn behind.
  assertTurnPosture(req, true, true);
  if (req.sessionId !== undefined && activeTurns.has(req.sessionId)) {
    throw new BackendBusyError(BACKEND_ID, req.sessionId);
  }
  // A retired chat refuses resume as an unknown one. The hold lasts until the
  // turn's last copy-out, so a removal never races this turn's native writes.
  const holds: Array<() => void> = [];
  if (req.sessionId !== undefined && options.retirement) holds.push(options.retirement.hold(req.sessionId));
  const releaseHolds = () => { for (const release of holds.splice(0)) release(); };

  // The session is claimed the moment startTurn is called (#1063): a live
  // follow-up offered meanwhile joins this turn's input, which is held until
  // the SDK first pulls the turn's own prompt. Only then is the per-turn
  // host probe awaited, so the event loop keeps answering while a loaded
  // host starts its worker (#2790). Its refusal, or the profile's, rejects
  // and takes the claim back, leaving no turn behind.
  const turn: RunningTurn = { pendingReleases: new Map(), ended: false };
  // Placeholder key for a new session; the real id (a resume's requested id,
  // or the SDK-minted id for a new session) replaces it once reported.
  const turnKey = req.sessionId ?? `new:${crypto.randomUUID()}`;
  const prompt: ClaimedTurn["prompt"] = {};
  const input = createTurnInput(() => {
    if (prompt.value === undefined) throw new Error("The turn's prompt was pulled before it was prepared.");
    return prompt.value;
  });
  if (!req.autonomous) turn.input = input;
  activeTurns.set(turnKey, turn);

  // The host owns cancellation. Mirror its signal onto an internal
  // AbortController that the SDK query listens to; from before the probe,
  // so a cancel accepted while it runs still stops the turn.
  const abortController = new AbortController();
  const onHostAbort = () => abortController.abort();
  if (req.signal.aborted) abortController.abort();
  else req.signal.addEventListener("abort", onHostAbort, { once: true });

  // Everything up to here preceded the claim before it moved forward; a
  // refusal anywhere in it takes the claim back.
  let workerHost: Awaited<ReturnType<typeof requireWorkerHostAsync>>;
  let profile: InferenceProfile;
  let turnLock: TurnLockBinding | undefined;
  let turnEnvironment: ReturnType<typeof turnEnv> | undefined;
  let observationStorage: { directory: string; brainPath: string } | undefined;
  let fileVersions: NativeFileVersions | undefined;
  let yielded = false;
  try {
    workerHost = await requireWorkerHostAsync(options.backend.brainPath);
    profile = resolveProfile(options.resolveProfiles(), req.profileId);
    turnLock = createTurnLockBinding({
      turn,
      writeLock: req.workerLock ?? options.writeLock,
      lockWaitMs: options.lockWaitMs,
      log: options.log,
      admission: {
        signal: abortController.signal,
        priority: req.autonomous ? "autonomous" : "interactive",
        yieldAfterMs: req.autonomous?.yieldAfterMs,
        onYield: req.autonomous?.onYield ? (key) => {
          if (yielded || abortController.signal.aborted) return;
          yielded = true;
          try { req.autonomous!.onYield!(key); }
          catch { req.bridge.emit({ type: "error", code: "AUTONOMOUS_YIELD_FAILED", message: "Autonomous yield checkpoint failed." }); }
          finally { abortController.abort(); }
        } : undefined,
      },
    });
    turnEnvironment = req.autonomous ? undefined : turnEnv(profile);
    observationStorage = !req.autonomous && existsSync(options.backend.brainPath)
      ? { directory: join(transcriptPaths(options.backend.brainPath, turnEnvironment).archive, "native-observations"), brainPath: options.backend.brainPath }
      : undefined;
    fileVersions = req.autonomous ? undefined : fileVersionsBySession.get(turnKey)
      ?? (req.sessionId && observationStorage ? await NativeFileVersions.restore({ ...observationStorage, sessionId: req.sessionId }) : new NativeFileVersions());
    if (fileVersions) fileVersionsBySession.set(turnKey, fileVersions);
  } catch (error) {
    req.signal.removeEventListener("abort", onHostAbort);
    input.close();
    turnLock?.close();
    activeTurns.delete(turnKey);
    releaseHolds();
    throw error;
  }

  // Called, not scheduled: the admitted turn continues in this same task.
  await runAdmittedTurn(runner, { req, turn, key: turnKey, prompt, input, abortController, onHostAbort,
    workerHost, profile, turnLock, turnEnvironment, observationStorage, fileVersions, holds });
}

/** Run an admitted turn to its one terminal frame, then release everything it owns. */
async function runAdmittedTurn(runner: TurnRunnerState, claim: ClaimedTurn): Promise<void> {
  const { options } = runner;
  const { req, profile, abortController, input } = claim;
  const adapter = new StreamAdapter(req.bridge.activity, {
    subscriptionAuth: profile.billing !== "api",
    autonomousUsage: req.autonomous?.containment === "restricted",
    freshRuntimeUsage: req.autonomous?.persistence === "none" && req.sessionId === undefined,
  });
  const reportActivity = turnActivityReporter(req.bridge);
  const reportRuntime = (claudeCodeVersion: string | undefined, apiKeySource: string | undefined, selected: AccountInfo | undefined): void =>
    reportTurnRuntime({ profile, log: options.log, reportActivity }, claudeCodeVersion, apiKeySource, selected);
  const frames = new TurnFrames(req.bridge, req.sessionId ?? null);
  const terminal = new TurnTerminal({ frames, hostSignal: req.signal, abortController, startedAt: Date.now(),
    pendingFailure: () => adapter.pendingFailure() });
  const limits = new WorkerLimitReporter(reportActivity);
  const ackGrace: { timer?: ReturnType<typeof setTimeout> } = {};
  let archiveEnv: Record<string, string | undefined> | undefined;
  let relay: TurnInferenceRelay | undefined;
  const phase = req.sessionId === undefined ? "start before prompt release" : "resume before prompt release";
  const runtimeRequirements = claudeRuntimeRequirements(options.backend.versionRequirements, phase, profile.model);

  try {
    relay = new TurnInferenceRelay({ req, profile, turnEnvironment: claim.turnEnvironment, brainPath: options.backend.brainPath });
    relay.start();
    // A host without governed turns supplies no sandbox: Claude's own is
    // awaited here, from the inputs its options would have used (#2796).
    const own = await prepareClaudeTurnSandbox({ backend: options.backend, req, profile, turnEnvironment: claim.turnEnvironment });
    const sdkTurn = buildSdkTurn(runner, claim, relay, own);
    terminal.worker = { finishWorker: sdkTurn.finishWorker, workerFailure: sdkTurn.workerFailure,
      workerStartFailure: sdkTurn.workerStartFailure };
    frames.stateRoom = sdkTurn.workerStateRoom;
    archiveEnv = sdkTurn.options.env;
    limits.limits = sdkTurn.workerLimits;
    // Always a stream that stays open, so follow-ups can join the turn.
    claim.prompt.value = sdkTurn.prompt;
    let probedVersion: string | undefined;
    if (runtimeRequirements.length) {
      // Replaceable overrides are probed anew for BOTH new and resumed turns,
      // before query() sees any user input. Capture uses the SDK's resolver.
      const report = await probeClaudeRuntime({
        brainPath: options.backend.brainPath,
        ...(options.backend.claudeCodePath !== undefined ? { claudeCodePath: options.backend.claudeCodePath } : {}),
        env: sdkTurn.options.env ?? {}, exec: options.backend.exec ?? ambientExecConfig(),
        versionRequirements: options.backend.versionRequirements, phase,
        signal: abortController.signal, log: options.log,
      });
      probedVersion = report.runtime.version;
      assertClaudeRuntime(probedVersion, runtimeRequirements, phase);
      abortController.signal.throwIfAborted();
    }
    let initialization: ReturnType<Query["initializationResult"]> | undefined;
    const initialize = (cli: Query) => initialization ??= Promise.resolve().then(() => cli.initializationResult());
    // Subscription policy and constrained runtime startup are checked INSIDE
    // the prompt iterable, exactly when the SDK asks for the first message.
    let resolveQuery!: (value: Query) => void;
    const queryHandle = new Promise<Query>((resolve) => {
      resolveQuery = resolve;
    });
    const prompt = sdkTurn.subscriptionOnly || relay.egress || runtimeRequirements.length > 0
      ? gatedPrompt(input.messages, promptGateCheck({ queryHandle, initialize, sdkTurn, relay, terminal, runtimeRequirements,
          phase, abortController, profileId: profile.id, log: options.log, reportActivity, reportRuntime }))
      : input.messages;
    relay.routeInputs = relay.egress ? await retainNativeRouteInputs(req.workerSandbox?.profile === "governed"
      ? options.backend.brainPath : req.workerStartupView ?? options.backend.brainPath) : undefined;
    const result = runner.queryFn({ prompt, options: { ...sdkTurn.options, ...(req.maxBudgetUsd !== undefined ? { maxBudgetUsd: req.maxBudgetUsd } : {}) } });
    resolveQuery(result);
    // The account the CLI selected, for the per-turn report. The SDK answers
    // every call from the one handshake, so this and the gate agree.
    const account = (
      typeof result.initializationResult === "function"
        ? initialize(result).then((init) => init.account, () => undefined)
        : Promise.resolve(undefined)
    ) as Promise<AccountInfo | undefined>;
    await runTurnStream({ stream: result, input, adapter, frames, terminal, req, backendId: BACKEND_ID, profileId: profile.id,
      account, reportActivity, reportRuntime, runtimeRequirements, probedVersion, turnLock: claim.turnLock, limits,
      observeAnswerText: sdkTurn.observeAnswerText, abortController, ackGrace,
      adoptSessionId: (sessionId) => adoptSessionId(runner, claim, sessionId) });
  } catch (caught) {
    if (caught instanceof TurnFailureEscape) throw caught.cause;
    await terminal.fail(caught, limits);
  } finally {
    // A failed cleanup cannot strand the other owned resources or busy slot.
    await cleanupTurn(turnCleanup(runner, claim, { terminal, frames, relay, ackGrace, archiveEnv }));
  }
}

/** The SDK turn, from the claimed turn and its relay. */
function buildSdkTurn(runner: TurnRunnerState, claim: ClaimedTurn, relay: TurnInferenceRelay,
  own: Awaited<ReturnType<typeof prepareClaudeTurnSandbox>>): ReturnType<typeof createClaudeSdkTurn> {
  const { options } = runner;
  const { req, profile, workerHost } = claim;
  const egress = relay.egress;
  // A voice turn selects the named voice posture in place of the profile's
  // ordinary list (docs/decisions/voice-permission.md "The voice posture").
  const allowedTools =
    req.autonomous?.allowedTools ??
    (req.posture === "voice" ? VOICE_ALLOWED_TOOLS : undefined) ??
    profile.allowedTools ?? options.backend.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  return createClaudeSdkTurn({
    ...(egress ? { hostInference: { proxyDir: egress.dir, baseUrl: relay.baseUrl,
      ...(relay.apiCredential ? { placeholders: relay.apiCredential.placeholders } : {}) } } : {}),
    backend: options.backend,
    ...(workerHost?.identity === "separate_uid" && workerHost.workerUid !== undefined ? { identity: { kind: "separate_uid" as const, workerUid: workerHost.workerUid } } : {}),
    turnEnvironment: own?.turnEnvironment ?? claim.turnEnvironment,
    fileVersions: claim.fileVersions,
    req: { ...req, signal: claim.abortController.signal, ...(own ? { workerSandbox: own.workerSandbox } : {}), ...(egress && req.workerSandbox ? { workerSandbox: { ...req.workerSandbox,
      // The relay holds the login: hide the host's file wherever the host masks do not.
      maskPaths: [...req.workerSandbox.maskPaths ?? [], ...relay.hostLogin?.mask ?? []] } } : {}) },
    profile,
    abortController: claim.abortController,
    allowedTools,
    confirmPatterns: options.confirmPatterns,
    turnLock: claim.turnLock,
    log: options.log,
  });
}

/**
 * A new session's SDK-minted id: re-key the busy slot from its placeholder,
 * so a resume of this session while it still runs is detected as busy.
 */
function adoptSessionId(runner: TurnRunnerState, claim: ClaimedTurn, sessionId: string): void {
  const { fileVersions, observationStorage } = claim;
  // Saved off the event loop (#2416) and queued before any tool's
  // observation save, which each native tool awaits. A failure
  // refuses native writes until a later save succeeds.
  if (fileVersions && observationStorage) fileVersions.retain({ ...observationStorage, sessionId })
    .catch(error => runner.options.log("warn", "Claude native file observations could not be retained", { error: String(error) }));
  if (fileVersions) { runner.fileVersionsBySession.delete(claim.key); runner.fileVersionsBySession.set(sessionId, fileVersions); }
  runner.activeTurns.delete(claim.key);
  runner.activeTurns.set(sessionId, claim.turn);
  claim.key = sessionId;
  // A freshly minted identity was never retired; hold it like a resumed one.
  if (runner.options.retirement) claim.holds.push(runner.options.retirement.hold(sessionId));
}

/** Everything a turn owns, released in order whatever its outcome. */
function turnCleanup(runner: TurnRunnerState, claim: ClaimedTurn, owned: {
  terminal: TurnTerminal; frames: TurnFrames; relay: TurnInferenceRelay | undefined;
  ackGrace: { timer?: ReturnType<typeof setTimeout> }; archiveEnv: Record<string, string | undefined> | undefined;
}): Array<() => unknown> {
  const { options, activeTurns, fileVersionsBySession } = runner;
  const { req, input, fileVersions } = claim;
  return [
    () => owned.terminal.worker.finishWorker?.(),
    () => owned.relay?.routeInputs?.close(),
    () => owned.relay?.stop(),
    () => owned.relay?.unlink(),
    () => clearTimeout(owned.ackGrace.timer),
    // Every turn's input, autonomous or not, so cleanup always ends it.
    () => input.close(),
    () => req.signal.removeEventListener("abort", claim.onHostAbort),
    // The new session's retain is not awaited where it is queued; the
    // turn still settles only after every observation save has.
    () => fileVersions?.settled(),
    () => fileVersions?.cancelPending(),
    () => { if (!owned.frames.sessionId) fileVersionsBySession.delete(claim.key); },
    () => claim.turnLock.close(),
    () => activeTurns.delete(claim.key),
    () => req.autonomous ? undefined : archiveIdleSessions({
      brainPath: options.backend.brainPath, env: owned.archiveEnv,
      listSessionsFn: options.backend.listSessionsFn,
      activeSessionIds: () => new Set(activeTurns.keys()),
      log: (message, error) => options.log("warn", message, { error: String(error) }),
    }),
    () => { for (const release of claim.holds.splice(0)) release(); },
  ];
}

async function cleanupTurn(actions: Array<() => unknown>): Promise<void> {
  const failures: unknown[] = [];
  for (const action of actions) { try { await action(); } catch (error) { failures.push(error); } }
  if (failures.length) throw new AggregateError(failures, "Claude turn cleanup did not complete");
}

function resolveProfile(
  profiles: InferenceProfile[],
  profileId: string | undefined
): InferenceProfile {
  // profileId is only meaningful for new sessions; resumed sessions are pinned
  // host-side and pass their original id back through. Undefined = default.
  if (profileId === undefined) return profiles[0]!;
  const profile = getProfile(profiles, profileId);
  if (!profile) throw new BackendRequestError(`Unknown profile id: ${profileId}`);
  return profile;
}

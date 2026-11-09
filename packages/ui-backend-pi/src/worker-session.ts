import { sessionPromptContext, describeClient, NativeFileVersions, workerExecHelpers } from "@schlessera/brain-ui-sdk/internal";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { BackendRequestError, compileConfirmPatterns, DEFAULT_CONFIRM_BASH_PATTERNS } from "@schlessera/brain-ui-sdk/server";

import { piRelayOrigin } from "./host-inference.js";
import type { CreatePiBackendOptions, PiSessionLike, SessionEnv } from "./backend-options.js";
import { resolveModelSpec, toModel } from "./profiles.js";
import { createTurnContext } from "./turn-context.js";
import { createPiBridgeTools } from "./bridge-tools.js";
import { DEFAULT_PI_ALLOWED_TOOLS } from "./tools.js";
import { ambientExecConfig } from "./config/env.js";
import { readPiSession, piSessionDirectory } from "./session-storage.js";
import { admitPiWorker, launchPiWorker, savedModel, superviseWorker } from "./worker-launch.js";
import { readPiWorkerProtocol, type PiWorkerTurnState } from "./worker-reader.js";
import { createPiWorkerReceipts } from "./worker-receipts.js";
import { createPiWorkerRpcDispatcher, type PiWorkerRpc } from "./worker-rpc.js";
import { discoversPiExtensions } from "./extension-inspection.js";

export { savedModel } from "./worker-launch.js";

/** What the host saw one call do: the RPCs it made, under the name it ran as (#2834). */
export type CallExecution = { name: string; host: boolean; lock: boolean; phases: Set<string> };
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
  const receipts = createPiWorkerReceipts({ sessionDir, brainPath: backend.brainPath, sessionId, autonomous: Boolean(env.autonomous), entries, resumedIds,
    turn: turnContext, backend });
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const state: PiWorkerTurnState = { active: false, initialized: false, ended: false, error: undefined, cost: 0,
    thinkingLevel: undefined, levels: [], model: undefined, ownedPrompt: undefined };
  const ready = Promise.withResolvers<void>();
  const done = Promise.withResolvers<void>();
  // A rejection before prompt has no waiter yet; still retain it for prompt.
  void done.promise.catch(() => {});
  void ready.promise.catch(() => {});
  const admission = await admitPiWorker({ backend, env, declared, restricted, entries, resumeId, sessionId, profileId, promptContext, exec });
  const { agentDir, agentFiles, envelope, hostInference, reservation, admissionObservation } = admission;
  const { workerSandbox, workerLock, workerSignal, toolExecution } = admission.hostEnv;
  const { child, sandbox, sandboxNote, turnTemp } = await launchPiWorker({ backend, env, admission, restricted, resumeId, execHelpers, confirmPatterns,
    startupStarted, turnContext });
  const { closeTurnTemp, releases, claimTurnTempClose, diagnostic, reportLimitHits, limitEnded, send, stdioReleased } = superviseWorker({ child, reservation,
    turnTemp, env, turnContext, admission, answerText: () => receipts.answerText() });
  function live(): void {
    if (!state.active || state.ended || !turnContext.bridge || !turnContext.signal || turnContext.signal.aborted) {
      throw new Error("Pi worker RPC refused: turn is inactive, cancelled or revoked.");
    }
  }
  function fail(reason: unknown): void {
    // The first failure is the turn's: a later path cannot reclassify it.
    if (state.error) return;
    state.error = reason instanceof Error ? reason : new Error(String(reason));
    nativeVersions.cancelPending();
    state.ended = true;
    ready.reject(state.error); done.reject(state.error);
    child.kill("SIGKILL");
  }
  // Extension code runs on every tool event and can write at any time (#2834):
  // only a worker that loads none can prove a call's execution path. Proof
  // also ends, for the worker's lifetime, once it admits a call that can run
  // other code (bash, grep, brain-owned configuration through an index tool,
  // an application tool) or starts a call under a running call's identity:
  // from then on the worker's own reports are no evidence.
  const extensionFree = envelope !== undefined || !discoversPiExtensions(backend);
  const proof = createExecutionProof(extensionFree, new Set(["read_file", "write_file", "edit_file", "brain_read_base", ...bridgeTools.map(tool => tool.name)]));
  const dispatch = createPiWorkerRpcDispatcher({ brainPath: backend.brainPath, turn: turnContext, live, grants, releases, workerLock,
    executed: proof.executed, admitTool: proof.admit, canFinalizeSafety: proof.canFinalize, autonomous: Boolean(env.autonomous), sandbox, workerSandbox,
    observeFile: path => child.observeFile?.(path), nativeVersions, relayed: Boolean(hostInference), agentDir, agentFiles, allowedTools,
    confirmPatterns, bridgeTools, capabilities: env.caps, receipts });
  const received = readPiWorkerProtocol({ child, state, ready, done, sessionId, backend, startupStarted, promptContext,
    sessionBudgetLimits: env.sessionBudgetLimits, autonomous: Boolean(env.autonomous), resumed: Boolean(resumeId), turnContext, nativeVersions,
    receipts, resumedIds, listeners, proof, toolExecution, dispatch, send, fail, reportLimitHits, limitEnded, diagnostic }).catch(async error => {
    // A worker a limit killed mid-message ends the protocol with a partial
    // message: if the worker is gone, settle the limit before blaming the
    // protocol. A live worker that broke the protocol is stopped at once.
    if (state.ended) return fail(error);
    const exited = await Promise.race([child.exited.then(() => true, () => true), Bun.sleep(250).then(() => false)]);
    fail((exited ? await limitEnded() : undefined) ?? error);
  });
  void child.exited.then(async code => {
    // The reader sees the worker's last frames first: an error it parsed, or
    // the limit that ended the worker, outranks a generic exit.
    await Promise.race([received, Bun.sleep(1_000)]);
    if (!state.ended) fail((await limitEnded()) ?? new BackendRequestError(`Pi worker exited (${code}): ${diagnostic()}`));
  }).catch(fail);
  // Copy only native state files over the control pipe. No extension code or
  // SDK session is initialized in the privileged process.
  const abortInitialization = () => fail(workerSignal?.reason ?? new DOMException("Pi worker initialization cancelled", "AbortError"));
  workerSignal?.addEventListener("abort", abortInitialization, { once: true });
  try {
    workerSignal?.throwIfAborted();
    send({ ...admission.init, sandboxNote });
    const timeout = setTimeout(() => fail(new BackendRequestError("Pi worker initialization timed out")), 30_000);
    try { await ready.promise; } finally { clearTimeout(timeout); }
  } catch (error) {
    claimTurnTempClose(); fail(error);
    try { await child.exited; } finally { await stdioReleased(); }
    // A worker that never ran a turn frees its turn temp here, awaited (#2854).
    // A refused close keeps the reservation; the startup error stays the refusal.
    try { await closeTurnTemp(); }
    catch (failure) { try { backend.log?.("warn", `Pi worker turn-temp cleanup was not confirmed after its startup failure: ${String(failure)}`); } catch { /* Reporting cannot replace the startup error. */ } }
    throw error;
  }
  finally { workerSignal?.removeEventListener("abort", abortInitialization); }
  let aborting: Promise<void> | undefined;
  const session: PiSessionLike = {
    ...(resumeId && !restricted ? { stateRoom: admissionObservation } : {}),
    reportsPromptPrefix: true, sessionId, get model() { return state.model; }, get thinkingLevel() { return state.thinkingLevel; },
    getAvailableThinkingLevels: () => state.levels,
    setThinkingLevel(level) { state.thinkingLevel = level; send({ type: "thinking", level }); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async prompt(text, options) {
      if (options?.streamingBehavior === "followUp") { live(); send({ type: "followUp", text, options }); return; }
      if (state.error) throw state.error;
      if (state.active || state.ended) throw new Error("Pi worker turn already started or finished");
      state.active = true;
      claimTurnTempClose();
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
      state.ownedPrompt = preparedPrompt ? { ...preparedPrompt, images: Boolean(options?.images?.length) } : undefined;
      try { send({ type: "prompt", text: state.ownedPrompt?.text ?? text, options }); await done.promise; }
      finally {
        child.stdin.end(); child.kill("SIGKILL");
        try { await child.exited; await received; await receipts.promote({ turnTemp, sandbox, closeTurnTemp }); }
        finally { try { await closeTurnTemp(); } finally { await stdioReleased(); } }
      }
      if (state.error) throw state.error;
    },
    abort() {
      // `ended` revokes work; it does not confirm teardown. The signal handler
      // and the runner must join even if the first abort already set it (#2880).
      return aborting ??= (async () => {
        if (!state.active) {
          state.ended = true; claimTurnTempClose(); child.stdin.end(); child.kill("SIGKILL");
          try { await child.exited; await received; }
          finally { try { await closeTurnTemp(); } finally { await stdioReleased(); } }
          return;
        }
        if (state.ended) return;
        send({ type: "abort" });
        const deadline = setTimeout(() => { state.ended = true; done.resolve(); child.kill("SIGKILL"); }, 1000);
        try { await done.promise.catch(() => {}); }
        finally { clearTimeout(deadline); child.kill("SIGKILL"); await child.exited; }
      })().catch((error: unknown) => { aborting = undefined; throw error; });
    },
    getSessionStats: () => ({ cost: state.cost }),
    dispose() { state.ended = true; child.stdin.end(); child.kill("SIGKILL"); },
  };
  return { session, turnContext };
}

/**
 * The host's execution proof for one worker (#2834): which tool each call ran
 * as and which RPCs it made. Proof ends, for the worker's lifetime, once it
 * admits a tool outside the provable set or starts a call under a running
 * call's identity.
 */
function createExecutionProof(extensionFree: boolean, provableTools: ReadonlySet<string>) {
  let provable = extensionFree;
  const running = new Set<string>();
  const executions = new Map<string, CallExecution>();
  return {
    executed: (msg: PiWorkerRpc): CallExecution => {
      let seen = executions.get(msg.toolCallId);
      if (!seen) executions.set(msg.toolCallId, seen = { name: msg.toolName, host: false, lock: false, phases: new Set() });
      // A call that names two tools proves neither.
      else if (seen.name !== msg.toolName) seen.name = "";
      return seen;
    },
    canFinalize: (toolName:string,toolCallId:string):boolean => provable&&running.has(toolCallId)&&provenToolExecution(toolName,executions.get(toolCallId))!==undefined,
    admit: (toolName: string): void => { if (!provableTools.has(toolName)) provable = false; },
    started: (toolCallId: string): void => {
      if (running.has(toolCallId)) provable = false;
      running.add(toolCallId);
    },
    ended: (toolName: string, toolCallId: string): ReturnType<typeof provenToolExecution> => {
      const started = running.delete(toolCallId);
      const proven = provable && started ? provenToolExecution(toolName, executions.get(toolCallId)) : undefined;
      executions.delete(toolCallId);
      return proven;
    },
  };
}

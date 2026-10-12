import { safeResolve } from "@schlessera/brain/internal";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stateRoomCopy, stateRoomWarning, type StateRoomObservation } from "@schlessera/brain-ui-sdk/protocol";
import { getAgentDir, SessionManager, CURRENT_SESSION_VERSION, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { BackendRequestError, BRAIN_APPLICATION_TOOLS, brainApplicationInput, brainReadBaseInput, type BrainApplicationResult,
  compileConfirmPatterns, DEFAULT_CONFIRM_BASH_PATTERNS, isCompletedAutonomousToolCall } from "@schlessera/brain-ui-sdk/server";
import { bashLockKey, BRAIN_LOCK_KEY } from "@schlessera/brain-ui-sdk/server";
import { workerOutwardNote, workerCommandPolicyNote, createLimitTracker, createTurnTempPromoter, launchAgentWorker, launchLimits, prepareWorkerSandbox, processStateLedger,
  outputStagingLimit, requireWorkerHost, resolveTurnTempLimits, restrictedReadPaths, turnTempLimit, workerNoteLimits, WorkerResourceLimitError,
  workerSandboxNote, workerSandboxWarnings, WORKER_SCRATCH, WORKER_XDG_DIRS, type Reservation, type WorkerSandbox,
  type WorkerStateHandle } from "@schlessera/brain-ui-sdk/internal";

import { decidePiToolPermission } from "./permission-gate.js";
import { piAutonomousEnvelope } from "./autonomous-envelope.js";
import type { CreatePiBackendOptions, PiSessionLike, SessionEnv } from "./backend-options.js";
import { configuredProfiles, resolveModelSpec, toModel } from "./profiles.js";
import { createTurnContext } from "./turn-context.js";
import { createPiBridgeTools, REQUEST_IMAGE_MASK_INPUT_SCHEMA } from "./bridge-tools.js";
import { DEFAULT_PI_ALLOWED_TOOLS } from "./tools.js";
import { subprocessEnv } from "./config/env.js";
import { savePiSession, readPiSession, piSessionDirectory, syncPiAuth } from "./session-storage.js";
import { checkSessionSize, PI_WORKER_STATE, SessionTooLargeError, pipeMessages, sendPipe, piWorkerMessage, type PiWorkerMessage } from "./worker-protocol.js";

type Rpc = Extract<PiWorkerMessage, { type: "rpc" }>;
/** The path a granted brain_read_base input names; undefined unless it is a valid input. */
function grantedReadBasePath(granted: string): string | undefined {
  try { const parsed = brainReadBaseInput.safeParse(JSON.parse(granted)); return parsed.success ? parsed.data.path : undefined; }
  catch { return undefined; }
}
export async function openPiWorkerSession(backend: CreatePiBackendOptions, sessionDir: string,
  env: SessionEnv, profileId?: string, resumeId?: string) {
  const declared = resumeId ? undefined : toModel(resolveModelSpec(backend, profileId));
  const restricted = env.autonomous?.containment === "restricted";
  const infos = resumeId ? await SessionManager.list(backend.brainPath, sessionDir) : [];
  const info = infos.find(i => i.id === resumeId);
  if (resumeId && !info) throw new BackendRequestError(`Cannot resume unknown session: ${resumeId}`);
  const sessionId = resumeId ?? randomUUID();
  const entries = info ? readPiSession(info.path) : undefined;
  /** Entries saved before this turn: their answers were promoted, if at all, by their own turn. */
  const resumedIds = new Set((entries ?? []).map(entry => (entry as { id?: unknown }).id));
  const turnContext = createTurnContext();
  const allowedTools = new Set(env.autonomous?.allowedTools ?? backend.allowedTools ?? DEFAULT_PI_ALLOWED_TOOLS);
  const confirmPatterns = compileConfirmPatterns(backend.confirmBashPatterns ?? DEFAULT_CONFIRM_BASH_PATTERNS, () => {});
  const bridgeTools = createPiBridgeTools({ brainPath: backend.brainPath, turn: turnContext, capabilities: env.caps });
  const grants = new Map<string, { name: string; input: string }>();
  const applications = new Map<string, { name: string; input: Record<string, unknown>; result: BrainApplicationResult; output?: Awaited<ReturnType<(typeof bridgeTools)[number]["execute"]>> }>();
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
  const agentFiles: Record<string, string> = {};
  const agentDir = piSessionDirectory(backend.brainPath, getAgentDir());
  // A restricted autonomous turn copies no native state into the worker: no
  // stored login, provider override or settings (#676). The relay holds the key.
  const envelope = restricted ? piAutonomousEnvelope(declared, agentDir) : undefined;
  if (!envelope) for (const name of ["auth.json", "models.json", "settings.json"]) {
    const path = join(agentDir, name);
    if (existsSync(path)) agentFiles[name] = readFileSync(path, "utf8");
  }
  const { workerSandbox, workerLock, ...workerSessionEnv } = env;
  const init = { type: "init", governed: workerSandbox?.profile === "governed", sharedLock: Boolean(workerLock), backend: { brainPath: backend.brainPath, profiles: configuredProfiles(backend), model: backend.model,
    loadExtensions: envelope ? false : backend.loadExtensions, systemPromptAppend: backend.systemPromptAppend }, env: workerSessionEnv, sessionId,
    resume: Boolean(resumeId), entries, profileId, agentFiles, ...(envelope ? { inference: envelope.inference } : {}) };
  // Every worker's /tmp is a private tmpfs of exactly this allowance, which
  // holds the worker's session state too (#1703).
  const turnTempLimits = resolveTurnTempLimits({ ...backend.turnTemp,
    names: { allowance: "turnTemp.allowanceBytes", budget: "turnTemp.budgetBytes" } });
  let reservation: Reservation | undefined;
  let admissionObservation: StateRoomObservation;
  try {
    admissionObservation = checkSessionSize(init);
    requireWorkerHost(backend.brainPath, { restricted, turnTempBytes: turnTempLimits.allowanceBytes });
    // Admitted against the same per-process ledger as Claude workers; a busy
    // budget refuses as worker_state_busy before anything launches.
    reservation = processStateLedger().reserve(undefined, turnTempLimits);
  } catch (error) { envelope?.relay.stop(); throw error; }
  const entry = Bun.resolveSync("./worker-entry", import.meta.dir);
  const workerEnv: Record<string, string> = envelope
    // The restricted envelope: minimum runtime variables only, the installed
    // runtime as the explicit read envelope, and the relay as the one route out.
    ? { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: WORKER_SCRATCH, BRAIN_ROOT: backend.brainPath }
    : { ...Object.fromEntries(Object.entries(subprocessEnv()).filter((pair): pair is [string, string] => pair[1] !== undefined)), BRAIN_ROOT: backend.brainPath };
  let child: ReturnType<typeof launchAgentWorker>;
  let sandboxNote: string;
  let sandbox: WorkerSandbox;
  // The worker's private /tmp, through the descriptor the server holds, so
  // what the answer links there can be promoted once the worker has exited
  // (#1655). An autonomous turn saves no answer.
  let turnTemp: WorkerStateHandle | undefined;
  try {
    // One resolution feeds the worker's mounts and the note its agent reads (#1626),
    // and one its resource limits and the note's limits section (#1660).
    sandbox = envelope ? prepareWorkerSandbox(backend.brainPath, { restricted: true, maintenance: backend.maintenance })
      : workerSandbox ?? prepareWorkerSandbox(backend.brainPath, { home: workerEnv.HOME, maintenance: backend.maintenance });
    const limits = launchLimits({});
    sandboxNote = [workerSandboxNote(sandbox, { limits: [...workerNoteLimits(limits.status),
      turnTempLimit(reservation.turnTempBytes, env.caps.turnTemp === true ? "turn_temp" : undefined),
    outputStagingLimit()] }), workerCommandPolicyNote(env.autonomous ? undefined : sandbox.commandPolicy, confirmPatterns), env.autonomous ? "" : workerOutwardNote()].filter(Boolean).join("\n\n");
    if (resumeId && !restricted && stateRoomWarning(admissionObservation)) {
      sandboxNote += `\n\n${stateRoomCopy(admissionObservation)} Continue in a new conversation before it is full. This one stays available.`;
    }
    for (const warning of workerSandboxWarnings(sandbox)) backend.log?.("warn", warning);
    child = launchAgentWorker({ brainPath: backend.brainPath, turnTempBytes: reservation.turnTempBytes,
      command: [process.execPath, entry], env: workerEnv, sandbox, limits, ...(workerLock ? { outputLock: workerLock } : {}),
      ...(envelope ? { restricted: { readPaths: restrictedReadPaths([entry]), inferenceDir: envelope.relay.dir } } : {}),
    });
    turnTemp = child.turnTemp;
    turnContext.configurationRoot = child.configurationRoot;
  } catch (error) { envelope?.relay.stop(); reservation.release(); throw error; }
  const held = reservation;
  /** Frees the worker's turn temp: the tmpfs goes once the worker is gone and this descriptor is closed. */
  const closeTurnTemp = () => { try { turnTemp?.close(); } finally { held.release(); } };
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
  const releases = new Map<string, () => void>();
  void child.exited.finally(() => { for (const release of releases.values()) release(); releases.clear(); }).catch(() => {});
  // A worker that never ran a turn has nothing to promote; one that did is
  // cleaned up by `promote` once its answer has been read.
  let prompted = false;
  void child.exited.finally(() => { if (!prompted) closeTurnTemp(); }).catch(() => {});
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
    ended = true;
    ready.reject(error); done.reject(error);
    child.kill("SIGKILL");
  }
  function persist(): void {
    if (env.autonomous || !applications.size && !latestEntries.some(entry => entry.type === "message")) return;
    const saved: Record<string, unknown>[] = latestEntries.length ? structuredClone(latestEntries) : [{ type: "session", version: CURRENT_SESSION_VERSION,
      id: sessionId, cwd: backend.brainPath, timestamp: new Date().toISOString() }];
    const append = (message: Record<string, unknown>) => saved.push({ type: "message", id: randomUUID(),
      parentId: saved.slice(1).at(-1)?.id ?? null, timestamp: new Date().toISOString(), message });
    for (const [id, receipt] of applications) {
      if (!saved.some(entry => entry.type === "message" && (entry.message as any)?.role === "assistant"
        && (entry.message as any).content.some((part: any) => part.type === "toolCall" && part.id === id))) {
        // A direct authorized proposal may have no runtime transcript call.
        // Record the actual server effect instead of depending on worker history.
        append({ role: "assistant", content: [{ type: "toolCall", id, name: receipt.name, arguments: receipt.input }],
          api: model?.api ?? "server-application", provider: model?.provider ?? "server", model: model?.id ?? "server-application",
          stopReason: "toolUse", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      }
      const result = { role: "toolResult", toolCallId: id, toolName: receipt.name,
        content: receipt.output?.content ?? [{ type: "text", text: JSON.stringify(receipt.result) }], isError: !receipt.result.ok, timestamp: Date.now() };
      const prior = saved.find(entry => entry.type === "message" && (entry.message as any)?.role === "toolResult" && (entry.message as any).toolCallId === id);
      if (prior) prior.message = result;
      else {
        // A committed server effect survives cancellation before the runtime
        // can append its own tool result. Later worker snapshots cannot erase it.
        append(result);
      }
    }
    savePiSession(sessionDir, sessionId, saved);
  }
  /**
   * Once the worker has exited, copies what this turn's answers link in turn
   * temp into scratch, saves the answers linking the copies, and reports each
   * linked file to the host (#1655). Turn temp is removed either way.
   */
  function promote(): void {
    if (!turnTemp || env.autonomous) { closeTurnTemp(); return; }
    try {
      const promoter = createTurnTempPromoter({ brain: sandbox.brain, tmp: turnTemp.root, turnId: turnContext.turnId, scratch: WORKER_SCRATCH,
        exclude: [PI_WORKER_STATE], scratchWritable: sandbox.areas.some(area => area.name === "scratch" && area.mount.writable) });
      let changed = false;
      for (const entry of latestEntries) {
        if (entry.type !== "message" || resumedIds.has(entry.id)) continue;
        const message = entry.message as { role?: unknown; content?: unknown } | undefined;
        if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const part of message.content as Array<{ type?: unknown; text?: unknown }>) {
          if (part?.type !== "text" || typeof part.text !== "string") continue;
          const next = promoter.rewrite(part.text);
          if (next !== part.text) { part.text = next; changed = true; }
        }
      }
      if (changed) persist();
      for (const record of promoter.records) {
        try { turnContext.bridge?.activity?.(record); } catch { /* Observability must not fail the observed turn. */ }
      }
    } catch (failure) {
      backend.log?.("warn", `promoting linked turn-temp files failed: ${failure instanceof Error ? failure.message : String(failure)}`);
    } finally { closeTurnTemp(); }
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
      const lockId = randomUUID(); releases.set(lockId, release); return { lockId };
    }
    if (msg.method === "syncAuth") {
      if (Object.keys(msg.input).length !== 1 || typeof msg.input.content !== "string") throw new Error("Malformed native pi state request");
      syncPiAuth(agentDir, agentFiles["auth.json"], msg.input.content);
      agentFiles["auth.json"] = msg.input.content;
      return { ok: true };
    }
    if (msg.method === "permission") {
      if (isCompletedAutonomousToolCall(turnContext.autonomous, msg.toolName, msg.input)) {
        return { behavior: "deny", message: "This call already completed before yielding; inspect its retained result instead of replaying it." };
      }
      if (bridge.applyBrain && Object.values(BRAIN_APPLICATION_TOOLS).includes(msg.toolName as any)
        && !(workerSandbox?.profile === "governed" && ["write_file", "edit_file"].includes(msg.toolName))) {
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
      return bridge.readBrainBase(msg.input.path);
    }
    const input = brainApplicationInput.parse(msg.input);
    if (!bridge.applyBrain) throw new Error("No authoritative server application route is available for this turn.");
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
      if (msg.type === "ready") {
        if (msg.sessionId !== sessionId || initialized || active) throw new Error("Pi worker changed its server session identity");
        initialized = true;
        model = msg.model as Model<any> | undefined;
        cost = msg.cost; thinkingLevel = msg.thinkingLevel as ThinkingLevel; levels = msg.levels as ThinkingLevel[];
        ready.resolve();
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
        if (msg.event.type === "tool_execution_end") {
          reportLimitHits();
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
        persist();
      } else if (msg.type === "done") {
        if (!active) throw new Error("Pi worker completed an inactive turn");
        // Hits after the last tool step, or in a turn without one, still count.
        reportLimitHits();
        cost = msg.cost; ended = true;
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
  try {
    send({ ...init, sandboxNote });
    const timeout = setTimeout(() => fail(new BackendRequestError("Pi worker initialization timed out")), 30_000);
    try { await ready.promise; } finally { clearTimeout(timeout); }
  } catch (error) { fail(error); await child.exited; throw error; }
  const session: PiSessionLike = {
    ...(resumeId && !restricted ? { stateRoom: admissionObservation } : {}),
    sessionId, get model() { return model; }, get thinkingLevel() { return thinkingLevel; },
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
      try { send({ type: "prompt", text, options }); await done.promise; }
      finally {
        child.stdin.end(); child.kill("SIGKILL");
        try { await child.exited; } finally { await received; promote(); }
      }
      if (error) throw error;
    },
    async abort() {
      if (ended) return;
      if (!active) { ended = true; child.kill("SIGKILL"); await child.exited; return; }
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

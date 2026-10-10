import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, SessionManager, CURRENT_SESSION_VERSION, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { BackendRequestError, BRAIN_APPLICATION_TOOLS, brainApplicationInput, type BrainApplicationResult,
  createToolPermissionRequest, decideToolPermission, requestToolPermission, checkEditedApproval,
  compileConfirmPatterns, DEFAULT_CONFIRM_BASH_PATTERNS, isCompletedAutonomousToolCall } from "@schlessera/brain-ui-sdk/server";
import { launchAgentWorker, requireWorkerHost } from "@schlessera/brain-ui-sdk/internal";
import type { CreatePiBackendOptions, PiSessionLike, SessionEnv } from "./backend-options.js";
import { configuredProfiles, resolveModelSpec, toModel } from "./profiles.js";
import { createTurnContext } from "./turn-context.js";
import { createPiBridgeTools, REQUEST_IMAGE_MASK_INPUT_SCHEMA } from "./bridge-tools.js";
import { DEFAULT_PI_ALLOWED_TOOLS } from "./tools.js";
import { subprocessEnv } from "./config/env.js";
import { savePiSession, readPiSession, piSessionDirectory, syncPiAuth } from "./session-storage.js";
import { pipeMessages, sendPipe, piWorkerMessage, type PiWorkerMessage } from "./worker-protocol.js";

type Rpc = Extract<PiWorkerMessage, { type: "rpc" }>;
export async function openPiWorkerSession(backend: CreatePiBackendOptions, sessionDir: string,
  env: SessionEnv, profileId?: string, resumeId?: string) {
  if (!resumeId) toModel(resolveModelSpec(backend, profileId));
  requireWorkerHost(backend.brainPath);
  const infos = resumeId ? await SessionManager.list(backend.brainPath, sessionDir) : [];
  const info = infos.find(i => i.id === resumeId);
  if (resumeId && !info) throw new BackendRequestError(`Cannot resume unknown session: ${resumeId}`);
  const sessionId = resumeId ?? randomUUID();
  const entries = info ? readPiSession(info.path) : undefined;
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
  for (const name of ["auth.json", "models.json", "settings.json"]) {
    const path = join(agentDir, name);
    if (existsSync(path)) agentFiles[name] = readFileSync(path, "utf8");
  }
  const child = launchAgentWorker({ brainPath: backend.brainPath,
    command: [process.execPath, Bun.resolveSync("./worker-entry", import.meta.dir)],
    env: { ...Object.fromEntries(Object.entries(subprocessEnv()).filter((pair): pair is [string, string] => pair[1] !== undefined)), BRAIN_ROOT: backend.brainPath },
  });
  child.stdin.on("error", () => {});
  let diagnostic = "";
  child.stderr.on("data", bytes => { diagnostic = (diagnostic + String(bytes)).slice(-4000); });
  const send = (value: unknown) => sendPipe(child.stdin, value);
  function live(): void {
    if (!active || ended || !turnContext.bridge || !turnContext.signal || turnContext.signal.aborted) {
      throw new Error("Pi worker RPC refused: turn is inactive, cancelled or revoked.");
    }
  }
  function fail(reason: unknown): void {
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
  async function dispatch(msg: Rpc): Promise<unknown> {
    live();
    if (msg.id <= lastRpcId) throw new Error("Replayed pi worker RPC");
    lastRpcId = msg.id;
    const bridge = turnContext.bridge!;
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
      if (bridge.applyBrain && Object.values(BRAIN_APPLICATION_TOOLS).includes(msg.toolName as any)) {
        // Exact application authorization belongs to the server route.
        return { behavior: "allow" };
      }
      const approval = decideToolPermission({ toolName: msg.toolName, shellToolName: "bash", updateToolName: "brain_update",
        input: msg.input, allowedTools, confirmPatterns });
      const decision = approval ? await requestToolPermission(bridge, createToolPermissionRequest({
        toolUseId: msg.toolCallId, toolName: msg.toolName, input: msg.input, description: approval.reason, approval,
        outsideEnforcedAllowlist: turnContext.enforceAllowedTools && approval.kind === "tool",
      }), { noGrantSurface: turnContext.noGrantSurface }) : { behavior: "allow" as const };
      live();
      if (decision.behavior === "allow") {
        const edited = "updatedInput" in decision ? decision.updatedInput : undefined;
        if (edited) {
          const refusal = checkEditedApproval({ toolName: msg.toolName, shellToolName: "bash", updateToolName: "brain_update",
            confirmPatterns, originalInput: msg.input, editedInput: edited });
          if (refusal) return { behavior: "deny", message: refusal };
        }
        grants.set(msg.toolCallId, { name: msg.toolName, input: JSON.stringify(edited ?? msg.input) });
      }
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
      if (!grant || grant.name !== "brain_read_base" || grant.input !== JSON.stringify(msg.input)) {
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
        cost = msg.cost; ended = true;
        if (msg.error) done.reject(new Error(msg.error)); else done.resolve();
      } else throw new BackendRequestError(msg.message);
    }
    if (!ended) throw new Error(`Pi worker exited before completion: ${diagnostic || "protocol closed"}`);
  })().catch(fail);
  void child.exited.then(code => { if (!ended) fail(new BackendRequestError(`Pi worker exited (${code}): ${diagnostic}`)); });
  // Copy only native state files over the control pipe. No extension code or
  // SDK session is initialized in the privileged process.
  try {
    send({ type: "init", backend: { brainPath: backend.brainPath, profiles: configuredProfiles(backend), model: backend.model,
      loadExtensions: backend.loadExtensions, systemPromptAppend: backend.systemPromptAppend }, env, sessionId,
      resume: Boolean(resumeId), entries, profileId, agentFiles });
    const timeout = setTimeout(() => fail(new BackendRequestError("Pi worker initialization timed out")), 30_000);
    try { await ready.promise; } finally { clearTimeout(timeout); }
  } catch (error) { fail(error); await child.exited; throw error; }
  const session: PiSessionLike = {
    sessionId, get model() { return model; }, get thinkingLevel() { return thinkingLevel; },
    getAvailableThinkingLevels: () => levels,
    setThinkingLevel(level) { thinkingLevel = level; send({ type: "thinking", level }); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async prompt(text, options) {
      if (options?.streamingBehavior === "followUp") { live(); send({ type: "followUp", text, options }); return; }
      if (error) throw error;
      if (active || ended) throw new Error("Pi worker turn already started or finished");
      active = true;
      send({ type: "prompt", text, options });
      try { await done.promise; }
      finally { child.stdin.end(); child.kill("SIGKILL"); await child.exited; await received; }
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

import { promptPrefixFingerprint } from "@schlessera/brain-ui-sdk/internal";
/** Imported only after the shared launcher's descriptor and namespace gate. */
import { existsSync, mkdirSync, readFileSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession, SessionManager, FileEntry } from "@earendil-works/pi-coding-agent";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { compileConfirmPatterns } from "@schlessera/brain-ui-sdk/server";
import { createTurnTempPressure, TURN_TEMP_ROOT, WORKER_INFERENCE_SOCKET, WORKER_SCRATCH } from "@schlessera/brain-ui-sdk/internal";
import type { PiWorkerInference } from "./autonomous-envelope.js";
import { createBrainAccess } from "./brain-access.js";
import { createSessionResources } from "./session-resources.js";
import { createSessionRuntime } from "./native-session-runtime.js";
import { toolLockFromKeyed } from "./tools.js";
import { createPiBridgeTools } from "./bridge-tools.js";
import { PI_WORKER_STATE, SessionTooLargeError, pipeMessages, sendPipe, type PiWorkerMessage } from "./worker-protocol.js";
import type { CreatePiBackendOptions, PiSessionLike, SessionEnv, SessionToolkit } from "./backend-options.js";

interface Init {
  type: "init";
  backend: Pick<CreatePiBackendOptions, "brainPath" | "profiles" | "model" | "loadExtensions" | "systemPromptAppend">;
  env: SessionEnv;
  sessionId: string;
  resume: boolean;
  entries?: FileEntry[];
  profileId?: string;
  agentFiles: Record<string, string>;
  cachedNpmModules?: string;
  /** Rendered by the server from this worker's resolved mounts (#1626). */
  sandboxNote?: string;
  fixedAppend?: string;
  governed?: boolean;
  sharedLock?: boolean;
  /** Present for an autonomous turn: pi reaches inference only through the relay socket. */
  inference?: PiWorkerInference;
}
sendPipe(process.stdout, { type: "startup_timing", phase: "worker_started", durationMs: 0 });
let session: PiSessionLike | undefined;
let manager: SessionManager | undefined;
let turn: SessionToolkit;
const controller = new AbortController();
const toolScope = new AsyncLocalStorage<{ id: string; name: string }>();
let nextId = 0;
let authPath: string;
let originalAuth: string | undefined;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const send = (value: unknown) => sendPipe(process.stdout, value);
function rpc(method: Extract<PiWorkerMessage, { type: "rpc" }>["method"], toolName: string, toolCallId: string, input: Record<string, unknown>): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ type: "rpc", id, method, toolName, toolCallId, input });
  });
}
let renderedAppend: string | undefined;
let snapshotFailed = false;
function snapshot(): boolean {
  if (snapshotFailed) return false;
  try {
    if (manager) send({ type: "snapshot", entries: [manager.getHeader(), ...manager.getEntries()] });
    return true;
  } catch (error) {
    if (!(error instanceof SessionTooLargeError)) throw error;
    // Subscribers and queued microtasks have no prompt rejection handler.
    // Send one bounded terminal error; the parent tears down this worker.
    snapshotFailed = true;
    controller.abort();
    send({ type: "error", message: error.message, errorClass: error.errorClass });
    return false;
  }
}
/**
 * After each tool call, the one-time warning past 80% of turn temp and the
 * out-of-space message, both naming `turn_temp` (#1703), read from this
 * worker's own size-limited `/tmp`. Its size is the allowance it was mounted
 * with. Absent when the turn has no `turn_temp` tool.
 */
function turnTempPressure(env: SessionEnv): (() => string | undefined) | undefined {
  if (!env.caps.turnTemp) return undefined;
  let allowance: number;
  try { const fs = statfsSync(TURN_TEMP_ROOT); allowance = fs.blocks * fs.bsize; } catch { return undefined; }
  const check = createTurnTempPressure(allowance, "turn_temp");
  return () => {
    try {
      const fs = statfsSync(TURN_TEMP_ROOT);
      return check({ usedBytes: (fs.blocks - fs.bfree) * fs.bsize, freeBytes: fs.bavail * fs.bsize });
    } catch { return undefined; }
  };
}

async function initialize(init: Init): Promise<void> {
  const started = performance.now();
  const timing = (phase: string, durationMs: number) => send({ type: "startup_timing", phase, durationMs });
  const state = PI_WORKER_STATE;
  mkdirSync(state, { recursive: true });
  authPath = join(state, "auth.json"); originalAuth = init.agentFiles["auth.json"];
  for (const name of ["auth.json", "models.json", "settings.json"]) {
    if (init.agentFiles[name] !== undefined) writeFileSync(join(state, name), init.agentFiles[name]!);
  }
  if (init.cachedNpmModules) {
    mkdirSync(join(state, "npm"));
    symlinkSync(init.cachedNpmModules, join(state, "npm", "node_modules"));
  }
  if (init.inference) {
    // This trusted entry runs before pi or any tool initializes. The worker's
    // network namespace holds only loopback; this port forwards to the server's
    // relay socket, the one route out. pi holds a placeholder, never the key.
    const forward = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
      const url = new URL(request.url);
      return fetch(`http://localhost${url.pathname}${url.search}`, { method: request.method, headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
        unix: WORKER_INFERENCE_SOCKET } as RequestInit);
    } });
    writeFileSync(join(state, "models.json"), JSON.stringify({ providers: { [init.inference.provider]: {
      baseUrl: `http://127.0.0.1:${forward.port}${init.inference.basePath}`, apiKey: init.inference.placeholder } } }));
  }
  const resources = createSessionResources({ backend: init.backend,
    brain: createBrainAccess(init.backend.brainPath), lock: init.sharedLock ? {
      async withKey(key, fn) {
        if (key === null) return fn();
        const scope = toolScope.getStore();
        if (!scope) throw new Error("A shared lock needs the active tool call");
        const { lockId } = await rpc("lock", scope.name, scope.id, { key });
        try { return await fn(); } finally { await rpc("unlock", scope.name, scope.id, { lockId }); }
      },
    } : toolLockFromKeyed(createKeyedLock()),
    allowedTools: new Set(), confirmPatterns: compileConfirmPatterns([], () => {}), loadExtensions: init.backend.loadExtensions ?? true,
    // pi settings changes stay in scratch; source settings/extensions remain read-only.
    settingsSnapshot: init.agentFiles["settings.json"] ?? "{}",
    requireInstalledPackages: true,
    ...(init.governed ? { directWrites: true, ...(init.env.autonomous ? {} : { nativeFileObservation: async (phase: string, path: string, id: string) => {
      const scope = toolScope.getStore();
      if (!scope || scope.id !== id) throw new Error("A file observation needs the active native tool call");
      await rpc("fileObservation", scope.name, id, { phase, path });
    } }) } : { shellCwd: WORKER_SCRATCH }),
    ...(init.sandboxNote ? { sandboxNote: init.sandboxNote } : {}),
    fixedAppend: init.fixedAppend, observeAppend: append => { renderedAppend = append; },
    permissionFactory: holder => ({ name: "brain-server-permission-gate", factory: pi => {
      pi.on("tool_call", async event => {
        if (controller.signal.aborted) return { block: true, reason: "Turn cancelled" };
        const result = await rpc("permission", event.toolName, event.toolCallId, event.input as Record<string, unknown>);
        if (result.behavior === "deny") return { block: true, reason: result.message };
        if (result.updatedInput) {
          const input = event.input as Record<string, unknown>;
          for (const key of Object.keys(input)) delete input[key];
          Object.assign(input, result.updatedInput);
        }
        return undefined;
      });
      // The holder is still bound per turn; no host bridge is loaded here.
      void holder;
    } }),
  });
  const buildResources = resources.build;
  resources.build = async (...args) => {
    const start = performance.now();
    try { return await buildResources(...args); } finally { timing("resources", performance.now() - start); }
  };
  const buildToolkit = resources.buildToolkit;
  resources.buildToolkit = caps => {
    turn = buildToolkit(caps);
    const bridgeNames = new Set(createPiBridgeTools({ brainPath: init.backend.brainPath,
      turn: turn.turnContext, capabilities: caps }).map(t => t.name));
    turn.tools = turn.tools.map(tool => bridgeNames.has(tool.name) ? { ...tool,
      execute: (id, input) => rpc("bridge", tool.name, id, input as Record<string, unknown>) } : tool);
    const pressure = turnTempPressure(init.env);
    turn.tools = turn.tools.map(tool => ({ ...tool, execute: async (id, input, signal, update, context) => {
      let result: Awaited<ReturnType<typeof tool.execute>>;
      try { result = await toolScope.run({ id, name: tool.name }, () => tool.execute(id, input, signal, update, context)); }
      catch (error) {
        const message = pressure?.();
        if (message) throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${message}`);
        throw error;
      }
      const message = pressure?.();
      return message ? { ...result, content: [...(result.content ?? []), { type: "text" as const, text: message }] } : result;
    } }));
    turn.turnContext.signal = controller.signal;
    // No missing-route fallback may execute a legacy brain writer.
    turn.turnContext.bridge = {
      emit() { throw new Error("Workers cannot emit privileged bridge frames"); },
      requestPermission() { throw new Error("Use the server permission RPC"); },
      applyBrain: input => rpc("apply", toolScope.getStore()?.name ?? "", toolScope.getStore()?.id ?? "", input as unknown as Record<string, unknown>),
      readBrainBase: path => rpc("readBase", "brain_read_base", toolScope.getStore()?.id ?? "", { path }),
    };
    return turn;
  };
  const runtime = createSessionRuntime({ backend: init.backend, resources, sessionDir: state,
    sessionId: init.sessionId, entries: init.entries, observeManager: sm => { manager = sm; },
    modelRuntimeOptions: { authPath: join(state, "auth.json"), modelsPath: join(state, "models.json"), modelsStorePath: join(state, "models-cache.json") },
  });
  const opening = performance.now();
  const opened = init.resume ? await runtime.openSession(init.sessionId, init.env) : await runtime.newSession(init.profileId, init.env);
  timing("session", performance.now() - opening);
  timing("initialize", performance.now() - started);
  session = opened.session;
  session.subscribe(event => {
    if (snapshotFailed) return;
    if (event.type === "message_end" || event.type === "tool_execution_start" || event.type === "tool_execution_end" || event.type === "auto_retry_start"
      || event.type === "message_update" && ["text_delta", "thinking_delta"].includes(event.assistantMessageEvent.type)) {
      send({ type: "event", event });
    }
    // pi's internal subscriber appends before this subscriber is called.
    if (event.type === "entry_appended") snapshot();
    else if (event.type === "message_end" || event.type === "tool_execution_end") queueMicrotask(snapshot);
  });
  send({ type: "ready", sessionId: session.sessionId, append: renderedAppend, ...(session.model ? { model: session.model } : {}),
    ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
    levels: session.getAvailableThinkingLevels?.() ?? [], cost: session.getSessionStats().cost });
}

async function syncAuth(): Promise<void> {
  if (controller.signal.aborted || !existsSync(authPath)) return;
  const content = readFileSync(authPath, "utf8");
  if (content === originalAuth) return;
  await rpc("syncAuth", "", "", { content });
  originalAuth = content;
}

try {
  // Initialization is awaited in this loop. Prompt must run concurrently so
  // permission answers, follow-ups and cancellation can still arrive.
  let initialized = false;
  for await (const raw of pipeMessages(process.stdin)) {
    const msg = raw as any;
    if (!initialized) {
      if (msg.type !== "init") throw new Error("Pi worker requires initialization");
      await initialize(msg);
      initialized = true;
    } else if (msg.type === "answer") {
      const waiting = pending.get(msg.id);
      if (!waiting) throw new Error("Unsolicited server answer");
      pending.delete(msg.id);
      if (msg.error) waiting.reject(new Error(msg.error)); else waiting.resolve(msg.value);
    } else if (msg.type === "thinking") {
      session!.setThinkingLevel!(msg.level, { persist: false });
    } else if (msg.type === "abort") {
      controller.abort();
      await session!.abort();
    } else if (msg.type === "prompt") {
      send({ type: "prompt_prefix", prefix: promptPrefixFingerprint({
        tools: session!.agent?.state.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
        system: session!.systemPrompt, model: session!.model?.id, thinking: session!.thinkingLevel,
        gitStatusIncluded: null,
      }) });
      void session!.prompt(msg.text, msg.options).then(async () => {
        await syncAuth();
        if (snapshot()) send({ type: "done", cost: session!.getSessionStats().cost });
      }, async error => {
        await syncAuth();
        if (snapshot()) send({ type: "done", cost: session!.getSessionStats().cost, error: String(error) });
      }).catch(error => { if (!snapshotFailed) send({ type: "error", message: String(error) }); });
    } else if (msg.type === "followUp") {
      void session!.prompt(msg.text, { ...msg.options, streamingBehavior: "followUp" });
    } else throw new Error("Unknown server message");
  }
} catch (error) {
  send({ type: "error", message: error instanceof Error ? error.message : String(error) });
} finally {
  await session?.abort();
  (session as AgentSession | undefined)?.dispose();
  process.exit(0);
}

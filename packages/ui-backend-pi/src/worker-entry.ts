/** Imported only after the shared launcher's descriptor and namespace gate. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession, SessionManager, FileEntry } from "@earendil-works/pi-coding-agent";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { compileConfirmPatterns } from "@schlessera/brain-ui-sdk/server";
import { WORKER_INFERENCE_SOCKET, WORKER_SCRATCH } from "@schlessera/brain-ui-sdk/internal";
import type { PiWorkerInference } from "./autonomous-envelope.js";
import { createBrainAccess } from "./brain-access.js";
import { createSessionResources } from "./session-resources.js";
import { createSessionRuntime } from "./native-session-runtime.js";
import { toolLockFromKeyed } from "./tools.js";
import { createPiBridgeTools } from "./bridge-tools.js";
import { pipeMessages, sendPipe, type PiWorkerMessage } from "./worker-protocol.js";
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
  /** Present for an autonomous turn: pi reaches inference only through the relay socket. */
  inference?: PiWorkerInference;
}
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
function snapshot(): void {
  if (manager) send({ type: "snapshot", entries: [manager.getHeader(), ...manager.getEntries()] });
}
async function initialize(init: Init): Promise<void> {
  const state = join(WORKER_SCRATCH, "pi-state");
  mkdirSync(state, { recursive: true });
  authPath = join(state, "auth.json"); originalAuth = init.agentFiles["auth.json"];
  for (const name of ["auth.json", "models.json", "settings.json"]) {
    if (init.agentFiles[name] !== undefined) writeFileSync(join(state, name), init.agentFiles[name]!);
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
    brain: createBrainAccess(init.backend.brainPath), lock: toolLockFromKeyed(createKeyedLock()),
    allowedTools: new Set(), confirmPatterns: compileConfirmPatterns([], () => {}), loadExtensions: init.backend.loadExtensions ?? true,
    // pi settings changes stay in scratch; source settings/extensions remain read-only.
    settingsSnapshot: init.agentFiles["settings.json"] ?? "{}",
    shellCwd: WORKER_SCRATCH,
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
  const buildToolkit = resources.buildToolkit;
  resources.buildToolkit = caps => {
    turn = buildToolkit(caps);
    const bridgeNames = new Set(createPiBridgeTools({ brainPath: init.backend.brainPath,
      turn: turn.turnContext, capabilities: caps }).map(t => t.name));
    turn.tools = turn.tools.map(tool => bridgeNames.has(tool.name) ? { ...tool,
      execute: (id, input) => rpc("bridge", tool.name, id, input as Record<string, unknown>) } : tool);
    turn.tools = turn.tools.map(tool => ({ ...tool, execute: (id, input, signal, update, context) =>
      toolScope.run({ id, name: tool.name }, () => tool.execute(id, input, signal, update, context)) }));
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
  const opened = init.resume ? await runtime.openSession(init.sessionId, init.env) : await runtime.newSession(init.profileId, init.env);
  session = opened.session;
  session.subscribe(event => {
    if (event.type === "message_end" || event.type === "tool_execution_start" || event.type === "tool_execution_end" || event.type === "auto_retry_start"
      || event.type === "message_update" && ["text_delta", "thinking_delta"].includes(event.assistantMessageEvent.type)) {
      send({ type: "event", event });
    }
    // pi's internal subscriber appends before this subscriber is called.
    if (event.type === "entry_appended") snapshot();
    else if (event.type === "message_end" || event.type === "tool_execution_end") queueMicrotask(snapshot);
  });
  send({ type: "ready", sessionId: session.sessionId, ...(session.model ? { model: session.model } : {}),
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
      void session!.prompt(msg.text, msg.options).then(async () => {
        await syncAuth();
        snapshot(); send({ type: "done", cost: session!.getSessionStats().cost });
      }, async error => {
        await syncAuth();
        snapshot(); send({ type: "done", cost: session!.getSessionStats().cost, error: String(error) });
      }).catch(error => send({ type: "error", message: String(error) }));
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

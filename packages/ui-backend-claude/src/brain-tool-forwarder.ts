import { createBrainInventoryCache, type BrainInventoryResolution } from "./brain-tool-inventory.js";
/** Per-turn MCP relay. This module never opens brain content on the host. */
import type { ZodRawShape } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { brainReadDefinitions, BRAIN_READ_DEFINITION_VERSION } from "@schlessera/brain/internal";
import { launchAgentWorkerAsync, retainWorkerStartupView, prepareNativeWorkerOutput, processStateLedger,
  workerCleanupUnconfirmed, processCleanupReconciler, reportStrandedWorkerCleanup, WORKER_EMPTY_HOME,
  type LaunchedWorker, type WorkerSandbox, type WorkerStartupView, type WorkerLimitsPlan, type WorkerStateLimits,
} from "@schlessera/brain-ui-sdk/internal";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { join } from "node:path";

/** Product bound for readiness and individual calls, independent of test watchdogs. */
export const BRAIN_TOOL_TIMEOUT_MS = 30_000;

/** Adapt the sandbox launch's existing pipes; never spawn a process in a transport. */
export function brainWorkerTransport(worker: Pick<LaunchedWorker, "stdin" | "stdout" | "exited" | "kill">): Transport {
  const buffer = new ReadBuffer();
  const transport: Transport = {
    async start() {
      worker.stdout.on("data", chunk => {
        try { buffer.append(Buffer.from(chunk)); for (let message; (message = buffer.readMessage()) !== null;) transport.onmessage?.(message); }
        catch (error) { transport.onerror?.(error as Error); }
      });
      worker.stdout.on("error", error => transport.onerror?.(error));
      worker.stdin.on("error", error => transport.onerror?.(error));
      worker.stdout.on("end", () => transport.onclose?.());
      void worker.exited.catch(error => transport.onerror?.(error));
    },
    async send(message: JSONRPCMessage) {
      await new Promise<void>((resolve, reject) => worker.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve()));
    },
    async close() { worker.kill("SIGKILL"); },
  };
  return transport;
}

/** Register immediately; start with backend invocation and await readiness only on a call. */
export function createBrainToolForwarder(start: (signal: AbortSignal) => Promise<{ transport: Transport; close(): Promise<void> }>,
  signal: AbortSignal, report: (error: unknown) => void, timeoutMs = BRAIN_TOOL_TIMEOUT_MS) {
  const observe = (error: unknown) => { try { report(error); } catch { /* Diagnostics never change tool control flow. */ } };
  const controller = new AbortController();
  const ownedSignal = AbortSignal.any([signal, controller.signal]);
  const client = new Client({ name: "brain-host-forwarder", version: "1" });
  let resource: Awaited<ReturnType<typeof start>> | undefined;
  let failed: unknown;
  // This starts the process concurrently with runtime startup, never listTools.
  let ready: Promise<void> | undefined;
  const startNow = () => ready ??= Promise.resolve().then(async () => {
    ownedSignal.throwIfAborted();
    resource = await start(ownedSignal);
    ownedSignal.throwIfAborted();
    await client.connect(resource.transport, { timeout: timeoutMs });
  }).catch(error => { failed = error; observe(error); throw error; });
  const startOwned = () => { void startNow().catch(() => {}); };
  const abort = () => { void client.close().catch(observe); };
  ownedSignal.addEventListener("abort", abort, { once: true });
  const definitions = brainReadDefinitions();
  const server = createSdkMcpServer({ name: "brain", version: String(BRAIN_READ_DEFINITION_VERSION), tools: [] });
  for (const [name, definition] of Object.entries(definitions)) {
    server.instance.registerTool<ZodRawShape, ZodRawShape>(name, definition, async (params, extra) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const callSignal = AbortSignal.any([ownedSignal, extra.signal]);
      try {
        await Promise.race([startNow(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("brain_tool_timeout")), timeoutMs);
        })]);
        clearTimeout(timer);
        if (failed) throw failed;
        callSignal.throwIfAborted();
        return await client.request({ method: "tools/call", params: { name, arguments: params } }, CallToolResultSchema, { timeout: timeoutMs, signal: callSignal });
      } catch (error) {
        observe(error);
        const timeout = (error as { code?: number })?.code === -32001 || (error as Error)?.message === "brain_tool_timeout";
        return { isError: true, content: [{ type: "text" as const,
          text: `${timeout ? "brain_tool_timeout" : "brain_tool_unavailable"}: the sandboxed brain server could not complete this call. Other tools remain available.` }] };
      } finally { clearTimeout(timer); }
    });
  }
  let closing: Promise<void> | undefined;
  return { server, start: startOwned, async close() {
    return closing ??= (async () => {
      controller.abort();
      try { await client.close(); }
      finally {
        await ready?.catch(() => {});
        ownedSignal.removeEventListener("abort", abort);
        await resource?.close();
      }
    })();
  } };
}

/** Use the exact turn sandbox and its immutable startup view, including data tree and provider masks. */
export interface BrainToolWorkerInput { brainPath: string; sandbox: WorkerSandbox; startupView?: WorkerStartupView;
  env: Record<string, string | undefined>; limits: WorkerLimitsPlan; turnTempLimits: WorkerStateLimits;
  req: StartTurnRequest; egress?: { proxyDir: string }; credentialEnv: readonly string[] }

export function startBrainToolWorker(input: BrainToolWorkerInput, args: readonly string[] = ["mcp"]) {
  return async (signal: AbortSignal) => {
    const reservation = processStateLedger().reserve(undefined, input.turnTempLimits);
    let worker: LaunchedWorker | undefined;
    let output: Awaited<ReturnType<typeof prepareNativeWorkerOutput>> | undefined;
    let launchFailure: unknown;
    const closeStorage = async () => {
      if (!worker && workerCleanupUnconfirmed(launchFailure)) {
        if (!launchFailure.close) throw launchFailure;
        await launchFailure.close();
      }
      await worker?.turnTemp?.closeAsync();
      await output?.cleanup();
    };
    const release = async () => {
      try { await closeStorage(); reservation.release(); }
      catch (error) {
        if (!worker && workerCleanupUnconfirmed(launchFailure) && !launchFailure.close)
          reportStrandedWorkerCleanup("claude", reservation, launchFailure);
        else processCleanupReconciler().retain({ bytes: reservation.bytes, turnTempBytes: reservation.turnTempBytes,
          close: closeStorage, release: () => reservation.release(), report: notice => input.req.bridge.activity?.({ kind: "worker_cleanup", ...notice }) }, error);
        throw error;
      }
    };
    try {
      signal.throwIfAborted();
      if (input.sandbox.profile !== "governed" && input.sandbox.areas.some(area => area.mount.writable)) {
        if (!input.startupView) throw new Error("Strict brain forwarding requires the turn's native startup view.");
        output = await prepareNativeWorkerOutput(input.brainPath, { startupView: input.startupView,
          areas: input.sandbox.areas.filter(area => area.mount.writable).map(area => area.rel), folderPaths: input.sandbox.retainedFolders, signal });
      }
      signal.throwIfAborted();
      worker = await launchAgentWorkerAsync({ brainPath: input.brainPath, sandbox: input.sandbox, limits: input.limits,
        ...(output ? { preparedOutput: output } : input.startupView && input.sandbox.profile !== "governed" ? { startupView: retainWorkerStartupView(input.startupView) } : {}),
        ...(input.req.workerLock ? { outputLock: input.req.workerLock } : {}),
        command: [process.execPath, join(input.brainPath, "node_modules/.bin/brain"), ...args],
        env: { ...Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), HOME: WORKER_EMPTY_HOME },
        credentialEnv: input.credentialEnv, ...(input.egress ? { egress: input.egress } : {}), turnTempBytes: reservation.turnTempBytes });
      const child = worker;
      const abort = () => child.kill("SIGKILL");
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      worker.stderr.resume();
      input.req.workerStarted?.(worker);
      let closing: Promise<void> | undefined;
      return { worker, transport: brainWorkerTransport(worker), close() {
        return closing ??= (async () => {
          signal.removeEventListener("abort", abort);
          child.kill("SIGKILL");
          await child.exited;
          child.stdin.end(); child.stdout.destroy(); child.stderr.destroy();
          await child.released();
          await release();
        })();
      } };
    } catch (error) {
      launchFailure = error;
      if (worker) { worker.kill("SIGKILL"); await worker.exited; worker.stdin.end(); worker.stdout.destroy(); worker.stderr.destroy(); await worker.released(); }
      await release();
      throw error;
    }
  };
}


/**
 * #4381: without a static module inventory, select the unchanged stdio path.
 * Resolve configuration only in a sandbox, once before a new session's roster
 * is retained. Never infer that an unknown or failed inventory is core-only.
 */
async function readBrainBridgeInventory(input: BrainToolWorkerInput, signal: AbortSignal): Promise<BrainInventoryResolution> {
  const controller = new AbortController();
  const ownedSignal = AbortSignal.any([signal, controller.signal]);
  let resource: Awaited<ReturnType<ReturnType<typeof startBrainToolWorker>>> | undefined;
  const timer = setTimeout(() => controller.abort(), BRAIN_TOOL_TIMEOUT_MS);
  try {
    resource = await startBrainToolWorker(input, ["module", "list", "--json"])(ownedSignal);
    let text = "";
    for await (const chunk of resource.worker.stdout) {
      text += String(chunk);
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("brain_bridge_inventory_oversized");
    }
    const code = await resource.worker.exited;
    if (code !== 0 || ownedSignal.aborted) return { inventory: "unavailable", modules: [] };
    const result = JSON.parse(text);
    if (!Array.isArray(result.enabled) || !Array.isArray(result.available)) return { inventory: "unavailable", modules: [] };
    if (result.enabled.some((module: unknown) => !module || typeof module !== "object"
      || !Array.isArray((module as { tools?: unknown }).tools)
      || !(module as { tools: unknown[] }).tools.every(name => typeof name === "string" && name.length > 0))) return { inventory: "unavailable", modules: [] };
    const modules = result.enabled.map((module: { key?: unknown; name?: unknown }) => {
      if (typeof module.key !== "string" || typeof module.name !== "string") throw new Error("Invalid module identity");
      return { key: module.key, name: module.name };
    });
    return { inventory: result.enabled.some((module: { tools: string[] }) => module.tools.length > 0) ? "module-tools" : "core-only", modules };
  } catch { return { inventory: "unavailable", modules: [] }; }
  finally { clearTimeout(timer); controller.abort(); await resource?.close(); }
}

export const probeBrainBridgeInventory = createBrainInventoryCache(readBrainBridgeInventory);

import { ordinaryWorkerLaunch } from "./worker-launch-command.js";
/** Per-turn MCP relay. This module never opens brain content on the host. */
import type { ZodRawShape } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { brainReadDefinitions, BRAIN_READ_DEFINITION_VERSION } from "@schlessera/brain/internal";
import { launchAgentWorkerAsync, retainWorkerStartupView, processStateLedger,
  workerCleanupUnconfirmed, processCleanupReconciler, reportStrandedWorkerCleanup,
  type LaunchedWorker, type WorkerLimitReport, type WorkerSandbox, type WorkerStartupView, type WorkerLimitsPlan, type WorkerStateLimits,
} from "@schlessera/brain-ui-sdk/internal";
import { safeStartupTiming, type ExecWrapperConfig, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";

/** Product bound for readiness and individual calls, independent of test watchdogs. */
export const BRAIN_TOOL_TIMEOUT_MS = 30_000;

/** Adapt the sandbox launch's existing pipes; never spawn a process in a transport. */
export function brainWorkerTransport(worker: Pick<LaunchedWorker, "stdin" | "stdout" | "exited" | "kill">): Transport {
  const buffer = new ReadBuffer();
  const transport: Transport = {
    async start() {
      worker.stdout.on("data", chunk => {
        buffer.append(Buffer.from(chunk));
        // Like the pinned stdio transport: a malformed line is reported and
        // consumed, and every later buffered line is still delivered.
        for (;;) {
          try { const message = buffer.readMessage(); if (message === null) break; transport.onmessage?.(message); }
          catch (error) { transport.onerror?.(error as Error); }
        }
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
export function createBrainToolForwarder(start: (signal: AbortSignal) => Promise<{ transport: Transport; close(): Promise<void>; worker?: Pick<LaunchedWorker, "limitReport"> }>,
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
  return { server, start: startOwned,
    /** The forwarding worker's limit hits, so a forwarded read reports them as a stdio descendant did (#4325 F27). */
    limitReports: (): WorkerLimitReport[] => resource?.worker ? [resource.worker.limitReport()] : [],
    async close() {
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
  exec: ExecWrapperConfig; env: Record<string, string | undefined>; limits: WorkerLimitsPlan; turnTempLimits: WorkerStateLimits;
  reservation?: () => import("./worker-state-budget.js").Reservation; req: StartTurnRequest; egress?: { proxyDir: string }; credentialEnv: readonly string[] }

/**
 * The brain entry as the project's own stdio entry starts it: relative to the
 * worker's brain root, so the host never resolves or enumerates anything in
 * the live brain to plan the launch (#4325 F19).
 */
export const BRAIN_ENTRY = "node_modules/.bin/brain";

/**
 * The brain read tools never write. Their worker keeps the turn's profile,
 * view, data tree and masks, but no writable area: those are aliased outside
 * the brain root that `brain mcp` reads, and a second output stage would take
 * a staging slot the runtime needs (#4325 F20).
 */
export function readOnlyBrainSandbox(sandbox: WorkerSandbox): WorkerSandbox {
  return { ...sandbox, areas: sandbox.areas.filter(area => !area.mount.writable) };
}

export function startBrainToolWorker(input: BrainToolWorkerInput, command: readonly string[] = [process.execPath, BRAIN_ENTRY, "mcp"]) {
  return async (signal: AbortSignal) => {
    const reservation = input.reservation?.() ?? processStateLedger().reserve(undefined, input.turnTempLimits);
    let worker: LaunchedWorker | undefined;
    let launchFailure: unknown;
    let abort: (() => void) | undefined;
    const closeStorage = async () => {
      if (!worker && workerCleanupUnconfirmed(launchFailure)) {
        if (!launchFailure.close) throw launchFailure;
        await launchFailure.close();
      }
      await worker?.turnTemp?.closeAsync();
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
      const sandbox = readOnlyBrainSandbox(input.sandbox);
      // Validate the wrapper before retaining the view: a throw here leaves
      // nothing that no launcher owns (#4325 F25).
      const launch = ordinaryWorkerLaunch(input.brainPath, [...command], input.env, input.exec);
      worker = await launchAgentWorkerAsync({ brainPath: input.brainPath, sandbox, limits: input.limits,
        ...(input.startupView && sandbox.profile !== "governed" ? { startupView: retainWorkerStartupView(input.startupView) } : {}),
        ...launch, credentialEnv: input.credentialEnv, ...(input.egress ? { egress: input.egress } : {}), turnTempBytes: reservation.turnTempBytes });
      const child = worker;
      // A separate-UID supervisor may refuse or lose a signal request. That
      // never skips pipe, storage or reservation cleanup (#4325 F24).
      const kill = () => { try { child.kill("SIGKILL"); } catch { /* exited is still awaited below. */ } };
      abort = kill;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      worker.stderr.resume();
      input.req.workerStarted?.(worker);
      let closing: Promise<void> | undefined;
      return { worker, transport: brainWorkerTransport(worker), close() {
        return closing ??= (async () => {
          if (abort) signal.removeEventListener("abort", abort);
          try { kill(); await child.exited; }
          finally {
            child.stdin.end(); child.stdout.destroy(); child.stderr.destroy();
            try { await child.released(); } finally { await release(); }
          }
        })();
      } };
    } catch (error) {
      launchFailure = error;
      if (abort) signal.removeEventListener("abort", abort);
      try {
        if (worker) {
          try { try { worker.kill("SIGKILL"); } catch { /* exited is still awaited. */ } await worker.exited; }
          finally {
            worker.stdin.end(); worker.stdout.destroy(); worker.stderr.destroy();
            await worker.released();
          }
        }
      } finally { await release(); }
      throw error;
    }
  };
}


/** The in-sandbox inventory check: the project entry must be canonical (#4325 F22). */
export const BRAIN_INVENTORY_ENTRY = Bun.resolveSync("./brain-bridge-inventory-entry", import.meta.dir);

/**
 * #4381: without a static module inventory, select the unchanged stdio path.
 * Resolve configuration only in a sandbox, once before a new session's roster
 * is retained. Never infer that an unknown or failed inventory is core-only.
 */
async function readBrainBridgeInventory(input: BrainToolWorkerInput, signal: AbortSignal): Promise<"core-only" | "module-tools" | "unavailable"> {
  const controller = new AbortController();
  const ownedSignal = AbortSignal.any([signal, controller.signal]);
  let resource: Awaited<ReturnType<ReturnType<typeof startBrainToolWorker>>> | undefined;
  const timer = setTimeout(() => controller.abort(), BRAIN_TOOL_TIMEOUT_MS);
  try {
    resource = await startBrainToolWorker(input, [process.execPath, BRAIN_INVENTORY_ENTRY])(ownedSignal);
    let text = "";
    for await (const chunk of resource.worker.stdout) {
      text += String(chunk);
      if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("brain_bridge_inventory_oversized");
    }
    const code = await resource.worker.exited;
    if (code !== 0 || ownedSignal.aborted) return "unavailable";
    const result = JSON.parse(text);
    if (!Array.isArray(result.enabled) || !Array.isArray(result.available)) return "unavailable";
    if (result.enabled.some((module: unknown) => !module || typeof module !== "object"
      || typeof (module as { key?: unknown }).key !== "string" || typeof (module as { name?: unknown }).name !== "string"
      || !Array.isArray((module as { tools?: unknown }).tools)
      || !(module as { tools: unknown[] }).tools.every(name => typeof name === "string" && name.length > 0))) return "unavailable";
    return result.enabled.some((module: { tools: string[] }) => module.tools.length > 0) ? "module-tools" : "core-only";
  } catch { return "unavailable"; }
  finally { clearTimeout(timer); controller.abort(); await resource?.close(); }
}

/** Each new session gets a fresh sandbox verdict before its roster is fixed. */
export async function probeBrainBridgeInventory(input: BrainToolWorkerInput, signal: AbortSignal) {
  const observed = safeStartupTiming(input.req.startupTiming)?.start("brain_tool_inventory");
  try { return await readBrainBridgeInventory(input, signal); }
  catch { return "unavailable" as const; }
  finally { observed?.(); }
}

import { ordinaryWorkerLaunch } from "./worker-launch-command.js";
import { readFileSync } from "node:fs";
/** Per-turn MCP relay. This module never opens brain content on the host. */
import type { ZodRawShape } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { brainReadDefinitions, BRAIN_READ_DEFINITION_VERSION } from "@schlessera/brain/internal/read-definitions";
import { launchAgentWorkerAsync, retainWorkerStartupView, processStateLedger,
  workerCleanupUnconfirmed, processCleanupReconciler, reportStrandedWorkerCleanup,
  type LaunchedWorker, type WorkerLimitReport, type WorkerSandbox, type WorkerStartupView, type WorkerLimitsPlan, type WorkerStateLimits,
} from "@schlessera/brain-ui-sdk/internal";
import { safeStartupTiming, type ExecWrapperConfig, type StartTurnRequest } from "@schlessera/brain-ui-sdk/server";

/** Product bound for readiness and individual calls, independent of test watchdogs. */
export const BRAIN_TOOL_TIMEOUT_MS = 30_000;
/** Product bound for the forwarding process to exit at cleanup before its allowance is handed to the reconciler. */
export const BRAIN_TOOL_EXIT_WAIT_MS = 5_000;
/**
 * Product bound for the inventory check before a new chat's first request:
 * well above a cold `brain module list`, well below the turn budget. A check
 * that misses it selects the unchanged stdio path (#4325 F3).
 */
export const BRAIN_INVENTORY_TIMEOUT_MS = 8_000;

/** Adapt the sandbox launch's existing pipes; never spawn a process in a transport. */
export function brainWorkerTransport(worker: Pick<LaunchedWorker, "stdin" | "stdout" | "exited" | "kill">): Transport {
  const buffer = new ReadBuffer();
  const transport: Transport = {
    async start() {
      worker.stdout.on("data", chunk => {
        // An oversized message (the pinned SDK's 10 MiB bound) ends this
        // transport with a reported error: its pending calls then return the
        // named tool error, and nothing escapes the stream listener (#4325 F9).
        try { buffer.append(Buffer.from(chunk)); }
        catch (error) { transport.onerror?.(error as Error); void transport.close().catch(() => {}); return; }
        // Like the pinned stdio transport: a malformed line is reported and
        // consumed, and every later buffered line is still delivered.
        for (;;) {
          try { const message = buffer.readMessage(); if (message === null) break; transport.onmessage?.(message); }
          catch (error) { transport.onerror?.(error as Error); }
        }
      });
      worker.stdout.on("error", error => transport.onerror?.(error));
      worker.stdin.on("error", error => transport.onerror?.(error));
      // The worker's exit closes the transport as its stdout's end does:
      // under a separate UID the pipe's writer is the identity supervisor,
      // whose end can follow the exit by the worker's held handles (#4325 F3).
      let closed = false;
      const closeOnce = () => { if (!closed) { closed = true; transport.onclose?.(); } };
      worker.stdout.on("end", closeOnce);
      void worker.exited.then(closeOnce, error => transport.onerror?.(error));
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
  reservation?: () => import("@schlessera/brain-ui-sdk/internal").Reservation; req: StartTurnRequest; egress?: { proxyDir: string }; credentialEnv: readonly string[] }

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
  // Managed worktrees are writable generations; the read tools never use them.
  const { worktrees: _worktrees, ...rest } = sandbox;
  return { ...rest, areas: sandbox.areas.filter(area => !area.mount.writable) };
}

/**
 * End input first, since `brain mcp` exits on it even when a signal is refused
 * or lost, then kill, and wait for exit within a bound (#4325 F12). The pipes
 * are disposed either way; an unconfirmed exit is reported, never awaited forever.
 */
async function stopBrainWorker(child: Pick<LaunchedWorker, "stdin" | "stdout" | "stderr" | "exited">, kill: () => void):
  Promise<{ settled: true; error?: unknown } | { settled: false }> {
  try { child.stdin.end(); } catch { /* The kill below still applies. */ }
  kill();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exit = await Promise.race([
    child.exited.then(() => ({ settled: true as const }), (error: unknown) => ({ settled: true as const, error })),
    new Promise<{ settled: false }>(resolve => { timer = setTimeout(() => resolve({ settled: false }), BRAIN_TOOL_EXIT_WAIT_MS); }),
  ]);
  clearTimeout(timer);
  child.stdout.destroy(); child.stderr.destroy();
  return exit;
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
    const unexited = () => new Error("brain_tool_worker_exit_unconfirmed: the sandboxed brain server did not exit; its allowance stays held until it does.");
    /** A process that may still run keeps its storage and reservation, owned by the reconciler until it is confirmed gone (#4325 F12). */
    const retainUnexited = (child: LaunchedWorker, error: Error) => processCleanupReconciler().retain({ bytes: reservation.bytes, turnTempBytes: reservation.turnTempBytes,
      close: async () => { await child.exited.catch(() => {}); await child.released(); await closeStorage(); },
      release: () => reservation.release(), report: notice => input.req.bridge.activity?.({ kind: "worker_cleanup", ...notice }) }, error);
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
      // Read-only on every profile: the launcher makes every bind into the
      // brain or the data tree read-only, including a governed worker's live
      // brain, protection pins and indexes (#4325 F10, round 2 F1/F2).
      worker = await launchAgentWorkerAsync({ brainPath: input.brainPath, sandbox, limits: input.limits, readOnlyBrain: true,
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
          const exit = await stopBrainWorker(child, kill);
          if (!exit.settled) { const error = unexited(); retainUnexited(child, error); throw error; }
          try { await child.released(); } finally { await release(); }
          if ("error" in exit) throw exit.error;
        })();
      } };
    } catch (error) {
      launchFailure = error;
      if (abort) signal.removeEventListener("abort", abort);
      let held = false, exitError: { error: unknown } | undefined;
      try {
        if (worker) {
          const launched = worker;
          const exit = await stopBrainWorker(launched, () => { try { launched.kill("SIGKILL"); } catch { /* Exit is still awaited, bounded. */ } });
          if (!exit.settled) { held = true; retainUnexited(launched, unexited()); }
          else {
            // A rejected exit observer is the more specific failure, as before.
            if ("error" in exit) exitError = { error: exit.error };
            await launched.released();
          }
        }
      } finally { if (!held) await release(); }
      throw exitError ? exitError.error : error;
    }
  };
}


let inventoryEntry: string | undefined, bridgeVersion: string | undefined;
/**
 * The in-sandbox inventory check: the project entry must be canonical
 * (#4325 F22). Resolved on first use, so importing this module under Node
 * runs no Bun-only code.
 */
export function brainInventoryEntry(): string {
  return inventoryEntry ??= Bun.resolveSync("./brain-bridge-inventory-entry", import.meta.dir);
}

/**
 * The `@schlessera/brain` version whose static read definitions the bridge
 * advertises: the host's own installed package, never a brain file. The
 * inventory check requires the brain's server to be this same version (F14).
 */
export function bridgeBrainVersion(): string {
  return bridgeVersion ??= (JSON.parse(readFileSync(Bun.resolveSync("@schlessera/brain/package.json", import.meta.dir), "utf8")) as { version: string }).version;
}

/**
 * #4381: without a static module inventory, select the unchanged stdio path.
 * Resolve configuration only in a sandbox, once before a new session's roster
 * is retained. Never infer that an unknown or failed inventory is core-only.
 */
async function readBrainBridgeInventory(input: BrainToolWorkerInput, signal: AbortSignal): Promise<"core-only" | "module-tools" | "unavailable"> {
  const controller = new AbortController();
  const ownedSignal = AbortSignal.any([signal, controller.signal]);
  let resource: Awaited<ReturnType<ReturnType<typeof startBrainToolWorker>>> | undefined;
  const timer = setTimeout(() => controller.abort(), BRAIN_INVENTORY_TIMEOUT_MS);
  // Every wait races one deadline: the product timeout or the caller's abort.
  // A supervisor that refuses the kill and a stdout that never ends can then
  // only cost the bound, never hold a new chat (#4325 round 2 F3).
  const deadline = new Promise<"deadline">(resolve => {
    if (ownedSignal.aborted) resolve("deadline");
    else ownedSignal.addEventListener("abort", () => resolve("deadline"), { once: true });
  });
  try {
    const starting = startBrainToolWorker(input, [process.execPath, brainInventoryEntry(), bridgeBrainVersion()])(ownedSignal);
    const started = await Promise.race([starting, deadline]);
    if (started === "deadline") { void starting.then(late => late.close()).catch(() => {}); return "unavailable"; }
    resource = started;
    const worker = started.worker;
    const reading = (async () => {
      let text = "";
      // Release the turn-temp handle once the helper exits: under a separate
      // UID its stdout ends only when the identity broker closes, and the
      // broker closes only when no handle holds it (#4325 F3). Idempotent
      // with the release in `finally`.
      const exit = worker.exited.finally(() => worker.turnTemp?.closeAsync().catch(() => {}));
      void exit.catch(() => {});
      for await (const chunk of worker.stdout) {
        text += String(chunk);
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("brain_bridge_inventory_oversized");
      }
      return { text, code: await exit };
    })();
    const read = await Promise.race([reading, deadline]);
    if (read === "deadline") { void reading.catch(() => {}); return "unavailable"; }
    const { text, code } = read;
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

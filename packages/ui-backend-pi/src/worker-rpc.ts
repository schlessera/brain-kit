/**
 * The host side of the pi worker's RPCs (#2517): one handler per protocol
 * method, keyed by `method`. Every call first proves the turn is live and the
 * request is not a replay; a method without a handler is refused. Handlers
 * hold no state of their own: the worker session supplies its grants, locks,
 * native file versions and receipts through `PiWorkerRpcContext`.
 */
import { randomUUID } from "node:crypto";
import { safeResolve } from "@schlessera/brain/internal";
import { BRAIN_APPLICATION_TOOLS, brainApplicationInput, brainReadBaseInput, bashLockKey, BRAIN_LOCK_KEY, isCompletedAutonomousToolCall,
  type BackendBridge, type compileConfirmPatterns, type KeyedLock } from "@schlessera/brain-ui-sdk/server";
import type { LaunchedWorker, NativeFileVersions, WorkerSandbox } from "@schlessera/brain-ui-sdk/internal";

import type { SessionCaps } from "./backend-options.js";
import { createPiBridgeTools, REQUEST_IMAGE_MASK_INPUT_SCHEMA } from "./bridge-tools.js";
import { decidePiToolPermission } from "./permission-gate.js";
import { revalidatePiAdmission } from "./tool-admission.js";
import { safetyAdmissionRefusal } from "@schlessera/brain-ui-sdk/internal";
import { syncPiAuth } from "./session-storage.js";
import type { TurnContext } from "./turn-context.js";
import type { PiWorkerMessage } from "./worker-protocol.js";
import type { PiWorkerReceipts } from "./worker-receipts.js";
import type { CallExecution } from "./worker-session.js";

export type PiWorkerRpc = Extract<PiWorkerMessage, { type: "rpc" }>;
export type PiWorkerRpcMethod = PiWorkerRpc["method"];

/** What one worker session lends its RPC handlers. */
export interface PiWorkerRpcContext {
  brainPath: string;
  turn: TurnContext;
  /** Throws unless the turn is active, unrevoked and has a bridge and a live signal. */
  live(): void;
  /** Server permission decisions by tool call id, each for one exact input. */
  grants: Map<string, { name: string; input: string }>;
  /** Held worker locks by lock id. */
  releases: Map<string, () => void>;
  workerLock: KeyedLock | undefined;
  /** The host's record of what each call's RPCs did. */
  executed(msg: PiWorkerRpc): CallExecution;
  /** Admits a permission request: a tool outside the provable set ends execution proof. */
  admitTool(toolName: string): void;
  autonomous: boolean;
  canFinalizeSafety?(toolName:string,toolId:string):boolean;
  /** The worker's resolved sandbox; native file observations require a governed one. */
  sandbox: Pick<WorkerSandbox, "profile">;
  /** The host-supplied sandbox, if any; a governed one keeps the native write and edit tools. */
  workerSandbox: WorkerSandbox | undefined;
  observeFile(path: string): ReturnType<NonNullable<LaunchedWorker["observeFile"]>>;
  nativeVersions: NativeFileVersions;
  /** The worker reaches inference through the host relay, which owns its credential state. */
  relayed: boolean;
  agentDir: string;
  agentFiles: Record<string, string>;
  allowedTools: ReadonlySet<string>;
  confirmPatterns: ReturnType<typeof compileConfirmPatterns>;
  bridgeTools: ReturnType<typeof createPiBridgeTools>;
  capabilities: SessionCaps;
  receipts: Pick<PiWorkerReceipts, "applications" | "persist">;
}

type PiWorkerRpcHandler = (msg: PiWorkerRpc, bridge: BackendBridge, context: PiWorkerRpcContext) => Promise<unknown>;

/** The path a granted brain_read_base input names; undefined unless it is a valid input. */
function grantedReadBasePath(granted: string): string | undefined {
  try { const parsed = brainReadBaseInput.safeParse(JSON.parse(granted)); return parsed.success ? parsed.data.path : undefined; }
  catch { return undefined; }
}

/** Releases one lock this session's worker holds. */
async function unlock(msg: PiWorkerRpc, _bridge: BackendBridge, { releases }: PiWorkerRpcContext): Promise<unknown> {
  if (typeof msg.input.lockId !== "string" || Object.keys(msg.input).length !== 1 || !releases.has(msg.input.lockId)) throw new Error("Unknown pi worker lock");
  releases.get(msg.input.lockId)!(); releases.delete(msg.input.lockId); return { ok: true };
}

/** Takes the shared lock key a granted operation's exact input names. */
async function lock(msg: PiWorkerRpc, _bridge: BackendBridge, context: PiWorkerRpcContext): Promise<unknown> {
  const { grants, workerLock, brainPath, turn: turnContext, live, releases, executed } = context;
  const grant = grants.get(msg.toolCallId);
  if (!workerLock || !grant || grant.name !== msg.toolName) throw new Error("Pi worker lock has no server permission grant");
  const input = JSON.parse(grant.input);
  const fileTool = ["write_file", "edit_file"].includes(msg.toolName);
  // The worker locks the canonical contained target, including an internal
  // symlink or a missing leaf below an existing parent. Validate identically.
  const target = fileTool && typeof input.path === "string" ? safeResolve(brainPath, input.path) : null;
  const key = msg.toolName === "bash" ? bashLockKey(input.command)
    : fileTool ? target && `path:${target}` : BRAIN_LOCK_KEY;
  if (typeof key !== "string" || msg.input.key !== key || Object.keys(msg.input).length !== 1) throw new Error("Pi worker lock does not match the authorized operation");
  const release = await workerLock.acquire(key, { signal: turnContext.signal ?? undefined });
  try {
    live();
    const stale = revalidatePiAdmission(turnContext, msg.toolName, msg.toolCallId, input);
    if (stale) { grants.delete(msg.toolCallId); throw new Error(stale); }
  } catch (error) { release(); throw error; }
  const lockId = randomUUID(); releases.set(lockId, release); executed(msg).lock = true; return { lockId };
}

/** Records one phase of a granted native file read or write against the worker's file view. */
async function fileObservation(msg: PiWorkerRpc, _bridge: BackendBridge, context: PiWorkerRpcContext): Promise<unknown> {
  const { grants, autonomous, sandbox, observeFile, nativeVersions, executed } = context;
  const grant = grants.get(msg.toolCallId);
  const input = grant && JSON.parse(grant.input);
  const phase = msg.input.phase;
  if (autonomous || sandbox.profile !== "governed" || !grant || grant.name !== msg.toolName
    || !["read_file", "write_file", "edit_file"].includes(msg.toolName)
    || typeof input.path !== "string" || msg.input.path !== input.path || Object.keys(msg.input).length !== 2
    || !(msg.toolName === "read_file" ? ["read_start", "read_end"] : ["write_check", "write_end"]).includes(phase as string)) {
    throw new Error("Native file observation has no matching granted operation");
  }
  const observed = observeFile(input.path);
  if (!observed) throw new Error("Native file observation is outside the worker file view");
  if (phase === "read_start") await nativeVersions.beginRead(msg.toolCallId, observed.key, observed.version);
  else if (phase === "read_end") await nativeVersions.finishRead(msg.toolCallId, observed.version, true);
  else if (phase === "write_check") {
    const refusal = nativeVersions.check(observed.key, observed.version);
    if (refusal) throw new Error(refusal);
    await nativeVersions.beginWrite(observed.key);
  } else await nativeVersions.finishWrite(observed.key, observed.version);
  executed(msg).phases.add(phase as string);
  const unavailable = safetyAdmissionRefusal(context.turn.bridge?.admissionSafety);
  if (unavailable) throw new Error(unavailable);
  return { ok: true };
}

/** Writes the worker's refreshed native login back to the host's store. */
async function syncAuth(msg: PiWorkerRpc, _bridge: BackendBridge, { relayed, agentDir, agentFiles }: PiWorkerRpcContext): Promise<unknown> {
  // A relayed worker's auth.json is a placeholder; the host refreshes its own store.
  if (relayed) throw new Error("A relayed pi worker cannot write the host's credential state");
  if (Object.keys(msg.input).length !== 1 || typeof msg.input.content !== "string") throw new Error("Malformed native pi state request");
  syncPiAuth(agentDir, agentFiles["auth.json"], msg.input.content);
  agentFiles["auth.json"] = msg.input.content;
  return { ok: true };
}

/** Decides one tool call: application tools defer to the server route, every other tool to the gate. */
async function permission(msg: PiWorkerRpc, bridge: BackendBridge, context: PiWorkerRpcContext): Promise<unknown> {
  const { admitTool, turn: turnContext, workerSandbox, grants, allowedTools, confirmPatterns, live } = context;
  admitTool(msg.toolName);
  if (isCompletedAutonomousToolCall(turnContext.autonomous, msg.toolName, msg.input)) {
    return { behavior: "deny", message: "This call already completed before yielding; inspect its retained result instead of replaying it." };
  }
  const application = Object.values(BRAIN_APPLICATION_TOOLS).includes(msg.toolName as any)
    && !(workerSandbox?.profile === "governed" && ["write_file", "edit_file"].includes(msg.toolName));
  if (!turnContext.autonomous && application && !bridge.applyBrain) return { behavior: "deny", message: "No server application route is available in this turn." };
  if (application && bridge.applyBrain) {
    // Exact application authorization belongs to the server route.
    await bridge.inputSafety?.begin(msg.toolCallId,msg.toolName,msg.input);
    live();
    const unavailable = safetyAdmissionRefusal(bridge.admissionSafety);
    if (unavailable) return { behavior: "deny", message: unavailable };
    return { behavior: "allow" };
  }
  grants.delete(msg.toolCallId);
  const decision = await decidePiToolPermission({ turn: turnContext, allowedTools, confirmPatterns }, msg.toolName, msg.input, msg.toolCallId);
  live();
  if (decision.behavior === "allow") {
    const stale = revalidatePiAdmission(turnContext, msg.toolName, msg.toolCallId, decision.updatedInput ?? msg.input);
    if (stale) return { behavior: "deny", message: stale };
  }
  if (decision.behavior === "allow") grants.set(msg.toolCallId, { name: msg.toolName, input: JSON.stringify(decision.updatedInput ?? msg.input) });
  return decision;
}

/** Runs one granted bridge tool on the host; a hosted mask records its application receipt. */
async function bridgeCall(msg: PiWorkerRpc, bridge: BackendBridge, session: PiWorkerRpcContext): Promise<unknown> {
  const { grants, bridgeTools, executed, live, brainPath, turn: turnContext, capabilities } = session;
  const { applications, persist } = session.receipts;
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
    const selected = createPiBridgeTools({ brainPath, turn: context, capabilities }).find(t => t.name === msg.toolName)!;
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

/** Reads one granted document's server base. */
async function readBase(msg: PiWorkerRpc, bridge: BackendBridge, { grants, executed }: PiWorkerRpcContext): Promise<unknown> {
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

/** Sends one application to the server's authoritative route and keeps its receipt. */
async function apply(msg: PiWorkerRpc, bridge: BackendBridge, context: PiWorkerRpcContext): Promise<unknown> {
  const { executed, turn: turnContext } = context;
  const { applications, persist } = context.receipts;
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

/** One handler per worker RPC method. */
export const PI_WORKER_RPC_HANDLERS: Readonly<Record<PiWorkerRpcMethod, PiWorkerRpcHandler>> = {
  unlock, lock, fileObservation, syncAuth, permission, bridge: bridgeCall, readBase, apply,
  admission: async (msg, _bridge, context) => {
    const grant = context.grants.get(msg.toolCallId);
    if (msg.toolName !== "bash" || !grant || grant.name !== msg.toolName || grant.input !== JSON.stringify(msg.input)) throw new Error("Pi final admission has no exact permission grant");
    const stale = revalidatePiAdmission(context.turn, msg.toolName, msg.toolCallId, msg.input, true);
    if (stale) { context.grants.delete(msg.toolCallId); throw new Error(stale); }
    context.grants.delete(msg.toolCallId);
    return { ok: true };
  },
  safetyUnavailable: async(msg,bridge)=>{
    if(msg.toolName||msg.toolCallId||Object.keys(msg.input).length)throw new Error("Malformed safety unavailable notice");
    await bridge.inputSafety?.unavailable?.();
    throw new Error("Unqualified Pi input transformations");
  },
  safetyResult: async(msg,bridge,context)=>{
    if(Object.keys(msg.input).some(key=>!["output","segments"].includes(key))||typeof msg.input.output!=="string"||msg.input.segments!==undefined&&(!Array.isArray(msg.input.segments)||(msg.input.segments as unknown[]).some(v=>typeof v!=="string")))throw resultLoss(new Error("Malformed safety result"));
    const execution=context.executed(msg);
    const bounded=execution.name===msg.toolName&&context.canFinalizeSafety?.(msg.toolName,msg.toolCallId)===true;
    await bridge.inputSafety?.result(msg.toolCallId,msg.toolName,msg.input.output,bounded,msg.input.segments as string[]|undefined);
    context.live();return {ok:true};
  },
};

/**
 * The session's RPC dispatcher. A refused call, including one whose method
 * has no handler, rejects; the worker receives the refusal as its answer.
 */
export function createPiWorkerRpcDispatcher(context: PiWorkerRpcContext): (msg: PiWorkerRpc) => Promise<unknown> {
  let lastRpcId = 0;
  return msg => {
    // A tool already ran when its result arrives, and recording it only
    // restricts: a stopped turn still records it, then the post-record live
    // check refuses the worker. A report refused before it reaches the
    // collector leaves its chat a permanent gap instead (#3812).
    const result = msg.method === "safetyResult", safety = context.turn.bridge?.inputSafety;
    // Pi runs a call only on an "allow" answer: a denial or a rejection
    // blocks it before it executes, so the call owes no result (#3812).
    const permission = msg.method === "permission" && safety?.refused ? safety : undefined;
    const refuse = <T>(outcome: Promise<T>): Promise<T> => !permission ? outcome : outcome.then(
      async answer => { if ((answer as { behavior?: string } | null)?.behavior !== "allow") await permission.refused!(msg.toolCallId); return answer; },
      async error => { await permission.refused!(msg.toolCallId); throw error; });
    try {
      if (!result || !safety) context.live();
      if (msg.id <= lastRpcId) throw resultLoss(new Error("Replayed pi worker RPC"));
      lastRpcId = msg.id;
      const bridge = context.turn.bridge!;
      const handler = Object.hasOwn(PI_WORKER_RPC_HANDLERS, msg.method) ? PI_WORKER_RPC_HANDLERS[msg.method] : undefined;
      if (!handler) throw new Error(`Unknown pi worker RPC method: ${String(msg.method)}`);
      const answer = handler(msg, bridge, context);
      return result && safety ? answer.catch(error => keepResultLoss(safety, msg, error)) : refuse(answer);
    } catch (error) { return result && safety ? keepResultLoss(safety, msg, error) : refuse(Promise.reject(error)); }
  };
}

/** Marks a result report refused before the collector saw it. A rejection
 * from the collector itself already left its own gap. */
const LOST = Symbol("pi safety result refused before its record");
function resultLoss(error: Error): Error { return Object.assign(error, { [LOST]: true }); }
async function keepResultLoss(safety: NonNullable<BackendBridge["inputSafety"]>, msg: PiWorkerRpc, error: unknown): Promise<never> {
  if ((error as { [LOST]?: boolean } | null)?.[LOST]) {
    // A loss notice that cannot commit is held by the host; the report is refused either way.
    try { await safety.lost?.(msg.toolCallId, msg.toolName, error); } catch { /* The host retains it in process. */ }
  }
  throw error;
}

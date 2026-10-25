/**
 * Concrete headless turn plumbing, run by the gated production dispatcher
 * (#689) and scheduled admission. `createApp` enables neither. U7 supplies the
 * synchronous atomic escalation writer.
 */
import type { Database } from "bun:sqlite";
import type { AgentBackend, BackendBridge, PermissionRequest, ServerMessage,
  StartTurnRequest, AskUserQuestion, BillingMode, PricingRoute, CompletedAutonomousToolCall } from "@schlessera/brain-ui-sdk/server";
import { createInboxBridgeTools } from "./bridge-tools.js";
import { createInboxIntake } from "./intake.js";
import { createInboxResolver } from "./resolve.js";
import { acquireInboxBudgetRun } from "./budget.js";
import { BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { isUsablePrincipal, resolvePrincipal } from "../db/principals.js";
import { createTurnRecorder, type TurnRecorderDeps } from "../activity/recorder.js";
import { checkpointYield, completedCallsForRun, recordCompletedCall, finishYield } from "./yield.js";
import { acquireInboxRunLifetime } from "./lifetime.js";
import { WorkerHostError, prepareNativeWorkerStartupView, type WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
import { requireWorkerHostRecorded } from "../agent/worker-host.js";
import type { InboxOperation } from "@schlessera/brain-ui-sdk/protocol";
import { boundaryPlanner, createBrainApplication, readBrainApplicationBase, validatePlan, type ApplicationPlanner } from "../brain/application.js";
import { createTurnDataTree, staleReadRefusal, type TurnDataTree } from "../brain/turn-data-tree.js";
import { privateIndexBuildFolders } from "../brain/private-index-cache.js";
import { readsIndex, type IndexBatch } from "../brain/index-batch.js";
import { createHostBoundary } from "../brain/host-boundary.js";
import { applicationToolName, inboxOperationAllowed } from "./envelope.js";
import type { GovernanceEventInput } from "../governance/events.js";
import { createGovernanceWrites } from "../governance/event-writes.js";
import { governancePolicyReaderFor, ProviderPolicyRefusedError, providerDeniedTypes, providerFolderRoots, providerMaskedFolders, providerTypeSelectors, unsupportedProviderSelectors, type TurnGovernancePolicy } from "../brain/governance-policy.js";
import { createProviderMaskGuard, type ProviderMaskGuard } from "../brain/provider-mask-refusal.js";
import { translateProviderTypesInView } from "../brain/provider-types.js";
import { appearedInView } from "../brain/governed-manifest.js";
import { providerHardlinks } from "../brain/provider-hardlinks.js";
import { buildPrivateIndex, createPrivateIndexDirectory, removePrivateIndexDirectory } from "../brain/private-index.js";
import { ensureIndexDirectory } from "../brain/index-directory.js";
import { ProviderThreadRefusedError } from "../brain/provider-mask-refusal.js";
import { admitOriginThread, type OriginThreadAdmission } from "./provenance.js";
import { protectedPaths } from "@schlessera/brain-common/internal/protected-paths";

export type AutonomousEscalation = {
  runId: string;
  principalId: string;
  /** Model-authored data, capped at 4096 UTF-8 bytes; never authority. */
  stateMd: string;
} & ({ kind: "permission"; request: PermissionRequest } |
  { kind: "question"; requestId: string; questions: AskUserQuestion[] });

/** The turn's first message and its system prompt addition. */
export interface AutonomousTurnContext { prompt: string; systemPromptAppend: string }

export type AutonomousTurnInput = AutonomousTurnOptions & (AutonomousTurnContext & { compose?: never } | {
  /**
   * Builds the context from the origin thread (#2741). It runs only once the
   * thread is admitted for the turn's provider masks, so a refused turn reads
   * no thread text; it reads arrivals from the admission and revalidates it in
   * the transaction that reads the thread.
   */
  compose(admission: OriginThreadAdmission): Promise<AutonomousTurnContext>;
  prompt?: never;
  systemPromptAppend?: never;
});

export interface AutonomousTurnOptions {
  turnId: string;
  principalId: string;
  profileId?: string;
  billingMode?: BillingMode;
  pricingRoute?: PricingRoute;
  allowedTools: readonly string[];
  signal: AbortSignal;
  yieldAfterMs?: number;
  /**
   * Server-selected application route (#689). Present, the turn may call the
   * hosted application tools in its roster; every proposal escalates as a
   * durable decision unless it is exactly `approved`, which applies at most
   * once. Absent, no application route exists for the turn.
   */
  application?: { approved?: InboxOperation };
}

export interface AutonomousTurnDeps extends TurnRecorderDeps {
  /** @internal Trusted createApp state; anonymous memory embedders have none. */
  identitySentinelDirectory?: string;
  /** Owned host manager; restricted workers still require immutable native inputs. */
  nativeManager?: Parameters<typeof prepareNativeWorkerStartupView>[1];
  applicationPlanner?: ApplicationPlanner;
  /** The host's deferred index updates after applications (#2835); absent, the turn's route keeps its own. */
  indexBatch?: IndexBatch;
  /** Authoritative brain; standalone callers default to their working directory. */
  brainPath?: string;
  /**
   * How a provider-restricted turn's private index is built, as for hosted
   * turns: the host's operational-state masks and optionally the CLI argv.
   * Absent, a turn under a provider folder rule refuses before any worker.
   */
  privateIndex?: { maskPaths: readonly string[]; command?: readonly string[] };
  db: Database;
  backend: AgentBackend;
  /** Must commit checkpoint + Action/block intent synchronously or throw. */
  checkpoint(escalation: AutonomousEscalation): void;
  /** Internal frame observer, not a WebSocket or session catalog. */
  emit?(frame: ServerMessage): void;
}

export interface AutonomousTurnResult {
  runId: string;
  outcome: "success" | "error" | "cancelled";
  escalated: boolean;
  yielded: boolean;
}

/** Called only with authority selected by server code, never a parsed client/model payload. */
export async function runAutonomousTurn(
  deps: AutonomousTurnDeps,
  input: AutonomousTurnInput
): Promise<AutonomousTurnResult> {
  if (deps.backend.capabilities.autonomous !== true) {
    throw new BackendRequestError(`Backend ${deps.backend.id} does not support autonomous turns.`);
  }
  // Untrusted work runs only where the restricted envelope exists (#676).
  if (deps.backend.capabilities.restrictedAutonomous !== true) {
    throw new BackendRequestError(`Backend ${deps.backend.id} cannot run the restricted autonomous envelope.`);
  }
  const principalId = input.principalId;
  const usable = (): boolean => {
    const principal = resolvePrincipal(deps.db, principalId);
    return Boolean(principal && isUsablePrincipal(principal, Date.now()));
  };
  if (!usable()) throw new BackendRequestError("Autonomous principal is missing, expired or revoked.");
  // The hosted turns' last-valid policy decides provider masks (#2691). What
  // the masks cannot hide refuses by name before any worker starts.
  const policy = governancePolicyReaderFor(deps.brainPath ?? process.cwd()).load();
  const unsupported = unsupportedProviderSelectors(policy.policy);
  if (unsupported.length) throw new ProviderPolicyRefusedError(unsupported);
  if ((providerFolderRoots(policy.policy).length || providerTypeSelectors(policy.policy).length) && !deps.privateIndex)
    throw new BackendRequestError("Autonomous turns under a provider folder rule need the host's private index masks; none are configured.");
  // The restricted envelope must be establishable, not only the ordinary worker (#676).
  try { await requireWorkerHostRecorded(deps.brainPath ?? process.cwd(), "restricted", deps.runtime, { dbPath: deps.db.filename, identitySentinelDirectory: deps.identitySentinelDirectory }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.emit?.({ type: "error", code: "BACKEND_REQUEST_ERROR", turnId: input.turnId, message,
      ...(error instanceof WorkerHostError ? { failure: { errorClass: error.errorClass, message } } : {}) });
    throw error;
  }
  // The bounded host probe may outlast a principal or an external revocation.
  if (!usable()) throw new BackendRequestError("Autonomous principal is missing, expired or revoked.");
  let lifetime: ReturnType<typeof acquireInboxRunLifetime>;
  try { lifetime = acquireInboxRunLifetime(deps.db, input.turnId); }
  catch (error) { throw new BackendRequestError(error instanceof Error ? error.message : "Autonomous attempt ownership failed."); }
  try {
    try { acquireInboxBudgetRun(deps.db, input.turnId, principalId); }
    catch (error) { throw new BackendRequestError(error instanceof Error ? error.message : "Autonomous budget admission failed."); }
    return await executeAutonomousTurn(deps, input, usable, lifetime, policy);
  } finally { lifetime.close(); }
}

async function executeAutonomousTurn(
  deps: AutonomousTurnDeps,
  input: AutonomousTurnInput,
  usable: () => boolean,
  lifetime: ReturnType<typeof acquireInboxRunLifetime>,
  policy: TurnGovernancePolicy,
): Promise<AutonomousTurnResult> {
  const principalId = input.principalId;
  const brainPath = deps.brainPath ?? process.cwd();
  // Literal folders and types both mask folders; types are translated below.
  const masksFolders = providerFolderRoots(policy.policy).length > 0 || providerTypeSelectors(policy.policy).length > 0;
  // Activity-linked items may share a run id. Only the admitted budget item
  // selects the origin; a model-authored record is never a scope grant.
  const origin = deps.db.query(`SELECT i.thread_id FROM inbox_budget_reservations r
    JOIN inbox_items i ON i.id = r.item_id WHERE r.run_id = ? AND r.principal_id = ?
    AND r.status = 'active' AND r.runtime_acquired_at IS NOT NULL AND i.deleted_at IS NULL`)
    .get(input.turnId, principalId) as { thread_id: string } | null;
  if (!origin) throw new BackendRequestError("Autonomous inbox origin is unavailable.");
  // Own immutable request policy for the attempt; callbacks cannot widen it.
  // Governance events (#1651) and roadblocks (#1671) go to the same database as the attempt.
  const governanceWrites = deps.governanceWrites ?? createGovernanceWrites(deps.governanceDb ?? deps.db);
  const governance = deps.governance ?? ((event: GovernanceEventInput) => governanceWrites.record(event).then(() => {}, (error: unknown) => {
    deps.log?.emit({ severityText: "WARN", body: `governance event not recorded: ${error instanceof Error ? error.message : String(error)}` });
  }));
  const recorder = createTurnRecorder({ ...deps, governance,
    governanceDb: deps.governanceDb ?? deps.db, governanceWrites },
    { turnId: input.turnId, sessionId: null,
    principalId, origin: "autonomous", profileId: input.profileId,
    billingMode: input.billingMode, pricingRoute: input.pricingRoute });
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (input.signal.aborted) abort();
  else input.signal.addEventListener("abort", abort, { once: true });
  let closed = false;
  let escalated = false;
  let revoked = false;
  let failed = false;
  let yielded = false;
  const tools = new Map<string, CompletedAutonomousToolCall>();
  let stateMd = "";
  let outcome: AutonomousTurnResult["outcome"] = "error";
  let terminal = false;
  let failureReason: string | undefined;
  const checkPrincipal = (): boolean => {
    if (closed || revoked) return false;
    if (usable()) return true;
    revoked = true;
    recorder.recordPrincipalRevocation(principalId);
    controller.abort();
    return false;
  };
  const emit = (frame: ServerMessage): void => {
    if (closed) return;
    checkPrincipal();
    if (frame.type === "session_info") {
      failed = true;
      controller.abort();
      throw new BackendRequestError("An autonomous backend advertised an interactive session.");
    }
    if (frame.type === "text_delta" && !escalated && !controller.signal.aborted) {
      stateMd = clipUtf8(stateMd + frame.text, 4096);
    }
    if (frame.type === "tool_use_complete") tools.set(frame.toolUseId, JSON.parse(JSON.stringify({ toolName: frame.toolName, input: frame.input })) as CompletedAutonomousToolCall);
    if (frame.type === "tool_result") {
      const call = tools.get(frame.toolUseId);
      if (call) { recordCompletedCall(deps.db, input.turnId, frame.toolUseId, call); tools.delete(frame.toolUseId); }
    }
    if (frame.type === "result") {
      if (terminal) return;
      terminal = true;
      outcome = failed ? "error" : controller.signal.aborted ? "cancelled" : frame.outcome ?? (frame.isError ? "error" : "success");
      frame = { ...frame, outcome, isError: outcome === "error" };
    }
    recorder.observeFrame(frame);
    deps.emit?.({ ...frame, turnId: input.turnId } as ServerMessage);
  };
  const modeFor = (systemPromptAppend: string) => Object.freeze({ origin: "autonomous" as const, persistence: "none" as const, containment: "restricted" as const,
    allowedTools: Object.freeze([...input.allowedTools]), systemPromptAppend,
    completedToolCalls: Object.freeze(completedCallsForRun(deps.db, input.turnId)),
    yieldAfterMs: input.yieldAfterMs ?? 20_000,
    onYield: (key: string): void => {
      if (closed || terminal || yielded || escalated || controller.signal.aborted || !checkPrincipal()) return;
      try { checkpointYield(deps.db, input.turnId, key, stateMd); yielded = true; }
      catch { failed = true; emit({ type: "error", code: "AUTONOMOUS_YIELD_FAILED", message: "Autonomous yield checkpoint failed." }); }
      finally { controller.abort(); }
    },
  });
  const checkpoint = (intent: { kind: "permission"; request: PermissionRequest } |
    { kind: "question"; requestId: string; questions: AskUserQuestion[] }): void => {
    if (closed || escalated || controller.signal.aborted || !checkPrincipal()) return;
    // Snapshot exact inputs before invoking server code. Neither a live model
    // object nor an approval Promise survives the checkpoint boundary.
    const snapshot = JSON.parse(JSON.stringify(intent)) as typeof intent;
    try {
      const result: unknown = deps.checkpoint({ ...snapshot, stateMd, runId: input.turnId, principalId });
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("Autonomous checkpoint must complete synchronously.");
      }
      escalated = true;
    } catch (error) {
      failed = true;
      emit({ type: "error", code: "AUTONOMOUS_CHECKPOINT_FAILED", message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      // Capture/commit first, then abort. No live approval promise is created.
      controller.abort();
    }
  };
  // The origin thread's provider admission (#2741), decided once the turn's
  // masks are exact. Until then no read of the thread is served.
  let admission: OriginThreadAdmission | undefined;
  const intake = createInboxIntake(deps.db, deps.brainPath ?? process.cwd());
  const inbox = createInboxBridgeTools(deps.db, intake, createInboxResolver(deps.db, { allowedOperations: () => [] })).forTurn({
    principalId, turnId: input.turnId, origin: { threadId: origin.thread_id }, membership: "restricted",
    allowedReads: (["inbox_list", "inbox_get"] as const).filter(name => input.allowedTools.includes(deps.backend.id === "claude" ? `mcp__brain-ui__${name}` : name)),
    isCurrent: () => !closed && !controller.signal.aborted && checkPrincipal(), sessionId: () => undefined,
    qualifyOrigin: () => {
      if (!admission) throw new ProviderThreadRefusedError(origin.thread_id, [], [], "unadmitted");
      admission.revalidate();
    },
  });
  const bridge: BackendBridge = {
    ...inbox,
    emit,
    activity: (event) => { if (!closed) { checkPrincipal(); recorder.observeActivity(event); } },
    checkpointPermission: (request) => checkpoint({ kind: "permission", request }),
    requestPermission: async (request) => {
      checkpoint({ kind: "permission", request });
      return { behavior: "deny", message: "Autonomous work stopped for a durable decision." };
    },
    askUser: async (requestId, questions) => {
      checkpoint({ kind: "question", requestId, questions });
      throw new Error("Autonomous work stopped for a durable decision.");
    },
  };
  // The host bridge reads and writes the real brain, outside the masks (#2690).
  const guardFor = (folders: readonly string[], typeFolders: Readonly<Record<string, readonly string[]>>): ProviderMaskGuard | undefined =>
    folders.length ? createProviderMaskGuard({ folders, policy: policy.policy, typeFolders,
      record: refusal => {
        try { governance({ kind: "provider_mask_refusal", turnId: input.turnId, sessionId: null, actor: "autonomous", model: null, profile: "restricted",
          payload: { ...refusal, policyHash: policy.hash } }); }
        catch (error) { deps.log?.emit({ severityText: "WARN", body: `governance event not recorded: ${error instanceof Error ? error.message : String(error)}` }); }
      } }) : undefined;
  // Index updates this turn's applications queued (#2835).
  let turnIndex: IndexBatch | undefined;
  // Installed once the turn's masks are resolved, before the backend starts.
  const installApplication = (request: StartTurnRequest, maskGuard: ProviderMaskGuard | undefined, tree: TurnDataTree, view: string): void => {
    const lock = input.application && deps.brainPath ? deps.backend.brainApplicationPolicy?.(request)?.lock : undefined;
    if (!input.application || !deps.brainPath || !lock) return;
    const root = deps.brainPath, approved = input.application.approved;
    let consumed = false;
    const current = (): boolean => !closed && !controller.signal.aborted && checkPrincipal();
    // The server owns this policy: nothing is auto-allowed, so every
    // application reaches `approve`, whatever the backend would allow.
    const apply = createBrainApplication({ root, principalId, turnId: input.turnId, signal: controller.signal,
      planner: deps.applicationPlanner ?? boundaryPlanner(createHostBoundary({ brainPath: root, nativeManager: deps.nativeManager, dbPath: deps.db.filename, identitySentinelDirectory: deps.identitySentinelDirectory })),
      policy: { autoAllowed: [], available: ["write", "edit", "add", "update", "archive", "staged"], enforceAllowedTools: true, lock },
      // The policy admitted for this turn protects its targets, as for a hosted turn (#2876).
      protectedPaths: protectedPaths(policy.policy),
      ...(maskGuard ? { providerMasks: { guard: maskGuard, tool: operation => applicationToolName(deps.backend.id, operation) } } : {}),
      isAuthorized: current,
      approve: async (proposal, destructive) => {
        const toolName = applicationToolName(deps.backend.id, proposal.operation);
        const proposed = JSON.parse(JSON.stringify(proposal)) as Record<string, unknown>;
        // One exact approved operation, applied once, still inside the
        // current envelope. Anything else is put to the user and not applied.
        if (!destructive && !consumed && approved && approved.toolName === toolName && canonical(approved.input) === canonical(proposed) &&
            inboxOperationAllowed(deps.backend.id, approved) && current()) {
          consumed = true;
          return true;
        }
        try {
          checkpoint({ kind: "permission", request: { toolUseId: `application-${crypto.randomUUID()}`, toolName, input: proposed,
            kind: destructive ? "command" : "tool", outsideEnforcedAllowlist: true,
            description: "Apply this exact bounded change to authoritative Markdown." } });
        } catch { /* recorded by checkpoint; nothing is applied */ }
        return false;
      },
      record: result => recorder.recordApplication?.(result),
      ...(deps.indexBatch ? { indexBatch: deps.indexBatch } : {}),
      recordIndex: outcome => recorder.recordApplicationIndex?.(outcome),
      // The envelope reads its own data tree (#2848); a masked one plans there too (#2846).
      turnTree: tree,
      ...(maskGuard ? { turnPlanner: async (_root, proposal, _read, planSignal) => validatePlan(await tree.planAdd(proposal, planSignal)) } : {}),
    });
    turnIndex = apply.indexBatch;
    bridge.awaitIndex = async (toolName, toolInput) => {
      const refusal = staleReadRefusal(tree, root, view, toolName, toolInput);
      if (refusal) throw new Error(refusal);
      if (readsIndex(toolName)) await tree.barrier(controller.signal);
    };
    bridge.readBrainBase = async (path) => {
      if (!current()) throw new Error("This turn no longer has current principal authority.");
      return readBrainApplicationBase(root, path, maskGuard
        ? { guard: maskGuard, tool: deps.backend.id === "claude" ? "mcp__brain-ui__brain_read_base" : "brain_read_base" } : undefined);
    };
    bridge.applyBrain = (proposal) => apply({ principalId, turnId: input.turnId, input: proposal });
  };
  const principalCheck = setInterval(checkPrincipal, 100);
  let startupView: WorkerStartupView | undefined, privateIndex: string | undefined, dataTree: TurnDataTree | undefined;
  // Marked before the checkpoint: its index may lack what is queued (#2848).
  const watermark = deps.indexBatch?.watermark();
  try {
    if (!deps.nativeManager) throw new BackendRequestError("Autonomous workers require the configured native brain manager; full-copy fallback is unsupported.");
    // The private index is mounted over `.brain-index/`, which the view must
    // hold; the host creates that directory, never a provider folder.
    if (masksFolders) ensureIndexDirectory(brainPath);
    const since = Date.now();
    startupView = await prepareNativeWorkerStartupView(brainPath, deps.nativeManager, controller.signal);
    controller.signal.throwIfAborted();
    if (!checkPrincipal()) throw new BackendRequestError("Autonomous principal is missing, expired or revoked.");
    // Types map onto folders as for hosted turns, judged on this view (#2694).
    let typeFolders: Record<string, string[]> = {};
    if (providerTypeSelectors(policy.policy).length) {
      const translated = await translateProviderTypesInView({ brainPath, policy: policy.policy, view: startupView, maskPaths: deps.privateIndex!.maskPaths,
        signal: controller.signal, appeared: root => appearedInView(deps.db, brainPath, root, since),
        ...(deps.privateIndex!.command ? { command: deps.privateIndex!.command } : {}) });
      if (translated.refused.length) throw new ProviderPolicyRefusedError(translated.refused);
      typeFolders = translated.folders;
    }
    const maskedFolders = providerMaskedFolders(policy.policy, typeFolders);
    // Option C (#2741): the origin thread must be shown compatible with the
    // masks before any of its text is read into the prompt. Refuses by name.
    admission = await admitOriginThread(deps.db, brainPath, { runId: input.turnId, threadId: origin.thread_id, masked: maskedFolders, policyHash: policy.hash });
    controller.signal.throwIfAborted();
    let workerProviderMasks: StartTurnRequest["workerProviderMasks"];
    if (maskedFolders.length) {
      // A mask hides names, not inodes (#2700). The envelope sees the startup
      // view; the live brain is checked too, as the view is taken from it.
      const hardlinks = [...new Map([startupView.root, brainPath].flatMap(root => providerHardlinks(root, maskedFolders)).map(link => [link.path, link])).values()];
      if (hardlinks.length) throw ProviderPolicyRefusedError.hardlinks(hardlinks);
      // As for a denied hosted turn (#1668): built from nothing through the
      // same masks, so it never held a masked document, and removed after.
      privateIndex = createPrivateIndexDirectory();
      const built = await buildPrivateIndex({ brainPath, startupView, folders: maskedFolders, index: privateIndex, maskPaths: deps.privateIndex!.maskPaths,
        signal: controller.signal, ...(deps.privateIndex!.command ? { command: deps.privateIndex!.command } : {}) });
      if (!built.ok) deps.log?.emit({ severityText: "WARN", body: `autonomous turn ${input.turnId} starts with an incomplete private search index: ${built.detail}` });
      controller.signal.throwIfAborted();
      workerProviderMasks = Object.freeze({ folders: Object.freeze([...maskedFolders]), index: privateIndex });
    }
    dataTree = await createTurnDataTree({ brainPath, view: startupView, maskPaths: deps.privateIndex?.maskPaths ?? [], mount: true, signal: controller.signal,
      ...(privateIndex ? { index: privateIndex, masks: { folders: maskedFolders, buildFolders: privateIndexBuildFolders(maskedFolders, startupView.root),
        types: providerDeniedTypes(policy.policy, undefined) } } : {}),
      pending: watermark?.paths() ?? [] });
    watermark?.release();
    // The thread is read last, under a revalidated admission.
    admission.revalidate();
    const context = input.compose ? await input.compose(admission) : { prompt: input.prompt, systemPromptAppend: input.systemPromptAppend };
    controller.signal.throwIfAborted();
    const request: StartTurnRequest = { prompt: context.prompt, profileId: input.profileId,
      signal: controller.signal, bridge, autonomous: modeFor(context.systemPromptAppend), enforceAllowedTools: true, noGrantSurface: true,
      workerStartupView: startupView, ...(workerProviderMasks ? { workerProviderMasks } : {}), ...(dataTree.mount ? { workerDataTree: dataTree.mount } : {}) };
    installApplication(request, guardFor(maskedFolders, typeFolders), dataTree, startupView.root);
    // Without applications, the turn's readers still wait for what its checkpoint index lacks.
    const tree = dataTree;
    if (!bridge.awaitIndex) bridge.awaitIndex = async (toolName, toolInput) => {
      const refusal = staleReadRefusal(tree, brainPath, startupView!.root, toolName, toolInput);
      if (refusal) throw new Error(refusal);
      if (readsIndex(toolName)) await tree.barrier(controller.signal);
    };
    await deps.backend.startTurn(request);
    if (!terminal) {
      outcome = failed ? "error" : controller.signal.aborted ? "cancelled" : "error";
      // A Claude failure before runtime identity has a bare error terminal.
      if (!controller.signal.aborted && !failed) failed = true;
    }
    return { runId: input.turnId, outcome, escalated, yielded };
  } catch (error) {
    if (!revoked && !failed && controller.signal.aborted && error === controller.signal.reason) {
      outcome = "cancelled";
      emit({ type: "error", code: "AUTONOMOUS_TURN_FAILED", message: "Autonomous turn cancelled before worker startup." });
      return { runId: input.turnId, outcome, escalated, yielded };
    }
    outcome = "error";
    emit({ type: "error", code: "AUTONOMOUS_TURN_FAILED", message: error instanceof Error ? error.message : String(error) });
    // The run's record says why its thread was refused (#2741); it names folders and ids, no thread text.
    if (error instanceof ProviderThreadRefusedError) failureReason = error.message;
    throw error;
  } finally {
    closed = true;
    clearInterval(principalCheck);
    input.signal.removeEventListener("abort", abort);
    try {
      await intake.close();
      // Flushed after the backend returns, before the terminal record. A failed
      // update is on each application's record; its paths stay queued.
      if (turnIndex?.pending()) await turnIndex.barrier().catch(() => {});
      // The run's earlier Activity writes, the flush's index outcome included,
      // commit off the event loop (#2814); with none pending, the terminal
      // below commits inside this transaction.
      await recorder.settled();
      // The backend has returned. Release its kernel lock under the operational
      // write lock, then settle before another connection can claim cleanup.
      deps.db.transaction(() => {
        lifetime.release();
        if ((escalated || yielded) && !failed && !revoked && outcome === "cancelled") recorder.recordAutonomousStop();
        recorder.finish(outcome, failureReason);
        if (yielded) finishYield(deps.db, input.turnId);
      }).immediate();
    } finally {
      watermark?.release();
      try { await dataTree?.close(); } finally { try { await startupView?.cleanup(); } finally { if (privateIndex) removePrivateIndexDirectory(privateIndex); } }
    }
  }
}

/** Key-order-insensitive JSON identity for exact operation comparison. */
function canonical(value: unknown): string {
  const sort = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(sort)
    : entry && typeof entry === "object" ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sort(v)]))
    : entry;
  return JSON.stringify(sort(value));
}

function clipUtf8(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  // Drop an incomplete trailing sequence rather than replacing it with bytes
  // that would make a supposedly bounded checkpoint exceed the limit.
  for (let end = limit; end >= limit - 3; end--) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); } catch { /* try the prior boundary */ }
  }
  return "";
}

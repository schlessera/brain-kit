import { linkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDER_RELAY_KEYS_NAME, PROVIDER_RELAY_SOCKET_NAME, heldCustomProviderKeys, startProviderRelay } from "@schlessera/brain-ui-sdk/internal";
import { protectedPaths } from "@schlessera/brain-common/internal/protected-paths";
import type { BackendBridge, StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { prepareTurnEgress } from "../../brain/turn-egress.js";
import { BudgetExceeded, BudgetUnavailable, inferenceBudgetContext, inferenceBudgetLimits } from "../../brain/turn-budgets.js";
import { sessionTaint } from "../../governance/session-taint.js";
import { withTrackFiles } from "../../tracks/read.js";
import { makeBridge, settleTurnIndex } from "../bridge.js";
import { withLocalContext } from "../local-exchanges.js";
import { acceptRequest } from "../recovery.js";
import type { WsHost } from "../host.js";
import type { LocalExchange } from "@schlessera/brain-ui-sdk/protocol";
import { heldProfile, isRelayed, type GovernedAdmission } from "./admission.js";
import type { TurnBudget } from "./budget.js";
import type { TurnRun } from "./types.js";

/**
 * Record a new conversation's local exchanges against the session its first
 * turn created, and tell every client whether each one is kept: the client
 * that ran them holds them in a draft that has just become this session.
 */
export function recordDraftExchanges(host: WsHost, sessionId: string, exchanges: readonly LocalExchange[]): void {
  for (const exchange of exchanges) {
    // Each is answered once it is stored (#2850).
    void (host.catalog.recordLocalExchange?.(sessionId, exchange, true) ?? Promise.resolve(false)).then(saved => host.sendToClients({
      type: "local_exchange_result",
      sessionId,
      exchangeId: exchange.id,
      saved,
      ...(saved ? {} : { reason: "The server could not store it." }),
    }));
  }
}

/** The message's source, recorded in the order the backend receives its text, which is the order replay counts identical texts in. */
function recordSource(run: TurnRun, sessionId: string): void {
  const { text, source, thinkingLevel, files } = run.current;
  run.host.catalog.recordMessageSource?.(sessionId, text, source ?? "typed", { thinkingLevel, turnId: run.turn.turnId, files });
}

/**
 * Build the turn's prompt and its event bridge. A resumed session records the
 * message source now; a new one does once session_info names it. Locally
 * answered commands the agent has not seen yet ride on this prompt (#582),
 * taken past the last admission await, so an exchange is only marked carried
 * by a prompt that is actually handed over. The source is recorded for the
 * user's text alone, which is what replay matches once the context is
 * stripped again.
 */
export async function openTurnBridge(
  run: TurnRun,
  admission: GovernedAdmission,
  budget: TurnBudget | undefined
): Promise<{ prompt: string; bridge: BackendBridge }> {
  const { host, slot, turn, backend, current, recorder, failureRecording, billing, held, origin, profileId, resumeId } = run;
  const { initial } = slot;
  const { text, files, work } = current;
  const governedHold = held.governedHold;
  if (resumeId && !current.refusedFollowUp) recordSource(run, resumeId);
  const drafted = slot.draftExchanges;
  slot.draftExchanges = [];
  const prompt = (initial.replayPrompt !== undefined && turn.turnId === slot.firstTurnId) ? initial.replayPrompt : withLocalContext(withTrackFiles(text, files), [
    ...drafted,
    ...(current.refusedFollowUp?.exchanges ?? []),
    ...(resumeId ? (host.catalog.takePendingLocalExchanges?.(resumeId) ?? []) : []),
  ]);
  turn.retryPrompt = prompt;
  const { preference } = admission;
  const bridge = await makeBridge(
    host,
    turn,
    text,
    backend.id,
    recorder,
    resumeId
      ? undefined
      : (sid) => {
          // A new conversation is accepted the moment it has a name,
          // and its turn is already running (#964).
          const revision = acceptRequest(host, sid, turn.requestId, backend.id);
          turn.revision = revision;
          if (revision !== undefined && turn.startedAt !== undefined) {
            host.catalog.dispatchWork?.(sid, revision, turn.turnId, backend.id, turn.startedAt);
          }
          void host.governedTurns?.bindSession(turn.turnId, sid).catch(() => { /* Its exposures stay unbound: a later turn treats the session as unrecorded. */ });
          recordSource(run, sid);
          recordDraftExchanges(host, sid, drafted);
          initial.handoffHooks?.onNamed(sid);
        },
    failureRecording.observe,
    // A follow-up's pill label is its turn's request label (#1004).
    () => current.label,
    backend.brainApplicationPolicy?.({ profileId,
      ...(work?.posture === "voice" ? { posture: "voice", noGrantSurface: true, enforceAllowedTools: true } : {}) }),
    governedHold ? protectedPaths(governedHold.policy.policy) : undefined,
    governedHold ? { origin, actualProfile: heldProfile(run),
      ...(initial.profileDraftId && !resumeId && preference ? { draftId: initial.profileDraftId, preference } : {}) } : undefined,
    budget?.observeUsage,
    billing,
    { current: () => run.mainModel, bind: model => {
      if (host.journal && governedHold && !host.journal.bindModel(run.turnId, turn.sessionId, model)) return;
      run.mainModel = model; recorder?.setMainModel(model);
    } },
    governedHold?.sandbox.providerMasks ? { folders: governedHold.sandbox.providerMasks.folders, policy: governedHold.policy,
      ...(governedHold.typeFolders ? { typeFolders: governedHold.typeFolders } : {}),
      ...(governedHold.sandbox.inferenceRecipient ? { recipient: governedHold.sandbox.inferenceRecipient.name } : {}) } : undefined,
    governedHold?.dataTree ? { tree: governedHold.dataTree, ...(governedHold.startupView ? { view: governedHold.startupView.root } : {}) } : undefined
  );
  // A failed update is already on each application's Activity record,
  // and its paths stay queued for the next reader; the turn still ends.
  held.settleIndex = () => settleTurnIndex(bridge).catch(() => {});
  const fallback = governedHold?.sandbox.fallbackReason;
  if (fallback) {
    const match = /Error: (.+?) is (?:a )?(symlink|hardlinked)/.exec(fallback);
    if (match || fallback.includes("another mount")) host.activity?.governance?.({
      kind: "strict_fallback", payload: { path: match?.[1] ?? ".", reason: match?.[2] === "symlink" ? "symlink" : match ? "hardlink" : "mount_point" },
      turnId: turn.turnId, sessionId: turn.sessionId, actor: origin, model: run.mainModel, profile: "strict",
    });
  }
  return { prompt, bridge };
}

/**
 * A governed or strict Claude or pi turn gets its own proxy and the host
 * inference relay (#1665). Admission already refused a turn whose startup
 * view is not on managed native storage (#3314). The CLI's
 * paid providers reach the network only through this relay, which holds
 * their keys, shares the turn's egress admission and meters each request on
 * the turn (#1673).
 */
export async function prepareRelayedEgress(run: TurnRun, bridge: BackendBridge, budget: TurnBudget | undefined): Promise<void> {
  const { host, turn, backend, abortController, held, stops, origin } = run;
  const governedHold = held.governedHold;
  const relayed = isRelayed(backend);
  if (governedHold?.sandbox.inferenceRecipient && !relayed)
    throw new Error("This turn's provider folders were admitted for a recipient its inference relay cannot enforce; retry the turn.");
  if (!governedHold || !relayed) return;
  const governance = host.activity?.governance, governanceWrites = host.activity?.governanceWrites;
  held.turnEgress = await prepareTurnEgress({ policy: governedHold.policy.policy, bridge, controller: abortController,
    turnId: turn.turnId, sessionId: () => turn.sessionId ?? null, model: () => run.mainModel,
    profile: heldProfile(run), origin,
    // A record's commit failure stops the turn, as a synchronous one did (#2850).
    ...(governanceWrites ? { record: (event: Parameters<typeof governanceWrites.record>[0]) => governanceWrites.record(event), governanceWrites }
      : governance ? { record: (event: Parameters<typeof governance>[0]) => governance(event) } : {}),
    ...(host.activity?.governanceDb ? { governanceDb: host.activity.governanceDb } : {}),
  });
  // The turn this relay meters, fixed now: a late report never lands on a later turn.
  const egress = held.turnEgress, hold = governedHold, relayTurnId = turn.turnId;
  held.providerRelay = startProviderRelay({ egress, ...(host.cliProviderOrigins ? { origins: host.cliProviderOrigins } : {}),
    admit: async () => {
      if (stops.budget) return { allowed: false, message: stops.budget.message };
      if (!host.budgets) return { allowed: true };
      try {
        const blocked = await host.budgets.providerAdmission(relayTurnId, hold.policy.policy);
        // The turn may have stopped while admission waited for earlier budget writes.
        const stopped = stops.budget as Error | undefined;
        if (stopped) return { allowed: false, message: stopped.message };
        return blocked ? { allowed: false, message: new BudgetExceeded(blocked, "mid_turn").message } : { allowed: true };
      } catch { return { allowed: false, message: new BudgetUnavailable().message }; }
    },
    observe: attempt => {
      if (!host.budgets) return;
      try {
        budget!.write(host.budgets.observeProvider(relayTurnId, attempt).then(result => {
          if (!result || stops.budget || abortController.signal.aborted || turn.cancelled) return;
          // A crossed block refuses each further relayed request (ruling D3 on
          // #1673); the agent's next completed response, which sees the same
          // scopes, stops the turn as any usage over a block does.
          budget!.warn(result.warnings);
        }));
      } catch { if (!stops.budget) budget!.unavailable(); }
    },
  });
  linkSync(held.providerRelay.socketPath, join(egress.dir, PROVIDER_RELAY_SOCKET_NAME));
  const customKeys = heldCustomProviderKeys(host.cliProviderOrigins);
  if (customKeys.length) writeFileSync(join(egress.dir, PROVIDER_RELAY_KEYS_NAME), `${customKeys.join("\n")}\n`, { mode: 0o640 });
}

/** The request the backend's startTurn receives for this admitted turn. */
export function turnRequest(run: TurnRun, prompt: string, bridge: BackendBridge): StartTurnRequest {
  const { host, turn, current, abortController, held, workerIdentity, turnId: scopeTurnId, profileId, resumeId } = run;
  const { attachments, client, thinkingLevel, work } = current;
  const { governedHold, turnEgress, worktreeGeneration, referenceViews } = held;
  // The session's recorded untrusted input, read live by outward admission and the note (G6).
  const governanceDb = host.activity?.governanceDb;
  const commandPolicy = governedHold?.sandbox.commandPolicy && governanceDb ? { ...governedHold.sandbox.commandPolicy,
    // A taint submitted to the write worker counts before it commits (#2850).
    taint: () => host.activity?.governanceWrites ? host.activity.governanceWrites.taint(turn.turnId, turn.sessionId ?? null)
      : sessionTaint(governanceDb, turn.turnId, turn.sessionId ?? null) } : governedHold?.sandbox.commandPolicy;
  return {
    applicationAuthority: "server",
    ...(host.journal && governedHold ? { persistClaudeMemory: (change, save) => host.journal!.persistClaudeMemory(turn.turnId, change, save) } : {}),
    ...(governedHold?.startupView ? { workerStartupView: governedHold.startupView } : {}),
    ...(host.scope && governedHold ? { workerStarted: worker => host.scope!.workerStarted(scopeTurnId, worker) } : {}),
    ...(host.journal && governedHold ? { toolExecution: (toolUseId, path) => host.journal!.toolExecuted(scopeTurnId, toolUseId, path) } : {}),
    ...(governedHold ? { workerSandbox: { ...governedHold.sandbox, ...(commandPolicy ? { commandPolicy } : {}), ...(turnEgress ? { egress: turnEgress } : {}),
      ...(worktreeGeneration ? { worktrees: { source: worktreeGeneration.path } } : {}), ...(referenceViews ? { references: referenceViews } : {}), noteFacts: {
      ...governedHold.sandbox.noteFacts,
      ...(workerIdentity ? { identity: workerIdentity } : {}),
      history: { journal: Boolean(host.journal && host.journal.summary(turn.turnId).state === "recording"),
        userRevert: Boolean(host.turnReverts && host.journal && host.journal.summary(turn.turnId).state === "recording" && work?.posture !== "voice") },
    } }, workerLock: host.workerLock } : {}),
    prompt,
    ...(host.budgets && governedHold ? {maxBudgetUsd:host.budgets.remaining(turn.turnId),
      sessionBudgetLimits: inferenceBudgetLimits(host.budgets.receipt(turn.turnId)),
      budgetContext: inferenceBudgetContext(host.budgets.receipt(turn.turnId)),
    } : {}),
    attachments,
    sessionId: resumeId,
    profileId,
    signal: abortController.signal,
    // The budget this very timer enforces, so the backend can put the
    // real number in front of the model instead of it finding the cap
    // mid-flight.
    turnBudgetMs: host.turnTimeoutMs,
    bridge: turnEgress?.bridge ?? bridge,
    turnId: turn.turnId,
    ...(client ? { client } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    // A new turn started by voice runs the voice posture: the backend's
    // named voice allowlist, enforced, with no surface that could grant
    // a card (docs/decisions/voice-permission.md). A backend without a
    // voice posture refuses the turn. A follow-up joining an ordinary
    // turn never gets here, so that turn keeps its posture.
    ...(work?.posture === "voice" ? { posture: "voice" as const, enforceAllowedTools: true, noGrantSurface: true } : {}),
  };
}

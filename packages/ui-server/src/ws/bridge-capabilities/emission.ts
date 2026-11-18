import { HOST_TIMEOUT_OUTCOME_DETAIL, stateRoomWarning } from "@schlessera/brain-ui-sdk/protocol";
import type { BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { TurnTextCollector } from "../../classification/classify-turn.js";
import type { ClaudeUsageEvidence } from "../claude-usage-accounting.js";
import { acceptDraft } from "../drafts.js";
import { withTurnScope } from "../frames.js";
import { emitTurnError } from "./turn-error.js";
import type { BridgeContext, BridgeSlice, MakeBridgeOptions } from "./context.js";

/** The words a timed-out turn's `status: cancelled` carries in `detail`. */
const TURN_TIMED_OUT = "Turn timed out";

type Frame = Parameters<BackendBridge["emit"]>[0];
type SessionInfoFrame = Extract<Frame, { type: "session_info" }>;
type ResultFrame = Extract<Frame, { type: "result" }>;

/**
 * What this bridge's turn said, shared by emission and activity. Scoped to the
 * bridge, so delayed classification/promotion cannot borrow a follow-up turn's
 * text or destinations when its coordinator slot is reused.
 */
export interface TurnTranscript {
  /**
   * The assistant text, kept as the client numbers its parts, for the
   * classification pass that runs after the result (D42). Cheap when no
   * classifier is configured: a few string appends.
   */
  readonly collector: TurnTextCollector | null;
  readonly promotedLinks: Map<string, string>;
  collectedSessionId: string | null;
  claudeUsage: ClaudeUsageEvidence | undefined;
  persistPromotedBlocks(): void;
}

export function createTurnTranscript(ctx: Pick<BridgeContext, "host" | "turn">): TurnTranscript {
  const { host, turn } = ctx;
  const transcript: TurnTranscript = {
    collector: host.classifier ? new TurnTextCollector() : null,
    promotedLinks: new Map<string, string>(),
    collectedSessionId: turn.sessionId,
    claudeUsage: undefined,
    persistPromotedBlocks: () => {
      if (transcript.collector && transcript.collectedSessionId) host.classifier?.rewriteLinks(transcript.collectedSessionId, transcript.collector.textParts(), transcript.promotedLinks);
    },
  };
  return transcript;
}

/** The turn fields a frame is stamped from, captured when the bridge is built. */
function captureFrameFields(ctx: BridgeContext) {
  const { turn } = ctx;
  return {
    thinkingLevel: turn.retryRequest?.thinkingLevel,
    // The draft this bridge's message was sent from (#979), and whether that
    // message named an existing session. Captured like requestId: a late frame
    // settles only this request's draft.
    draftRef: turn.draftRef,
    attachmentFileIds: turn.attachmentFileIds,
    draftPrincipalId: turn.principalId,
    resumedSession: turn.sessionId !== null,
  };
}

/** Correlation and thinking-level stamps every frame gets before anything reads it. */
function normalizeFrame(ctx: BridgeContext, thinkingLevel: ReturnType<typeof captureFrameFields>["thinkingLevel"], message: Frame): Frame {
  const { host, turn, turnId, requestId, backendId, signal } = ctx;
  let msg = message;
  // Pi preserves a bare acquisition error for direct SDK callers without
  // inventing a session. The hosted request has its own cancellation and
  // correlation, so preserve that terminal UI state only for this exact
  // no-identity cancellation; classified failures keep their error frame.
  if (backendId === "pi" && requestId && turn.turnId === turnId && turn.cancelled && signal.aborted
    && !turn.sessionId && msg.type === "error" && !msg.sessionId && !msg.failure
    && msg.code === "agent_error" && msg.message === "The turn was cancelled before a session was acquired.")
    msg = { type: "status", status: "cancelled", detail: "Cancelled before starting", requestId };
  // The host's hard turn limit, not someone's cancel, ended this turn:
  // its cancelled terminal says so, so the conversation can (#3356). Only
  // the timed-out turn's own frames, and never over a real cancel.
  if (turn.timedOutTurnId === turnId && turn.turnId === turnId && !turn.cancelled) {
    if (msg.type === "status" && msg.status === "cancelled") msg = { ...msg, detail: TURN_TIMED_OUT };
    else if (msg.type === "result" && msg.outcome === "cancelled") msg = { ...msg, outcomeDetail: HOST_TIMEOUT_OUTCOME_DETAIL };
  }
  if (msg.type === "error" && requestId) msg = { ...msg, requestId };
  if (msg.type === "session_info" || (msg.type === "status" && msg.effectiveThinkingLevel !== undefined)) {
    msg = { ...msg, ...(requestId ? { requestId } : {}), ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) };
    if (thinkingLevel !== undefined && msg.effectiveThinkingLevel !== undefined && turn.sessionId) {
      host.catalog.recordEffectiveThinkingLevel?.(turn.sessionId, turnId, msg.effectiveThinkingLevel);
    }
  }
  return msg;
}

/** A failed result the host may offer as a one-click Retry, and records for it. */
function offerRetry(ctx: BridgeContext, msg: ResultFrame): ResultFrame {
  const { host: { catalog }, turn, turnId, work } = ctx;
  const eligible = msg.failure && ["rate_limit", "overloaded", "server_error", "unknown"].includes(msg.failure.errorClass)
    && !msg.failure.authAction && (msg.outcome === "error" || (msg.outcome === undefined && msg.isError));
  if (eligible && msg.failure && turn.turnId === turnId && turn.retryRequest && turn.retryPrompt !== undefined && turn.queue.length === 0
    && !(turn.isManualRetry && msg.failure.errorClass === "unknown")
    // A client retry cannot restore host-work/native result identity.
    // Preserve once-only execution even under ordinary task policy.
    && work === undefined
    // File Retry needs a pre-reservation read to verify the exact original.
    // Older catalogs can still retain their text/image-only requests.
    && ((!turn.retryRequest.files?.length && !turn.retryRequest.attachmentRefs?.length) || catalog.peekRetry)) {
    if (catalog.saveRetryRequest?.(msg.sessionId, turnId, turn.principalId, { ...turn.retryRequest, ...(turn.providerId ? { providerId: turn.providerId } : {}) }, turn.retryPrompt, msg.failure)) {
      return { ...msg, retryOfTurnId: turnId };
    }
  }
  return msg;
}

/** Frame emission: stamps, persists and forwards every frame the backend emits. */
export function createEmission(ctx: BridgeContext, transcript: TurnTranscript,
  options: Pick<MakeBridgeOptions, "promptText" | "onSessionNamed" | "onTerminalFailure" | "onTurnResult" | "promptLabel" | "pricingContext">): BridgeSlice<"emit"> {
  const { host, turn, turnId, requestId, backendId, principalId, authorization, work, recorder, mainModel, workerProfile } = ctx;
  const { coordinator, catalog } = host;
  const { promptText, onTerminalFailure, onTurnResult, promptLabel, pricingContext } = options;
  const { thinkingLevel, draftRef, attachmentFileIds, draftPrincipalId, resumedSession } = captureFrameFields(ctx);
  let profileBound = false;
  let draftSettled = false;
  let labelAsked = false;
  let pendingSessionNamed = options.onSessionNamed;

  const onSessionInfo = (frame: SessionInfoFrame): SessionInfoFrame => {
    let msg = frame;
    if (turn.turnId === turnId) transcript.collectedSessionId = msg.sessionId;
    turn.sessionId = msg.sessionId;
    if (msg.providerId) turn.providerId = msg.providerId;
    // Echo the client's correlation id, so it can recognise which
    // announcement is its own rather than adopting the first to arrive.
    if (turn.draftId) msg = { ...msg, draftId: turn.draftId };
    // The host owns backend identity: stamp it authoritatively so an
    // injected backend that omits (or mislabels) it still scopes the
    // client's tool rendering correctly.
    msg = { ...msg, backendId };
    coordinator.bindSession(msg.sessionId, turn);
    // Persist ownership the moment the identity exists — a turn that
    // later fails or is cancelled must not leave an unowned transcript.
    // An authenticated typed request that created this session also binds
    // its owner, content-free, so the owner can delete it (#3337). Resumes
    // and host work bind nothing; the write binds only a new row.
    const creator = !resumedSession && work === undefined && turn.turnId === turnId && authorization.valid && host.isPrincipalAuthorized(principalId) ? principalId : undefined;
    catalog.persistSessionStub(msg.sessionId, promptText, turn.providerId, backendId, creator,creator?turnId:undefined);
    // Governance events recorded before the row existed join it now (#1651).
    catalog.bindGovernanceEvents?.(turnId, msg.sessionId);
    // A backend can ask immediately after this synchronous announcement.
    // Its approval must snapshot the committed identity, not the provisional
    // identity that this announcement is still reconciling on the writer.
    const pending = catalog.settled?.();
    if (pending) {
      ctx.sessionBinding.failed = false;
      ctx.sessionBinding.pending = pending;
      void pending.then(() => {
        if (ctx.sessionBinding.pending === pending) delete ctx.sessionBinding.pending;
      }, () => {
        if (ctx.sessionBinding.pending === pending) {
          delete ctx.sessionBinding.pending;
          ctx.sessionBinding.failed = true;
        }
      });
    }
    // Submitted after the catalog row; every share read/effect joins this queue.
    void host.inboxTools?.shares?.bind(turnId, msg.sessionId).catch(error => {
      turn.abortController.abort(error); emitTurnError(host, turn, error);
    });
    if (workerProfile && host.sessionProfiles && turn.turnId === turnId) {
      // Both commit after the row above (#2850); the frame reads them as submitted.
      const named = msg.sessionId;
      const unrecorded = (error: unknown) => host.log.emit({ severityText: "WARN", body: "session worker profile not recorded",
        attributes: { "session.id": named, error: error instanceof Error ? error.message : String(error) } });
      if (!profileBound && workerProfile.draftId && workerProfile.preference) {
        host.sessionProfiles.bind(turn.principalId, workerProfile.draftId, msg.sessionId).catch(unrecorded);
        profileBound = true;
      }
      host.sessionProfiles.record(msg.sessionId, workerProfile.origin, workerProfile.actualProfile).catch(unrecorded);
      msg = { ...msg, workerProfile: host.sessionProfiles.read(turn.principalId, "session", msg.sessionId) };
    }

    host.policyProposals?.bind(turnId, msg.sessionId).catch(() => { /* Its proposals keep a null session: unbound, never misattributed. */ });
    // The session's pill label follows its latest request (#1004), asked
    // for once its row exists, so the answer always has a row to land on.
    if (!labelAsked) {
      labelAsked = true;
      host.labels?.turnStarted(msg.sessionId, promptText, promptLabel?.());
    }
    if (draftRef && !draftSettled) {
      draftSettled = true;
      acceptDraft(host, { draftRef, sourceSessionId: host.dialogue.draftSource(turnId), sessionId: msg.sessionId, resumed: resumedSession, requestId, principalId: draftPrincipalId,
        ...(attachmentFileIds?.length ? { fileIds: attachmentFileIds } : {}) });
    }
    if (pendingSessionNamed) {
      const named = pendingSessionNamed;
      pendingSessionNamed = undefined;
      named(msg.sessionId);
    }
    if (thinkingLevel !== undefined && msg.effectiveThinkingLevel !== undefined) {
      host.catalog.recordEffectiveThinkingLevel?.(msg.sessionId, turnId, msg.effectiveThinkingLevel);
    }
    return msg;
  };

  const onResult = (result: ResultFrame): ResultFrame => {
    let msg = result;
    const { claudeUsage } = transcript;
    if (claudeUsage && turn.turnId === turnId) {
      catalog.persistSessionStub(msg.sessionId, promptText, turn.providerId, backendId);
      const costUsd = catalog.accountClaudeUsage?.(msg.sessionId, backendId, turnId, claudeUsage, resumedSession, { ...pricingContext, principalId });
      const { costUsd: _sessionCost, usage: _reportedUsage, ...terminal } = msg;
      msg = { ...terminal, ...(claudeUsage.completed ? { usage: claudeUsage.completed } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}) };
    }
    catalog.persistSession(msg, promptText, turn.providerId, backendId);
    if (turn.turnId === turnId && msg.stateRoom && msg.failure?.errorClass !== "session_too_large"
      && msg.failure?.errorClass !== "worker_state_exceeded" && msg.failure?.errorClass !== "worker_state_busy") {
      catalog.recordStateRoom?.(msg.sessionId, msg.stateRoom);
      if (stateRoomWarning(msg.stateRoom)) catalog.recordGovernanceEvent?.({
        kind: "state_room_warning", sessionId: msg.sessionId, turnId,
        actor: work?.posture === "voice" ? "voice" : "interactive", model: mainModel?.current() ?? null, profile: null,
        payload: { usedBytes: msg.stateRoom.usedBytes, allowanceBytes: msg.stateRoom.allowanceBytes, observedAt: msg.stateRoom.observedAt },
        dedupeKey: `state-room:${backendId}:${msg.sessionId}:${msg.stateRoom.allowanceBytes}`,
      });
    }
    if (turn.turnId === turnId && msg.failure && (msg.outcome === "error" || (msg.outcome === undefined && msg.isError))) {
      onTerminalFailure?.(msg.sessionId, msg.failure);
    }
    if (turn.turnId === turnId) onTurnResult?.(msg.sessionId);
    return offerRetry(ctx, msg);
  };

  // Runs after the result frame went out.
  const afterResult = (msg: ResultFrame): void => {
    // Only the live turn's own result may set its disposition — a late
    // frame through a previous turn's bridge must not relabel this one.
    if (turn.turnId === turnId) {
      turn.lastResult =
        msg.isError || msg.outcome === "error"
          ? "error"
          : msg.outcome === "cancelled"
            ? "cancelled"
            : "success";
    }
    const { collector } = transcript;
    if (
      collector &&
      host.classifier &&
      turn.turnId === turnId &&
      turn.lastResult === "success"
    ) {
      // After the result, never before, and never awaited: the answer is
      // on screen already; this only says which spans to draw as blocks.
      const sessionId = msg.sessionId;
      transcript.collectedSessionId = sessionId;
      void host.classifier.run(sessionId, collector.textParts()).then((blocks) => {
        if (blocks.length === 0) return;
        transcript.persistPromotedBlocks();
        host.sendToClients(
          withTurnScope({ type: "message_blocks", sessionId, blocks }, turn, turnId)
        );
      });
    }
  };

  return {
    emit: (message) => {
      let msg = normalizeFrame(ctx, thinkingLevel, message);
      if ((msg.type === "tool_use_start" || msg.type === "tool_use_complete") && turn.turnId === turnId) {
        host.journal?.toolStarted(turnId, msg.toolUseId, msg.toolName, msg.type === "tool_use_start");
        host.scope?.toolCall(turnId, msg.toolUseId);
      }
      // Never awaited here: an observation's hold freezes the turn's workers,
      // which is what delays a worker's next provider request (#2834).
      if (msg.type === "tool_result" && turn.turnId === turnId) void host.journal?.toolEnded(turnId, msg.toolUseId).catch(error => { turn.abortController.abort(error); emitTurnError(host, turn, error); });
      if (transcript.collector && turn.turnId === turnId) transcript.collector.observe(msg);
      if (msg.type === "session_info") msg = onSessionInfo(msg);
      if (msg.type === "result") msg = onResult(msg);
      // The span write is submitted before the frame goes out, in frame order;
      // it commits off the event loop (#2814), and the live Activity stream
      // pumps it once committed. Late frames through a previous turn's bridge
      // stay un-recorded — the recorder belongs to ONE turn identity.
      if (turn.turnId === turnId) recorder?.observeFrame(msg);
      const scoped = withTurnScope(msg, turn, turnId);
      if (msg.type === "session_info") work?.observe(scoped);
      host.sendToClients(scoped);
      // Identity must reach the client before its first scoped journal receipt.
      // The journal publishes its receipt once the binding commits, after this frame.
      if (msg.type === "session_info" && turn.turnId === turnId) { void host.budgets?.bind(turnId, msg.sessionId).catch(() => { /* The turn's accounting is unavailable; its next observation stops it. */ }); void host.journal?.bindSession(turnId, msg.sessionId).catch(() => { /* The turn's record stays unbound; its observations still commit. */ }); host.scope?.bindSession(turnId, msg.sessionId); }
      if (msg.type !== "session_info") work?.observe(scoped);
      if (msg.type === "result") afterResult(msg);
    },
  };
}

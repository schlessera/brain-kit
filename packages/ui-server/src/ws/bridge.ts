import type {
  ActivityQuery,
  BackendBridge,
  PermissionDecision,
  AskUserResult,
  AskUserListResult,
  AskUserRankResult,
  AskUserFormResult,
  LocationFix,
} from "@schlessera/brain-ui-sdk/server";
import { askUserFormSpec, BackendBusyError, BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import type { ApprovalChannel } from "@schlessera/brain-ui-sdk/protocol";
import type { TurnFailure } from "@schlessera/brain-ui-sdk/protocol";
import { approvalRequestFrame, withTurnScope } from "./frames.js";
import type { RunningTurn } from "./turns.js";
import type { WsHost } from "./host.js";
import type { TurnRecorder } from "../activity/recorder.js";
import { TurnTextCollector } from "../classification/classify-turn.js";

/** Build the per-turn bridge the backend drives. */
export function makeBridge(
  host: WsHost,
  turn: RunningTurn,
  promptText: string,
  backendId: string,
  recorder?: TurnRecorder,
  /**
   * Called once, with the first session id `session_info` names. A new
   * conversation has no id until then, so anything keyed by the session
   * that must be written for this turn's prompt waits for it here.
   */
  onSessionNamed?: (sessionId: string) => void,
  onTerminalFailure?: (sessionId: string, failure: TurnFailure) => void
): BackendBridge {
  const { coordinator, catalog } = host;
  // Capture the turn identity at construction: the slot's turnId is re-minted
  // for each queued follow-up, and a backend can still emit late frames
  // through this bridge after its startTurn resolved. Stamping from the live
  // field would attribute those to the NEXT turn.
  const turnId = turn.turnId;
  const requestId = turn.requestId;
  const thinkingLevel = turn.retryRequest?.thinkingLevel;
  let pendingSessionNamed = onSessionNamed;
  const queryActivity = host.activity?.query;
  // The assistant text, kept as the client numbers its parts, for the
  // classification pass that runs after the result (D42). Cheap when no
  // classifier is configured: a few string appends.
  const collector = host.classifier ? new TurnTextCollector() : null;
  return {
    // A bridge tool that wrote into the scratch area prunes it through the
    // host's pass (#310), the way the CLI's own writers prune after a write.
    ...(host.scratchPrune ? { pruneScratch: host.scratchPrune } : {}),
    emit: (message) => {
      let msg = message;
      if (msg.type === "error" && requestId) msg = { ...msg, requestId };
      if (msg.type === "session_info" || (msg.type === "status" && msg.effectiveThinkingLevel !== undefined)) {
        msg = { ...msg, ...(requestId ? { requestId } : {}), ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) };
        if (thinkingLevel !== undefined && msg.effectiveThinkingLevel !== undefined && turn.sessionId) {
          host.catalog.recordEffectiveThinkingLevel?.(turn.sessionId, turnId, msg.effectiveThinkingLevel);
        }
      }
      if (collector && turn.turnId === turnId) collector.observe(msg);
      if (msg.type === "session_info") {
        turn.sessionId = msg.sessionId;
        if (msg.providerId) turn.providerId = msg.providerId;
        // Echo the client's correlation id, so it can recognise which
        // announcement is its own rather than adopting the first to arrive.
        if (turn.draftId) msg = { ...msg, draftId: turn.draftId };
        // The host owns backend identity: stamp it authoritatively so an
        // injected backend that omits (or mislabels) it still scopes the
        // client's tool rendering correctly.
        msg = { ...msg, backendId };
        coordinator.bySession.set(msg.sessionId, turn);
        // Persist ownership the moment the identity exists — a turn that
        // later fails or is cancelled must not leave an unowned transcript.
        catalog.persistSessionStub(msg.sessionId, promptText, turn.providerId, backendId);
        if (pendingSessionNamed) {
          const named = pendingSessionNamed;
          pendingSessionNamed = undefined;
          named(msg.sessionId);
        }
        if (thinkingLevel !== undefined && msg.effectiveThinkingLevel !== undefined) {
          host.catalog.recordEffectiveThinkingLevel?.(msg.sessionId, turnId, msg.effectiveThinkingLevel);
        }
      }
      if (msg.type === "result") {
        catalog.persistSession(msg, promptText, turn.providerId, backendId);
        if (turn.turnId === turnId && msg.failure && (msg.outcome === "error" || (msg.outcome === undefined && msg.isError))) {
          onTerminalFailure?.(msg.sessionId, msg.failure);
        }
        const eligible = msg.failure && ["rate_limit", "overloaded", "server_error", "unknown"].includes(msg.failure.errorClass)
          && !msg.failure.authAction && (msg.outcome === "error" || (msg.outcome === undefined && msg.isError));
        if (eligible && msg.failure && turn.turnId === turnId && turn.retryRequest && turn.retryPrompt !== undefined && turn.queue.length === 0
          && !(turn.isManualRetry && msg.failure.errorClass === "unknown")
          // File Retry needs a pre-reservation read to verify the exact original.
          // Older catalogs can still retain their text/image-only requests.
          && (!turn.retryRequest.files?.length || catalog.peekRetry)) {
          if (catalog.saveRetryRequest?.(msg.sessionId, turnId, turn.principalId, { ...turn.retryRequest, ...(turn.providerId ? { providerId: turn.providerId } : {}) }, turn.retryPrompt, msg.failure)) {
            msg = { ...msg, retryOfTurnId: turnId };
          }
        }
      }
      // Persist-then-emit: the span write commits before the frame goes out,
      // so a subscriber's snapshot can never be behind what it just saw live.
      // Late frames through a previous turn's bridge stay un-recorded — the
      // recorder belongs to ONE turn identity.
      if (turn.turnId === turnId) recorder?.observeFrame(msg);
      host.sendToClients(withTurnScope(msg, turn, turnId));
      if (msg.type === "result") {
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
        if (
          collector &&
          host.classifier &&
          turn.turnId === turnId &&
          turn.lastResult === "success"
        ) {
          // After the result, never before, and never awaited: the answer is
          // on screen already; this only says which spans to draw as blocks.
          const sessionId = msg.sessionId;
          void host.classifier.run(sessionId, collector.textParts()).then((blocks) => {
            if (blocks.length === 0) return;
            host.sendToClients(
              withTurnScope({ type: "message_blocks", sessionId, blocks }, turn, turnId)
            );
          });
        }
      }
    },
    requestPermission: (req) => {
      // A remembered "always allow" answers grantable tool requests without
      // a card. NEVER for kind "command" — those are destructive-pattern
      // confirmations for tools that are already auto-allowed, and
      // remembering them would silently disable the seatbelt. NEVER either
      // when the backend says the turn's enforced allowlist left this tool
      // out: the grant was given under a wider posture and answering with it
      // would make the narrower one decoration.
      //
      // The store is still READ for such a request, and only read: a grant
      // that exists and is deliberately not applied is the thing worth a
      // record, and there is nothing to record without looking. What the
      // enforced posture forbids is answering from the store (here) and
      // adding to it (dispatch.ts) — not knowing what is in it.
      const remembered =
        req.kind !== "command" && host.toolPermissions?.isAutoAllowed(req.toolName) === true;
      if (remembered && req.outsideEnforcedAllowlist) {
        // Body stays constant and the reason rides as an attribute, matching
        // the refusal dispatch.ts records on the write side. A reason spliced
        // into the body reads better in a terminal and aggregates worse: two
        // halves of one policy would not group, and neither would two reasons
        // for the same half.
        host.log.emit({
          severityText: "INFO",
          body: "remembered tool grant not applied",
          attributes: {
            "tool.name": req.toolName,
            "toolUse.id": req.toolUseId,
            reason: "outside this turn's enforced allowlist",
          },
        });
      }
      if (remembered && !req.outsideEnforcedAllowlist) {
        return Promise.resolve({ behavior: "allow" });
      }
      return new Promise<PermissionDecision>((resolve) => {
        if (coordinator.collidesAcrossTurns(coordinator.pendingApprovals, req.toolUseId, turn)) {
          resolve({ behavior: "deny", message: "Duplicate tool-approval id" });
          return;
        }
        // The decision stamps the wait/execution boundary on the tool span
        // (grant) or lands the denied outcome (deny) before the backend's
        // own error tool_result can mislabel it — write-once protects it.
        const recorded = (
          decision: PermissionDecision,
          response?: { principalId: string; always?: boolean; channel?: ApprovalChannel }
        ) => {
          recorder?.onApprovalDecision(
            req.toolUseId,
            decision.behavior === "deny"
              ? "deny"
              : response?.always
                ? "always_allow"
                : "allow",
            req.kind ?? "tool",
            response?.principalId,
            response?.channel
          );
          resolve(decision);
        };
        coordinator.pendingApprovals.set(req.toolUseId, {
          turn,
          turnId,
          request: req,
          resolve: recorded,
        });
        if (!host.clients.hasClients()) {
          // Not a failure — the card is parked and re-delivered on reconnect
          // (see resendPendingInteractive) — but the wait was invisible before
          // this line existed, and it is bounded only by the turn timeout.
          host.log.emit({
            severityText: "WARN",
            body: "approval requested with no client connected; holding for reconnect",
            attributes: { "tool.name": req.toolName, "toolUse.id": req.toolUseId },
          });
        }
        host.sendToClients(
          withTurnScope(
            approvalRequestFrame(req, host.toolPermissions !== null),
            turn,
            turnId
          )
        );
        host.sendToClients(
          withTurnScope(
            { type: "status", status: "tool_executing", detail: `Waiting for approval: ${req.toolName}` },
            turn,
            turnId
          )
        );
      });
    },
    ...(recorder
      ? { activity: (event: Parameters<NonNullable<BackendBridge["activity"]>>[0]) => recorder.observeActivity(event) }
      : {}),
    ...(queryActivity
      ? { queryActivity: async (query: ActivityQuery) => queryActivity(query) }
      : {}),
    askUser: (requestId, questions) => {
      return new Promise<AskUserResult>((resolve, reject) => {
        if (
          coordinator.collidesAcrossTurns(coordinator.pendingAskUser, requestId, turn) ||
          coordinator.pendingAskUserList.has(requestId) ||
          coordinator.pendingAskUserRank.has(requestId) ||
          coordinator.pendingAskUserForm.has(requestId)
        ) {
          reject(new Error("Duplicate ask-user request id"));
          return;
        }
        coordinator.pendingAskUser.set(requestId, {
          turn,
          turnId,
          requestId,
          questions,
          resolve,
          reject,
        });
        host.sendToClients(
          withTurnScope({ type: "ask_user_request", requestId, questions }, turn, turnId)
        );
        host.sendToClients(
          withTurnScope(
            { type: "status", status: "tool_executing", detail: "Waiting for your input" },
            turn,
            turnId
          )
        );
      });
    },
    askUserList: (requestId, request) => {
      return new Promise<AskUserListResult>((resolve, reject) => {
        // One id space across all ask kinds: a single `ask_user_cancel`
        // dismisses any of them, so an id pending as one must not open as the other.
        if (
          coordinator.collidesAcrossTurns(coordinator.pendingAskUserList, requestId, turn) ||
          coordinator.pendingAskUser.has(requestId) ||
          coordinator.pendingAskUserRank.has(requestId) ||
          coordinator.pendingAskUserForm.has(requestId)
        ) {
          reject(new Error("Duplicate ask-user request id"));
          return;
        }
        coordinator.pendingAskUserList.set(requestId, {
          turn,
          turnId,
          requestId,
          request,
          resolve,
          reject,
        });
        host.sendToClients(
          withTurnScope({ type: "ask_user_list_request", requestId, ...request }, turn, turnId)
        );
        host.sendToClients(
          withTurnScope(
            { type: "status", status: "tool_executing", detail: "Waiting for your input" },
            turn,
            turnId
          )
        );
      });
    },
    askUserRank: (requestId, request) => {
      // Cancellation shares one id space across all four ask kinds.
      if (coordinator.pendingAskUserRank.has(requestId) || coordinator.pendingAskUser.has(requestId) || coordinator.pendingAskUserList.has(requestId) || coordinator.pendingAskUserForm.has(requestId)) {
        return Promise.reject(new Error("Duplicate ask-user request id"));
      }
      return new Promise<AskUserRankResult>((resolve, reject) => {
        coordinator.pendingAskUserRank.set(requestId, { turn, turnId, requestId, request, resolve, reject });
        host.sendToClients(withTurnScope({ type: "ask_user_rank_request", requestId, ...request }, turn, turnId));
        host.sendToClients(withTurnScope({ type: "status", status: "tool_executing", detail: "Waiting for your input" }, turn, turnId));
      });
    },
    askUserFormLimits: host.askUserFormLimits,
    askUserForm: (requestId, request) => {
      const validated = askUserFormSpec(request, host.askUserFormLimits);
      if (coordinator.pendingAskUserForm.has(requestId) || coordinator.pendingAskUser.has(requestId) || coordinator.pendingAskUserList.has(requestId) || coordinator.pendingAskUserRank.has(requestId)) {
        return Promise.reject(new Error("Duplicate ask-user request id"));
      }
      return new Promise<AskUserFormResult>((resolve, reject) => {
        coordinator.pendingAskUserForm.set(requestId, { turn, turnId, requestId, request: validated, resolve, reject });
        host.sendToClients(withTurnScope({ type: "ask_user_form_request", requestId, ...validated }, turn, turnId));
        host.sendToClients(withTurnScope({ type: "status", status: "tool_executing", detail: "Waiting for your input" }, turn, turnId));
      });
    },
    getLocation: (options) => {
      if (!host.clients.hasClients()) {
        return Promise.reject(
          new Error(`No ${host.appName} client is connected to read the location from.`)
        );
      }
      const requestId = coordinator.nextLocationRequestId();
      return new Promise<LocationFix>((resolve, reject) => {
        if (coordinator.collidesAcrossTurns(coordinator.pendingLocation, requestId, turn)) {
          reject(new Error("Duplicate location request id"));
          return;
        }
        coordinator.pendingLocation.set(requestId, { turn, turnId, resolve, reject });
        host.sendToClients(
          withTurnScope({ type: "location_request", requestId, options }, turn, turnId)
        );
        host.sendToClients(
          withTurnScope(
            { type: "status", status: "tool_executing", detail: "Requesting your location" },
            turn,
            turnId
          )
        );
      });
    },
    requestMask: (imagePath, instruction) => {
      if (!host.clients.hasClients()) {
        return Promise.reject(
          new Error(`No ${host.appName} client is connected to paint a mask in.`)
        );
      }
      const requestId = coordinator.nextMaskRequestId();
      return new Promise<Uint8Array>((resolve, reject) => {
        if (coordinator.collidesAcrossTurns(coordinator.pendingMask, requestId, turn)) {
          reject(new Error("Duplicate mask request id"));
          return;
        }
        coordinator.pendingMask.set(requestId, { turn, turnId, resolve, reject });
        host.sendToClients(
          withTurnScope({ type: "mask_request", requestId, imagePath, instruction }, turn, turnId)
        );
        host.sendToClients(
          withTurnScope(
            { type: "status", status: "tool_executing", detail: "Waiting for you to mark the area" },
            turn,
            turnId
          )
        );
      });
    },
  };
}

export function emitTurnError(host: WsHost, turn: RunningTurn, err: unknown): void {
  const correlation = turn.requestId ? { requestId: turn.requestId } : {};
  // startTurn resolves for runtime failures (it emits its own error frame); it
  // only rejects for caller errors. Each rejection is reported server-side
  // too — the frame alone leaves no trace once the browser tab is gone.
  if (err instanceof BackendBusyError) {
    host.reportTurnFailed("SESSION_BUSY", turn);
    host.sendToClients(
      withTurnScope(
        { type: "error", code: "SESSION_BUSY", message: "That session already has a running turn.", ...correlation },
        turn
      )
    );
  } else if (err instanceof BackendRequestError) {
    host.reportTurnFailed("BACKEND_REQUEST_ERROR", turn, err.message);
    host.sendToClients(
      withTurnScope({ type: "error", code: "BACKEND_REQUEST_ERROR", message: err.message, ...correlation }, turn)
    );
  } else {
    const message = err instanceof Error ? err.message : String(err);
    host.reportTurnFailed("BACKEND_ERROR", turn, message);
    host.sendToClients(
      withTurnScope({ type: "error", code: "BACKEND_ERROR", message, ...correlation }, turn)
    );
  }
}

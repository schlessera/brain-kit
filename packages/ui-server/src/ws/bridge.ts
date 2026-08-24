import type {
  ActivityQuery,
  BackendBridge,
  PermissionDecision,
  AskUserResult,
  LocationFix,
} from "@schlessera/brain-ui-sdk/server";
import { BackendBusyError, BackendRequestError } from "@schlessera/brain-ui-sdk/server";
import { withTurnScope } from "./frames.js";
import type { RunningTurn } from "./turns.js";
import type { WsHost } from "./host.js";
import type { TurnRecorder } from "../activity/recorder.js";

/** Build the per-turn bridge the backend drives. */
export function makeBridge(
  host: WsHost,
  turn: RunningTurn,
  promptText: string,
  backendId: string,
  recorder?: TurnRecorder
): BackendBridge {
  const { coordinator, catalog } = host;
  // Capture the turn identity at construction: the slot's turnId is re-minted
  // for each queued follow-up, and a backend can still emit late frames
  // through this bridge after its startTurn resolved. Stamping from the live
  // field would attribute those to the NEXT turn.
  const turnId = turn.turnId;
  const queryActivity = host.activity?.query;
  return {
    emit: (message) => {
      let msg = message;
      if (msg.type === "session_info") {
        turn.sessionId = msg.sessionId;
        if (msg.providerId) turn.providerId = msg.providerId;
        // Echo the client's correlation id, so it can recognise which
        // announcement is its own rather than adopting the first to arrive.
        if (turn.draftId) msg = { ...msg, draftId: turn.draftId };
        coordinator.bySession.set(msg.sessionId, turn);
        // Persist ownership the moment the identity exists — a turn that
        // later fails or is cancelled must not leave an unowned transcript.
        catalog.persistSessionStub(msg.sessionId, promptText, turn.providerId, backendId);
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
        catalog.persistSession(msg, promptText, turn.providerId, backendId);
      }
    },
    requestPermission: (req) => {
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
          {
            type: "tool_approval_request",
            toolUseId: req.toolUseId,
            toolName: req.toolName,
            input: req.input,
            description: req.description,
          },
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
      return new Promise<PermissionDecision>((resolve) => {
        if (coordinator.collidesAcrossTurns(coordinator.pendingApprovals, req.toolUseId, turn)) {
          resolve({ behavior: "deny", message: "Duplicate tool-approval id" });
          return;
        }
        // The decision stamps the wait/execution boundary on the tool span
        // (grant) or lands the denied outcome (deny) before the backend's
        // own error tool_result can mislabel it — write-once protects it.
        const recorded = (decision: PermissionDecision) => {
          recorder?.onApprovalDecision(req.toolUseId, decision.behavior === "allow");
          resolve(decision);
        };
        coordinator.pendingApprovals.set(req.toolUseId, {
          turn,
          turnId,
          request: req,
          resolve: recorded,
        });
      });
    },
    ...(recorder
      ? { activity: (event: Parameters<NonNullable<BackendBridge["activity"]>>[0]) => recorder.observeActivity(event) }
      : {}),
    ...(queryActivity
      ? { queryActivity: async (query: ActivityQuery) => queryActivity(query) }
      : {}),
    askUser: (requestId, questions) => {
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
      return new Promise<AskUserResult>((resolve, reject) => {
        if (coordinator.collidesAcrossTurns(coordinator.pendingAskUser, requestId, turn)) {
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
      });
    },
    getLocation: (options) => {
      if (!host.clients.hasClients()) {
        return Promise.reject(
          new Error(`No ${host.appName} client is connected to read the location from.`)
        );
      }
      const requestId = coordinator.nextLocationRequestId();
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
      return new Promise<LocationFix>((resolve, reject) => {
        if (coordinator.collidesAcrossTurns(coordinator.pendingLocation, requestId, turn)) {
          reject(new Error("Duplicate location request id"));
          return;
        }
        coordinator.pendingLocation.set(requestId, { turn, turnId, resolve, reject });
      });
    },
    requestMask: (imagePath, instruction) => {
      if (!host.clients.hasClients()) {
        return Promise.reject(
          new Error(`No ${host.appName} client is connected to paint a mask in.`)
        );
      }
      const requestId = coordinator.nextMaskRequestId();
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
      return new Promise<Uint8Array>((resolve, reject) => {
        if (coordinator.collidesAcrossTurns(coordinator.pendingMask, requestId, turn)) {
          reject(new Error("Duplicate mask request id"));
          return;
        }
        coordinator.pendingMask.set(requestId, { turn, turnId, resolve, reject });
      });
    },
  };
}

export function emitTurnError(host: WsHost, turn: RunningTurn, err: unknown): void {
  // startTurn resolves for runtime failures (it emits its own error frame); it
  // only rejects for caller errors. Each rejection is reported server-side
  // too — the frame alone leaves no trace once the browser tab is gone.
  if (err instanceof BackendBusyError) {
    host.reportTurnFailed("SESSION_BUSY", turn);
    host.sendToClients(
      withTurnScope(
        { type: "error", code: "SESSION_BUSY", message: "That session already has a running turn." },
        turn
      )
    );
  } else if (err instanceof BackendRequestError) {
    host.reportTurnFailed("BACKEND_REQUEST_ERROR", turn, err.message);
    host.sendToClients(
      withTurnScope({ type: "error", code: "BACKEND_REQUEST_ERROR", message: err.message }, turn)
    );
  } else {
    const message = err instanceof Error ? err.message : String(err);
    host.reportTurnFailed("BACKEND_ERROR", turn, message);
    host.sendToClients(
      withTurnScope({ type: "error", code: "BACKEND_ERROR", message }, turn)
    );
  }
}

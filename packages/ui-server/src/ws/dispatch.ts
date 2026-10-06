import { resolveChatFiles, withTrackFiles } from "../tracks/read.js";
import { SHARE_MAX_FILES, SHARE_MAX_TOTAL_BYTES, type SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";
import { estimateDecodedBase64Bytes } from "./attachments.js";
import { PROTOCOL_REV_CLIENT_ECHO } from "@schlessera/brain-ui-sdk/protocol";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { WSContext } from "./clients.js";
import type { AuthorizationContext } from "./turns.js";
import { approvalRequestFrame, locationErrorText, withTurnScope } from "./frames.js";
import { sendSessionHistory } from "./history.js";
import { validateAttachments } from "./attachments.js";
import { handleChatMessage } from "./run-session.js";
import { cancelHandoffPreparation, handoffStatus, prepareHandoff, startHandoff } from "./handoff.js";
import { handleAskAnswer, handleAskAnswerStatus } from "./ask-answers.js";
import { resendPendingApprovals, resendPendingAsks } from "./resend.js";
import type { WsHost } from "./host.js";

/** Per-connection negotiation state, owned by the socket handler. */
export interface ConnectionState {
  /**
   * The transport is gone. Set by onClose, and separate from `authorization`
   * because a disconnect is not a revocation: work already underway keeps its
   * authority, but nothing may register new per-connection state afterwards.
   */
  closed?: boolean;
  /** Principal resolved once at the WebSocket upgrade boundary. */
  principal: import("../db/principals.js").Principal;
  /** Mutable in-memory decision invalidated synchronously by revocation. */
  authorization: AuthorizationContext;
  /** Revision the client declared via `client_hello`; absent means rev 2. */
  protocolRev?: number;
  /** Opt-in flags the client declared via `client_hello`. */
  capabilities?: Readonly<Record<string, boolean>>;
}

/**
 * Answer a permission reply that applied to nothing pending (#957): the host
 * says what actually happened instead of letting the sender assume. A reply
 * whose turn echo does not match the settled request learns `unknown` — it
 * was never about that request.
 */
function replyResolution(
  host: WsHost,
  ws: WSContext,
  connection: ConnectionState,
  toolUseId: string,
  echoed: string | undefined,
  requireEcho: boolean
): void {
  if (connection.capabilities?.toolResolution !== true) return;
  const record = host.coordinator.resolvedApprovals.get(toolUseId);
  if (record && turnIdMatches(record, echoed, requireEcho)) {
    host.sendMessage(ws, {
      type: "tool_resolution",
      toolUseId,
      outcome: record.outcome,
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      turnId: record.turnId,
      ...(record.channel ? { channel: record.channel } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
    });
    return;
  }
  host.sendMessage(ws, { type: "tool_resolution", toolUseId, outcome: "unknown", ...(echoed ? { turnId: echoed } : {}) });
}

/**
 * Does this reply's echoed turnId identify the turn that raised the request?
 *
 * A wrong id is always refused: a stale echo from before a reconnect or a
 * follow-up would resolve a different turn's pending promise.
 *
 * A MISSING id depends on who is speaking. A client that declared rev 3
 * promised to echo, so silence means the reply cannot be correlated and is
 * refused. A client that declared nothing is rev 2, where the field is
 * optional, and is still tolerated — that tolerance is the deprecation window,
 * and it is what lets this be enforced at all without breaking clients that
 * predate `client_hello`.
 */
export function turnIdMatches(
  pending: { turnId: string },
  echoed: string | undefined,
  requireEcho: boolean
): boolean {
  if (echoed === undefined) return !requireEcho;
  return echoed === pending.turnId;
}

export async function handleClientMessage(
  host: WsHost,
  ws: WSContext,
  msg: ClientMessage,
  connection: ConnectionState
): Promise<void> {
  // The socket callback schedules dispatch on a microtask. Revocation may land
  // after parsing but before this function begins, so repeat the in-memory
  // check at the actual dispatch boundary.
  if (
    connection.authorization.valid &&
    connection.authorization.expiresAt <= Date.now()
  ) {
    host.expireAuthorizationContexts();
  }
  if (!connection.authorization.valid) {
    host.reportDroppedFrame("revoked_principal");
    return;
  }
  const { coordinator, catalog } = host;
  const requireEcho = (connection.protocolRev ?? 2) >= PROTOCOL_REV_CLIENT_ECHO;
  switch (msg.type) {
    case "client_hello": {
      // Record what this connection speaks. Never rejected on version: a
      // future client declaring rev 9 is simply held to the rules this host
      // knows, and an unknown capability flag is ignored.
      connection.protocolRev = msg.protocolRev;
      connection.capabilities = { ...(msg.capabilities ?? {}) };
      host.clients.setCapabilities(ws, msg.capabilities);
      return;
    }

    case "chat_message": {
      if (msg.handoff) {
        await startHandoff(host, ws, { ...msg, handoff: msg.handoff }, connection);
        return;
      }
      const attachmentResult = validateAttachments(msg.attachments);
      if (!attachmentResult.ok) {
        host.sendMessage(ws, {
          type: "error",
          code: "ATTACHMENT_REJECTED",
          ...(msg.requestId ? { requestId: msg.requestId } : {}),
          message: attachmentResult.reason,
          ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
        });
        return;
      }
      let files: SharedFileMeta[];
      try {
        files = await resolveChatFiles(host.brainPath, msg.files);
        const bytes = files.reduce((n, f) => n + f.bytes, 0) + attachmentResult.attachments.reduce((n, f) => n + estimateDecodedBase64Bytes(f.data), 0);
        if (files.length + attachmentResult.attachments.length > SHARE_MAX_FILES || bytes > SHARE_MAX_TOTAL_BYTES) throw Error("Attached files exceed the message limits.");
      } catch (error) {
        host.sendMessage(ws, { type: "error", code: "ATTACHMENT_REJECTED", message: error instanceof Error ? error.message : "Track attachment refused.",
          ...(msg.requestId ? { requestId: msg.requestId } : {}), ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
        return;
      }
      if (!connection.authorization.valid) return;
      await handleChatMessage(host, ws, {
        authorization: connection.authorization,
        text: msg.text,
        sessionId: msg.sessionId,
        attachments: attachmentResult.attachments,
        ...(files.length ? { files } : {}),
        providerId: msg.providerId,
        client: msg.client,
        source: msg.source,
        draftId: msg.draftId,
        // Ignored entirely by a host that does not store drafts.
        ...(msg.draftRef && host.drafts ? { draftRef: msg.draftRef } : {}),
        thinkingLevel: msg.thinkingLevel,
        requestId: msg.requestId,
        ...(msg.localExchanges?.length ? { localExchanges: msg.localExchanges } : {}),
      });
      break;
    }

    case "handoff_status": {
      handoffStatus(host, ws, msg.handoffId);
      return;
    }

    case "handoff_prepare": {
      if (connection.closed) return;
      await prepareHandoff(host, ws, msg, connection);
      return;
    }

    case "handoff_prepare_cancel": {
      cancelHandoffPreparation(host, msg.handoffId, connection);
      return;
    }

    case "retry_status": {
      try {
        host.sendMessage(ws, catalog.retryReceipt?.(msg.sessionId, msg.requestId, connection.authorization.principalId)
          ?? { type: "retry_receipt", sessionId: msg.sessionId, requestId: msg.requestId, state: "unknown" });
      } catch {
        host.sendMessage(ws, { type: "retry_receipt", sessionId: msg.sessionId, requestId: msg.requestId, state: "unknown" });
      }
      return;
    }

    case "retry_turn": {
      const refuse = (message: string) => {
        const receipt = { type: "retry_receipt" as const, sessionId: msg.sessionId, requestId: msg.requestId, state: "refused" as const, message };
        try { host.sendMessage(ws, catalog.refuseRetry?.(msg.sessionId, msg.requestId, connection.authorization.principalId, message) ?? receipt); }
        catch { host.sendMessage(ws, receipt); }
      };
      try {
        // Replay a receipt even while its turn runs. A repeated request id
        // cannot become a queued follow-up, including after reconnect.
        const prior = catalog.retryReceipt?.(msg.sessionId, msg.requestId, connection.authorization.principalId);
        if (prior && prior.state !== "unknown") { host.sendMessage(ws, prior); return; }
        if (coordinator.bySession.has(msg.sessionId) || coordinator.startingBySession.has(msg.sessionId)) {
          refuse("This session is busy. Wait for the current turn to finish."); return;
        }
        if (coordinator.activeRuns() >= host.maxConcurrentSessions()) {
          refuse("The server is busy. Wait for a turn to finish and try again."); return;
        }
        const original = catalog.peekRetry?.(msg.sessionId);
        let files: import("@schlessera/brain-ui-sdk/protocol").SharedFileMeta[] | undefined;
        if (original?.request.files?.length && original.turnId === msg.failedTurnId && original.principalId === connection.authorization.principalId) {
          try {
            files = await resolveChatFiles(host.brainPath, original.request.files);
            if (!original.prompt.includes(withTrackFiles("", files))) { refuse("An original track changed. Start a new message with the current file instead."); return; }
          } catch { refuse("An original track is unavailable. Attach it again in a new message."); return; }
          if (!connection.authorization.valid) return;
          // File reads yield; repeat admission before consuming eligibility.
          if (coordinator.bySession.has(msg.sessionId) || coordinator.startingBySession.has(msg.sessionId) || coordinator.activeRuns() >= host.maxConcurrentSessions()) {
            refuse("The session or server became busy. Try again when it is free."); return;
          }
        }
        const reserved = catalog.reserveRetry?.(msg.sessionId, msg.failedTurnId, msg.requestId, connection.authorization.principalId, files ? original!.prompt : undefined);
        if (!reserved) { refuse("This server cannot retain the original request for Retry."); return; }
        host.sendMessage(ws, { ...reserved.receipt, ...(reserved.request ? {
          ...(files?.length ? { files } : {}),
          text: reserved.request.text, attachmentCount: reserved.request.attachments?.length ?? 0,
          source: reserved.request.source ?? "typed",
          ...(reserved.request.thinkingLevel !== undefined ? { thinkingLevel: reserved.request.thinkingLevel } : {}),
        } : {}) });
        if (reserved.request) {
          await handleChatMessage(host, ws, {
            ...reserved.request, authorization: connection.authorization,
            requestId: msg.requestId,
            attachments: reserved.request.attachments ?? [],
            files, replayPrompt: reserved.prompt, isRetry: true,
          });
        }
      } catch {
        // A failed database write must not execute an unacknowledged retry.
        refuse("The server could not confirm this retry. Check delivery before trying again.");
      }
      return;
    }

    case "local_exchange": {
      // A command the client answered itself (#582). Stored against the
      // session; the next prompt handed to the backend carries its context.
      // Answered either way, so the client can say when it is not kept.
      const saved = catalog.recordLocalExchange?.(msg.sessionId, msg.exchange, false) ?? false;
      host.sendMessage(ws, {
        type: "local_exchange_result",
        sessionId: msg.sessionId,
        exchangeId: msg.exchange.id,
        saved,
        ...(saved
          ? {}
          : {
              reason: catalog.recordLocalExchange
                ? "The server could not store it."
                : "This server does not keep local answers.",
            }),
      });
      return;
    }

    case "ask_user_response":
    case "ask_user_list_response":
    case "ask_user_rank_response":
    case "ask_user_form_response": {
      handleAskAnswer(host, ws, msg, connection.authorization.principalId);
      break;
    }

    case "ask_answer_status": {
      handleAskAnswerStatus(host, ws, msg, connection.authorization.principalId);
      return;
    }

    case "ping": {
      // Liveness (rev 5): answered at once, to this socket only. Anything the
      // client receives proves the path is open; the pong correlates it.
      host.sendMessage(ws, { type: "pong", probeId: msg.probeId });
      return;
    }

    case "ask_user_cancel": {
      // Dismisses any ask kind: the ids share one space.
      const pending =
        coordinator.pendingAskUser.get(msg.requestId) ??
        coordinator.pendingAskUserList.get(msg.requestId) ??
        coordinator.pendingAskUserRank.get(msg.requestId) ??
        coordinator.pendingAskUserForm.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        // Recorded as `cancelled`, so a queued answer arriving later is told
        // the question was dismissed instead of meeting silence.
        coordinator.cancelAsk(msg.requestId);
        pending.turn.recorder?.recordCancellation(
          connection.authorization.principalId,
          "ask_user"
        );
        pending.reject(new Error(msg.reason || "User cancelled the question"));
      }
      break;
    }

    case "location_response": {
      const pending = coordinator.pendingLocation.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingLocation.delete(msg.requestId);
        pending.resolve({ coords: msg.coords, timestamp: msg.timestamp });
      }
      break;
    }

    case "location_error": {
      const pending = coordinator.pendingLocation.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingLocation.delete(msg.requestId);
        pending.reject(new Error(locationErrorText(msg.code, msg.message)));
      }
      break;
    }

    case "mask_response": {
      const pending = coordinator.pendingMask.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingMask.delete(msg.requestId);
        // Decoded here rather than in the tool: the boundary already validated
        // the base64 and its size, so the backend gets bytes it can trust.
        pending.resolve(Uint8Array.from(Buffer.from(msg.maskPng, "base64")));
      }
      break;
    }

    case "mask_error": {
      const pending = coordinator.pendingMask.get(msg.requestId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingMask.delete(msg.requestId);
        pending.reject(
          new Error(
            msg.code === "cancelled"
              ? `The user did not mark an area${msg.message ? `: ${msg.message}` : ""}`
              : msg.message || "The mask editor failed"
          )
        );
      }
      break;
    }

    case "tool_approval": {
      const pending = coordinator.pendingApprovals.get(msg.toolUseId);
      if (!pending || !turnIdMatches(pending, msg.turnId, requireEcho)) {
        replyResolution(host, ws, connection, msg.toolUseId, msg.turnId, requireEcho);
      }
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        // Voice may deny; it may never grant (docs/decisions/voice-permission.md).
        // A grant attributed to voice is refused before anything else looks
        // at it: the request stays pending, nothing is recorded or
        // remembered, and the card is still there to answer it. The wire is
        // not trusted to enforce policy — a client offering no spoken grant
        // is not the reason this holds.
        if (msg.channel === "voice") {
          host.log.emit({
            severityText: "WARN",
            body: "voice-attributed grant refused",
            attributes: {
              "tool.name": pending.request.toolName,
              "toolUse.id": pending.request.toolUseId,
            },
          });
          // The sender treated its reply as the end of the exchange — a
          // client drops the request's turn correlation once it answers, and
          // may have cleared the card — so hand it the card again, exactly
          // as a reconnect would. Without this its next answer (the card's,
          // or a spoken denial) arrives uncorrelated and is dropped too.
          host.sendMessage(
            ws,
            withTurnScope(
              approvalRequestFrame(pending.request, host.toolPermissions !== null),
              pending.turn,
              pending.turnId
            )
          );
          break;
        }
        coordinator.pendingApprovals.delete(msg.toolUseId);
        // Remember-on-approve. Kind "command" never persists (the client
        // hides the option, but the wire is not trusted to enforce policy).
        // Neither does an approval given under an enforced allowlist that
        // this tool is outside of: the store is read by every OTHER turn, and
        // a grant made inside a narrower posture must not widen the ones the
        // user was not looking at. The call itself still runs — they approved
        // it — it is only the memory that is refused.
        // The store being absent is one of the reasons, not an exemption from
        // them: optional-chaining the add() away would take the "remembered"
        // branch, write nothing, log nothing, and still stamp the activity
        // record `always_allow` — the exact silent refusal this block exists
        // to rule out. Embedders wire a store (app.ts) so this is the
        // test/embedder path, which is precisely where a silent no-op is
        // hardest to notice.
        const store = host.toolPermissions;
        const remembers =
          store !== null &&
          pending.request.kind !== "command" &&
          !pending.request.outsideEnforcedAllowlist;
        if (msg.always && remembers) {
          store.add(pending.request.toolName);
        } else if (msg.always) {
          // The user asked for something the host will not do. Recorded for
          // the same reason the bridge records a grant it declines to apply:
          // a refusal nobody can see is indistinguishable from a bug, and for
          // kind "command" it also says a client sent an option its own UI
          // does not offer.
          host.log.emit({
            severityText: "INFO",
            body: "always-allow not remembered",
            attributes: {
              "tool.name": pending.request.toolName,
              "toolUse.id": pending.request.toolUseId,
              reason:
                store === null
                  ? "no grant store configured"
                  : pending.request.kind === "command"
                    ? "per-use confirmation"
                    : "outside this turn's enforced allowlist",
            },
          });
        }
        pending.resolve(
          msg.updatedInput
            ? { behavior: "allow", updatedInput: msg.updatedInput }
            : { behavior: "allow" },
          {
            principalId: connection.authorization.principalId,
            ...(msg.always && remembers ? { always: true } : {}),
            ...(msg.channel ? { channel: msg.channel } : {}),
          }
        );
        coordinator.recordApprovalOutcome(msg.toolUseId, {
          outcome: "granted",
          turnId: pending.turnId,
          sessionId: pending.turn.sessionId,
          ...(msg.channel ? { channel: msg.channel } : {}),
        });
      }
      break;
    }

    case "tool_denial": {
      const pending = coordinator.pendingApprovals.get(msg.toolUseId);
      if (pending && turnIdMatches(pending, msg.turnId, requireEcho)) {
        coordinator.pendingApprovals.delete(msg.toolUseId);
        pending.resolve(
          { behavior: "deny", message: msg.message },
          {
            principalId: connection.authorization.principalId,
            ...(msg.channel ? { channel: msg.channel } : {}),
          }
        );
        coordinator.recordApprovalOutcome(msg.toolUseId, {
          outcome: "denied",
          turnId: pending.turnId,
          sessionId: pending.turn.sessionId,
          ...(msg.channel ? { channel: msg.channel } : {}),
        });
      } else {
        // Already granted, expired, or never pending: a denial that lost a
        // race is told so, never confirmed (a visual grant stays a grant).
        replyResolution(host, ws, connection, msg.toolUseId, msg.turnId, requireEcho);
      }
      break;
    }

    case "cancel": {
      if (msg.sessionId) {
        const turn = coordinator.bySession.get(msg.sessionId);
        if (turn) {
          coordinator.recordCancellation(turn, connection.authorization.principalId);
          coordinator.cancelTurn(turn, "Cancelled by user");
        }
        // A cancel drops the session's queued follow-ups; a conversation's
        // committed-but-unsubmitted work in that session goes with them.
        host.conversations?.sessionCancelled(msg.sessionId);
        const starting = coordinator.startingBySession.get(msg.sessionId);
        if (starting) {
          starting.cancelled = true;
          // Releasing here, not in runSession: a start cancelled before it
          // becomes a turn never reaches the loop that would drain its queue.
          for (const entry of starting.queue.splice(0)) entry.releaseAuthorization();
          host.sendToClients({ type: "status", status: "idle", sessionId: msg.sessionId, detail: "Cancelled before starting" });
        }
        return;
      }
      // No sessionId: cancel the sole running session; ambiguous if several run.
      if (coordinator.running.size === 0) return;
      if (coordinator.running.size > 1) {
        host.sendMessage(ws, {
          type: "error",
          code: "CANCEL_AMBIGUOUS",
          message: "Several sessions are running — specify which to cancel.",
        });
        return;
      }
      const turn = [...coordinator.running][0]!;
      coordinator.recordCancellation(turn, connection.authorization.principalId);
      coordinator.cancelTurn(turn, "Cancelled by user");
      if (turn.sessionId) host.conversations?.sessionCancelled(turn.sessionId);
      break;
    }

    case "inbox_resolve":
    case "inbox_snooze": {
      if (connection.closed) break;
      if (!host.inbox?.handleDecision) {
        host.sendMessage(ws, { type: "error", code: "INBOX_UNAVAILABLE", message: "Inbox decisions are unavailable on this host." });
        break;
      }
      host.inbox.handleDecision(ws, msg, connection.authorization);
      break;
    }

    case "inbox_subscribe": {
      if (connection.closed) break;
      if (!host.inbox) {
        host.sendMessage(ws, { type: "error", code: "INBOX_UNAVAILABLE", message: "Inbox subscriptions are unavailable on this host." });
        break;
      }
      host.inbox.handleSubscribe(ws, msg, connection.authorization);
      break;
    }

    case "inbox_unsubscribe": {
      if (connection.closed) break;
      if (!host.inbox) {
        host.sendMessage(ws, { type: "error", code: "INBOX_UNAVAILABLE", message: "Inbox subscriptions are unavailable on this host." });
        break;
      }
      host.inbox.handleUnsubscribe(ws, msg);
      break;
    }

    case "activity_subscribe": {
      // View-scoped opt-in: without a subscription this connection never
      // receives an activity frame. No turn correlation — subscriptions are
      // connection state, not turn state.
      //
      // Dispatch starts on a microtask, so this can run after onClose already
      // dropped the connection's subscriptions. Registering here would resurrect
      // a dead socket in the registry and keep the activity poller alive for the
      // life of the process.
      if (connection.closed) break;
      host.activity?.stream.handleSubscribe(ws, msg, connection.authorization.principalId);
      break;
    }

    case "activity_unsubscribe": {
      host.activity?.stream.handleUnsubscribe(ws, msg);
      break;
    }

    case "conversation_start":
    case "conversation_audio":
    case "conversation_endpoint":
    case "conversation_commit":
    case "conversation_playback":
    case "conversation_stop": {
      if (connection.closed) break;
      const conversations = host.conversations;
      if (!conversations) {
        host.sendMessage(ws, { type: "error", code: "CONVERSATION_UNAVAILABLE", message: "Live conversation is not configured on this host." });
        break;
      }
      switch (msg.type) {
        case "conversation_start": await conversations.start(ws, connection, msg); break;
        case "conversation_audio": conversations.audio(ws, connection, msg); break;
        case "conversation_endpoint": conversations.endpoint(ws, connection, msg); break;
        case "conversation_commit": conversations.commit(ws, connection, msg); break;
        case "conversation_playback": conversations.playback(ws, connection, msg); break;
        case "conversation_stop": conversations.stop(ws, connection, msg); break;
      }
      break;
    }

    case "session_resume": {
      host.sendMessage(ws, {
        type: "session_info",
        sessionId: msg.sessionId,
        isNew: false,
        providerId: catalog.getStoredProviderId(msg.sessionId) ?? undefined,
        backendId: catalog.getStoredBackendId(msg.sessionId) ?? undefined,
      });

      try {
        const backend = await host.registry.getBackendForSession(catalog.getStoredBackendId(msg.sessionId));
        await host.failureReplay.wait(msg.sessionId);
        const messages = await backend.getHistory(msg.sessionId);
        await host.failureReplay.wait(msg.sessionId);
        if (!connection.authorization.valid) return;
        sendSessionHistory(ws, msg.sessionId, host.prepareHistory(msg.sessionId, messages));
        // The history just REPLACED this client's transcript, and with it any
        // live card for a question still waiting in this session. Hand those
        // questions over again, after the history, as a reconnect would
        // (#910). The client keys cards by request id, so a card the history
        // already rebuilt is updated rather than drawn twice. Approvals go
        // the same way, first, as a reconnect sends them (#964).
        resendPendingApprovals(host, ws, msg.sessionId);
        resendPendingAsks(host, ws, msg.sessionId);
        // A resume of a RUNNING session (reattach) must not report idle: idle
        // would clear the client's running badge and finish its streaming
        // message mid-turn. Mirror the snapshot-on-connect status instead.
        const runningTurn = coordinator.bySession.get(msg.sessionId);
        host.sendMessage(ws, {
          type: "status",
          ...(runningTurn
            ? { status: "thinking" as const, detail: "Session in progress" }
            : { status: "idle" as const, detail: "Session loaded" }),
          sessionId: msg.sessionId,
          ...(runningTurn ? { turnId: runningTurn.turnId } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load session";
        host.reportTurnFailed("SESSION_LOAD_ERROR", { sessionId: msg.sessionId }, message);
        host.sendMessage(ws, {
          type: "error",
          code: "SESSION_LOAD_ERROR",
          message,
          sessionId: msg.sessionId,
        });
      }
      break;
    }
  }
}

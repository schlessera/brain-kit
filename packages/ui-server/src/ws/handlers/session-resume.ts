import { FOLLOW_UP_QUEUE_CAPABILITY } from "@schlessera/brain-ui-sdk/protocol";
import { sendSessionHistory } from "../history.js";
import { resendPendingApprovals, resendPendingAsks } from "../resend.js";
import { requireKnownSession } from "../session-recovery.js";
import { ChatRetiredError } from "../chat-lifecycle.js";
import type { ClientMessageHandler } from "./context.js";

export const handleSessionResume: ClientMessageHandler<"session_resume"> = async ({ host, ws, connection }, msg) => {
  const { coordinator, catalog } = host;
  let lookupError: string | undefined;
  if (!await requireKnownSession(host, ws, connection, msg.sessionId, true, undefined, error => {
    lookupError = error instanceof Error ? error.message : "Failed to load session";
  })) {
    host.reportSessionResume(msg.sessionId, connection.authorization.valid ? "error" : "unauthorized",
      { error: lookupError ?? "Session could not be verified" });
    if (lookupError !== undefined) host.reportTurnFailed("SESSION_LOAD_ERROR", { sessionId: msg.sessionId }, lookupError);
    return;
  }
  host.sendMessage(ws, {
    type: "session_info",
    sessionId: msg.sessionId,
    isNew: false,
    providerId: catalog.getStoredProviderId(msg.sessionId) ?? undefined,
    backendId: catalog.getStoredBackendId(msg.sessionId) ?? undefined,
  });

  // One log line per resume, whichever way it ends (#1328).
  let resumeReported = false;
  try {
    const backend = await host.registry.getBackendForSession(catalog.getStoredBackendId(msg.sessionId));
    const published = await host.publishHistory(msg.sessionId, backend, () => connection.authorization.valid, (messages) => {
      sendSessionHistory(ws, msg.sessionId, host.prepareHistory(msg.sessionId, messages), host.catalog.readStateRoom?.(msg.sessionId));
      host.reportSessionResume(msg.sessionId, "loaded", { messages: messages.length });
      resumeReported = true;
      // Replacing history may remove live cards: restore pending requests
      // after all chunks, then the whole waiting follow-up queue.
      resendPendingApprovals(host, ws, msg.sessionId);
      resendPendingAsks(host, ws, msg.sessionId);
      if (connection.capabilities?.[FOLLOW_UP_QUEUE_CAPABILITY] === true) {
        host.sendMessage(ws, host.followUpQueueFrame(msg.sessionId));
      }
      // Read the current turn after history, including any queued turn
      // that replaced the one running when the asynchronous read began.
      const runningTurn = coordinator.bySession.get(msg.sessionId);
      host.sendMessage(ws, {
        type: "status",
        ...(runningTurn && runningTurn.lastResult === null
          ? { status: "thinking" as const, detail: "Session in progress", turnId: runningTurn.turnId }
          : { status: "idle" as const, detail: "Session loaded" }),
        sessionId: msg.sessionId,
      });
    });
    if (!published) {
      host.reportSessionResume(msg.sessionId, "unauthorized");
      return;
    }
  } catch (err) {
    if (!connection.authorization.valid) {
      host.reportSessionResume(msg.sessionId, "unauthorized");
      return;
    }
    // Retired while its history was read (#3230): absent, not a load failure.
    if (err instanceof ChatRetiredError) {
      host.reportSessionResume(msg.sessionId, "error", { error: "retired" });
      host.sendMessage(ws, { type: "error", code: "SESSION_NOT_FOUND", sessionId: msg.sessionId,
        message: "This conversation is not available on this host. Start a New conversation; your draft is kept." });
      return;
    }
    const message = err instanceof Error ? err.message : "Failed to load session";
    if (!resumeReported) host.reportSessionResume(msg.sessionId, "error", { error: message });
    host.reportTurnFailed("SESSION_LOAD_ERROR", { sessionId: msg.sessionId }, message);
    host.sendMessage(ws, {
      type: "error",
      code: "SESSION_LOAD_ERROR",
      message: "The host could not load this conversation. No work was started; your draft is kept.",
      sessionId: msg.sessionId,
    });
  }
};

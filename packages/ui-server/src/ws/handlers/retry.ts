import type { SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";
import { resolveChatFiles, withTrackFiles } from "../../tracks/read.js";
import { handleChatMessage } from "../run-session.js";
import type { ClientMessageHandler } from "./context.js";

export const handleRetryStatus: ClientMessageHandler<"retry_status"> = async ({ host, ws, connection }, msg) => {
  const { catalog } = host;
  try {
    // Retained retries and their invalidations commit off the event loop (#2850).
    await catalog.settled?.();
    host.sendMessage(ws, catalog.retryReceipt?.(msg.sessionId, msg.requestId, connection.authorization.principalId)
      ?? { type: "retry_receipt", sessionId: msg.sessionId, requestId: msg.requestId, state: "unknown" });
  } catch {
    host.sendMessage(ws, { type: "retry_receipt", sessionId: msg.sessionId, requestId: msg.requestId, state: "unknown" });
  }
};

export const handleRetryTurn: ClientMessageHandler<"retry_turn"> = async ({ host, ws, connection }, msg) => {
  const { coordinator, catalog } = host;
  const refuse = async (message: string) => {
    const receipt = { type: "retry_receipt" as const, sessionId: msg.sessionId, requestId: msg.requestId, state: "refused" as const, message };
    try { host.sendMessage(ws, (await catalog.refuseRetry?.(msg.sessionId, msg.requestId, connection.authorization.principalId, message)) ?? receipt); }
    catch { host.sendMessage(ws, receipt); }
  };
  try {
    // Read and reserve against every retained request and invalidation
    // submitted before this frame (#2850). One submitted during the file
    // check below came with an accepted message, which the admission
    // check after it refuses.
    await catalog.settled?.();
    // Replay a receipt even while its turn runs. A repeated request id
    // cannot become a queued follow-up, including after reconnect.
    const prior = catalog.retryReceipt?.(msg.sessionId, msg.requestId, connection.authorization.principalId);
    if (prior && prior.state !== "unknown") { host.sendMessage(ws, prior); return; }
    if (coordinator.bySession.has(msg.sessionId) || coordinator.startingBySession.has(msg.sessionId)) {
      await refuse("This session is busy. Wait for the current turn to finish."); return;
    }
    if (coordinator.activeRuns() >= host.maxConcurrentSessions()) {
      await refuse("The server is busy. Wait for a turn to finish and try again."); return;
    }
    const original = catalog.peekRetry?.(msg.sessionId);
    let files: SharedFileMeta[] | undefined;
    if (original?.request.files?.length && original.turnId === msg.failedTurnId && original.principalId === connection.authorization.principalId) {
      try {
        files = await resolveChatFiles(host.brainPath, original.request.files);
        if (!original.prompt.includes(withTrackFiles("", files))) { await refuse("An original track changed. Start a new message with the current file instead."); return; }
      } catch { await refuse("An original track is unavailable. Attach it again in a new message."); return; }
      if (!connection.authorization.valid) return;
      // File reads yield; repeat admission before consuming eligibility.
      if (coordinator.bySession.has(msg.sessionId) || coordinator.startingBySession.has(msg.sessionId) || coordinator.activeRuns() >= host.maxConcurrentSessions()) {
        await refuse("The session or server became busy. Try again when it is free."); return;
      }
    }
    const reserved = await catalog.reserveRetry?.(msg.sessionId, msg.failedTurnId, msg.requestId, connection.authorization.principalId, files ? original!.prompt : undefined);
    if (!reserved) { await refuse("This server cannot retain the original request for Retry."); return; }
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
    await refuse("The server could not confirm this retry. Check delivery before trying again.");
  }
};

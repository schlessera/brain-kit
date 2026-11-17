import { SHARE_MAX_FILES, SHARE_MAX_TOTAL_BYTES, type SharedFileMeta } from "@schlessera/brain-ui-sdk/protocol";
import { resolveChatFiles } from "../../tracks/read.js";
import { type MessageAttachment } from "../../attachments/context.js";
import { resolveAttachmentRefs } from "../../attachments/resolve.js";
import { estimateDecodedBase64Bytes, validateAttachments } from "../attachments.js";
import { startHandoff } from "../handoff.js";
import { handleChatMessage } from "../run-session.js";
import type { ClientMessageHandler } from "./context.js";

export const handleChatMessageFrame: ClientMessageHandler<"chat_message"> = async ({ host, ws, connection }, msg) => {
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
  let attachmentFiles: MessageAttachment[];
  try {
    files = await resolveChatFiles(host.brainPath, msg.files);
    if (msg.attachmentRefs?.length && !msg.draftRef) throw Error("Attached files need the saved draft they were uploaded to.");
    attachmentFiles = await resolveAttachmentRefs(host.brainPath, host.drafts ?? undefined, msg.attachmentRefs,
      { ...(msg.draftRef ? { draftId: msg.draftRef.draftId } : {}) }, attachmentResult.attachments);
    // One envelope, images included: an image frame of an attached original
    // is charged once, by the original.
    const frames = attachmentResult.attachments.filter((a) => !a.fileId);
    const bytes = files.reduce((n, f) => n + f.bytes, 0) + attachmentFiles.reduce((n, f) => n + f.bytes, 0)
      + frames.reduce((n, f) => n + estimateDecodedBase64Bytes(f.data), 0);
    if (files.length + attachmentFiles.length + frames.length > SHARE_MAX_FILES || bytes > SHARE_MAX_TOTAL_BYTES) throw Error("Attached files exceed the message limits.");
  } catch (error) {
    host.sendMessage(ws, { type: "error", code: "ATTACHMENT_REJECTED", message: error instanceof Error ? error.message : "Track attachment refused.",
      ...(msg.requestId ? { requestId: msg.requestId } : {}), ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
    return;
  }
  if (!connection.authorization.valid) return;
  let shareSessionId = msg.sessionId;
  if (msg.shareId) {
    try {
      if (!host.inboxTools?.shares) throw new Error("This host does not support bound share filing");
      shareSessionId = await host.inboxTools.shares.resolveSession(connection.authorization.principalId, msg.shareId, msg.sessionId,
        () => !connection.closed && connection.authorization.valid);
      // A repeated intake without an explicit continuation only recovers
      // the binding. Admission may have succeeded before its reply was lost.
      if (shareSessionId && !msg.sessionId) {
        host.sendMessage(ws, { type: "session_info", sessionId: shareSessionId, isNew: false,
          ...(msg.requestId ? { requestId: msg.requestId } : {}) });
        return;
      }
    } catch (error) {
      host.sendMessage(ws, { type: "error", code: "SESSION_BUSY", message: error instanceof Error ? error.message : "Share binding refused",
        ...(msg.requestId ? { requestId: msg.requestId } : {}) });
      return;
    }
  }
  await handleChatMessage(host, ws, {
    authorization: connection.authorization,
    text: msg.text,
    ...(msg.historyOwnerId && !shareSessionId ? {historyOwnerId:msg.historyOwnerId} : {}),
    ...(msg.shareId ? { shareId: msg.shareId } : {}),
    sessionId: shareSessionId,
    attachments: attachmentResult.attachments,
    ...(files.length ? { files } : {}),
    ...(attachmentFiles.length ? { attachmentFiles } : {}),
    providerId: msg.providerId,
    client: msg.client,
    source: msg.source,
    draftId: msg.draftId,
    ...(msg.profileDraftId && !msg.sessionId ? { profileDraftId: msg.profileDraftId } : {}),
    // Ignored entirely by a host that does not store drafts.
    ...(msg.draftRef && host.drafts ? { draftRef: msg.draftRef } : {}),
    thinkingLevel: msg.thinkingLevel,
    requestId: msg.requestId,
    ...(msg.localExchanges?.length ? { localExchanges: msg.localExchanges } : {}),
  });
};

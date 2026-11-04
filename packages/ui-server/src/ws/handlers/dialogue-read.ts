import { requireKnownSession } from "../session-recovery.js";
import type { ClientMessageHandler } from "./context.js";

export const handleDialogueRead: ClientMessageHandler<"dialogue_read"> = async ({ host, ws, connection }, msg) => {
  const { catalog } = host;
  if (!connection.authorization.valid || !connection.capabilities?.sessionDialogue || !catalog.dialogueRead) return;
  if (msg.sessionId && !await requireKnownSession(host, ws, connection, msg.sessionId, true, msg.requestId)) return;
  try {
    const page = await catalog.dialogueRead(connection.authorization.principalId, msg);
    if (connection.closed || !connection.authorization.valid) return;
    if (page) host.sendMessage(ws, { type: "dialogue_history", requestId: msg.requestId, ...page });
    else if (msg.sessionId) host.sendMessage(ws, { type: "dialogue_history", requestId: msg.requestId,
      ownerId: msg.sessionId, sessionId: msg.sessionId, generation: 1, through: 0, records: [], coverage: "complete" });
    else throw new Error("Dialogue owner unavailable");
  } catch {
    if (!connection.closed && connection.authorization.valid) host.sendMessage(ws, { type: "error", code: "DIALOGUE_UNAVAILABLE", requestId: msg.requestId,
      ...(msg.sessionId ? {sessionId: msg.sessionId} : {}), message: "Conversation history unavailable. Try opening this chat again." });
  }
};

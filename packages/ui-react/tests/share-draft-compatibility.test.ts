import { expect, test } from "bun:test";
import { createBrainUiRoot } from "../src/root.js";

test("a same-view share draft still binds on a legacy host without a draft echo", () => {
  const root = createBrainUiRoot({ storage: null });
  try {
    const chat = root.stores.chat.getState();
    chat.addUserMessage(null, "File Penelope's loom plan", "typed", undefined, { requestId: "odysseus-share" });
    chat.startAssistantMessage(null, undefined, "odysseus-share");
    const draftId = chat.startDraftTurn();
    // Recovery of an existing session may precede the first new announcement;
    // it cannot claim this pending draft even on a host without correlation.
    root.connection.handleServerMessage({ type: "session_info", sessionId: "odysseus-old", isNew: false });
    expect(root.stores.chat.getState().pendingDraftId).toBe(draftId);
    root.connection.handleServerMessage({ type: "session_info", sessionId: "odysseus-loom", isNew: true, requestId: "odysseus-share" });
    const after = root.stores.chat.getState();
    expect(after.activeSessionId).toBe("odysseus-loom");
    expect(after.pendingDraftId).toBeNull();
    expect(after.buffers["odysseus-loom"]!.messages[0]!.content).toBe("File Penelope's loom plan");
  } finally { root.dispose(); }
});

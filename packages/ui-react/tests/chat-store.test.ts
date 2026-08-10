import { describe, test, expect, beforeEach } from "bun:test";
import { useChatStore, activeChat } from "../src/stores/chat-store";

// Reset store between tests
beforeEach(() => {
  useChatStore.setState({
    buffers: {},
    draft: null,
    activeSessionId: null,
    runStates: {},
  });
});

/** The draft buffer's messages (empty before the first draft mutation). */
function draftMessages() {
  return useChatStore.getState().draft?.messages ?? [];
}

describe("chat store", () => {
  describe("addUserMessage", () => {
    test("adds a user message", () => {
      useChatStore.getState().addUserMessage(null, "Hello");
      const messages = draftMessages();
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Hello");
      expect(messages[0].isStreaming).toBe(false);
    });

    test("appends to existing messages", () => {
      useChatStore.getState().addUserMessage(null, "First");
      useChatStore.getState().addUserMessage(null, "Second");
      expect(draftMessages()).toHaveLength(2);
    });

    test("assigns unique IDs", () => {
      useChatStore.getState().addUserMessage(null, "A");
      useChatStore.getState().addUserMessage(null, "B");
      const ids = draftMessages().map((m) => m.id);
      expect(ids[0]).not.toBe(ids[1]);
    });
  });

  describe("assistant message streaming", () => {
    test("startAssistantMessage creates empty streaming message", () => {
      useChatStore.getState().startAssistantMessage(null);
      const draft = useChatStore.getState().draft!;
      expect(draft.messages).toHaveLength(1);
      expect(draft.messages[0].role).toBe("assistant");
      expect(draft.messages[0].content).toBe("");
      expect(draft.messages[0].isStreaming).toBe(true);
      expect(draft.isStreaming).toBe(true);
    });

    test("appendText accumulates text content", () => {
      useChatStore.getState().startAssistantMessage(null);
      useChatStore.getState().appendText(null, "Hello ");
      useChatStore.getState().appendText(null, "world");
      const msg = draftMessages()[0];
      expect(msg.content).toBe("Hello world");
    });

    test("appendThinking accumulates thinking content", () => {
      useChatStore.getState().startAssistantMessage(null);
      useChatStore.getState().appendThinking(null, "Let me ");
      useChatStore.getState().appendThinking(null, "think...");
      const msg = draftMessages()[0];
      expect(msg.thinking).toBe("Let me think...");
    });

    test("finishAssistantMessage stops streaming", () => {
      useChatStore.getState().startAssistantMessage(null);
      useChatStore.getState().appendText(null, "Done");
      useChatStore.getState().finishAssistantMessage(null);

      const draft = useChatStore.getState().draft!;
      expect(draft.messages[0].isStreaming).toBe(false);
      expect(draft.isStreaming).toBe(false);
    });
  });

  describe("tool call lifecycle", () => {
    test("startToolCall adds a tool call", () => {
      useChatStore.getState().startAssistantMessage(null);
      useChatStore.getState().startToolCall(null, "t1", "Bash");

      const msg = draftMessages()[0];
      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.toolCalls[0].id).toBe("t1");
      expect(msg.toolCalls[0].name).toBe("Bash");
      expect(msg.toolCalls[0].status).toBe("streaming");
    });

    test("appendToolInput accumulates JSON", () => {
      useChatStore.getState().startAssistantMessage(null);
      useChatStore.getState().startToolCall(null, "t1", "Bash");
      useChatStore.getState().appendToolInput(null, '{"comma');
      useChatStore.getState().appendToolInput(null, 'nd":"ls"}');

      const tool = draftMessages()[0].toolCalls[0];
      expect(tool.inputJson).toBe('{"command":"ls"}');
    });

    test("completeToolCall sets input and status", () => {
      useChatStore.getState().startAssistantMessage(null);
      useChatStore.getState().startToolCall(null, "t1", "Bash");
      useChatStore.getState().completeToolCall(null, "t1", "Bash", { command: "ls" });

      const tool = draftMessages()[0].toolCalls[0];
      expect(tool.status).toBe("complete");
      expect(tool.input).toEqual({ command: "ls" });
    });

    test("requestToolApproval sets pending status", () => {
      useChatStore.getState().startAssistantMessage(null);
      useChatStore.getState().requestToolApproval(
        null,
        "t1",
        "Write",
        { file_path: "/tmp/test" },
        "Write file"
      );

      const tool = draftMessages()[0].toolCalls[0];
      expect(tool.status).toBe("pending_approval");
      expect(tool.name).toBe("Write");
    });

    test("resolveToolApproval with approved=true", () => {
      useChatStore.getState().startAssistantMessage(null);
      useChatStore.getState().requestToolApproval(null, "t1", "Bash", { command: "rm" });
      useChatStore.getState().resolveToolApproval(null, "t1", true);

      const tool = draftMessages()[0].toolCalls[0];
      expect(tool.status).toBe("approved");
    });

    test("resolveToolApproval with approved=false", () => {
      useChatStore.getState().startAssistantMessage(null);
      useChatStore.getState().requestToolApproval(null, "t1", "Bash", { command: "rm" });
      useChatStore.getState().resolveToolApproval(null, "t1", false);

      const tool = draftMessages()[0].toolCalls[0];
      expect(tool.status).toBe("denied");
    });

    test("setToolResult stores output", () => {
      useChatStore.getState().startAssistantMessage(null);
      useChatStore.getState().startToolCall(null, "t1", "Bash");
      useChatStore.getState().setToolResult(null, "t1", "file1.txt\nfile2.txt", false);

      const tool = draftMessages()[0].toolCalls[0];
      expect(tool.output).toBe("file1.txt\nfile2.txt");
      expect(tool.isError).toBe(false);
      expect(tool.status).toBe("complete");
    });

    test("setToolResult with error", () => {
      useChatStore.getState().startAssistantMessage(null);
      useChatStore.getState().startToolCall(null, "t1", "Bash");
      useChatStore.getState().setToolResult(null, "t1", "command not found", true);

      const tool = draftMessages()[0].toolCalls[0];
      expect(tool.isError).toBe(true);
    });

    test("multiple tool calls on same message", () => {
      useChatStore.getState().startAssistantMessage(null);
      useChatStore.getState().startToolCall(null, "t1", "Read");
      useChatStore.getState().startToolCall(null, "t2", "Grep");

      const msg = draftMessages()[0];
      expect(msg.toolCalls).toHaveLength(2);
      expect(msg.toolCalls[0].name).toBe("Read");
      expect(msg.toolCalls[1].name).toBe("Grep");
    });
  });

  describe("session management", () => {
    test("bindDraftSession adopts the draft and activates the session", () => {
      useChatStore.getState().addUserMessage(null, "Hello");
      useChatStore.getState().bindDraftSession("session-abc");

      const state = useChatStore.getState();
      expect(state.activeSessionId).toBe("session-abc");
      expect(state.draft).toBeNull();
      expect(state.buffers["session-abc"].messages).toHaveLength(1);
      expect(state.buffers["session-abc"].messages[0].content).toBe("Hello");
    });

    test("setActiveSession switches the view and creates an empty buffer", () => {
      useChatStore.getState().setActiveSession("session-xyz");
      const state = useChatStore.getState();
      expect(state.activeSessionId).toBe("session-xyz");
      expect(state.buffers["session-xyz"].messages).toHaveLength(0);
      expect(activeChat(state).messages).toHaveLength(0);
    });

    test("clearMessages drops the draft and unbinds the view; buffers survive", () => {
      const s = useChatStore.getState();
      s.addUserMessage(null, "Hello");
      s.startAssistantMessage(null);
      s.bindDraftSession("s1");
      useChatStore.getState().clearMessages();

      const state = useChatStore.getState();
      expect(state.draft).toBeNull();
      expect(state.activeSessionId).toBeNull();
      expect(activeChat(state).messages).toHaveLength(0);
      expect(activeChat(state).isStreaming).toBe(false);
      // The bound session's buffer survives new-chat.
      expect(state.buffers["s1"].messages).toHaveLength(2);
    });

    test("frame-driven mutations on a missing buffer are no-ops", () => {
      useChatStore.getState().appendText("ghost", "into the void");
      useChatStore.getState().startAssistantMessage("ghost");
      const state = useChatStore.getState();
      expect(state.buffers["ghost"]).toBeUndefined();
      expect(state.draft).toBeNull();
    });

    test("addUserMessage creates a missing session buffer (user-initiated, never dropped)", () => {
      useChatStore.getState().addUserMessage("s9", "typed before history landed");
      const state = useChatStore.getState();
      expect(state.buffers["s9"].messages[0].content).toBe("typed before history landed");
      expect(state.draft).toBeNull();
    });
  });

  describe("edge cases", () => {
    test("appendText with no assistant message is no-op", () => {
      useChatStore.getState().appendText(null, "orphan text");
      expect(draftMessages()).toHaveLength(0);
    });

    test("appendText on user message is no-op", () => {
      useChatStore.getState().addUserMessage(null, "Hello");
      useChatStore.getState().appendText(null, "should not append");
      expect(draftMessages()[0].content).toBe("Hello");
    });

    test("finishAssistantMessage with no messages is no-op", () => {
      useChatStore.getState().finishAssistantMessage(null);
      expect(useChatStore.getState().draft?.isStreaming ?? false).toBe(false);
      expect(draftMessages()).toHaveLength(0);
    });

    test("full conversation flow", () => {
      const s = useChatStore.getState();
      // User sends message (draft — no server identity yet)
      s.addUserMessage(null, "What files are here?");
      s.startAssistantMessage(null);
      // Server names the session: the draft becomes buffers["sess-1"]
      s.bindDraftSession("sess-1");

      // Assistant thinks
      s.appendThinking("sess-1", "Let me check the files...");

      // Tool call: Bash ls
      s.startToolCall("sess-1", "t1", "Bash");
      s.appendToolInput("sess-1", '{"command":');
      s.appendToolInput("sess-1", '"ls"}');
      s.requestToolApproval("sess-1", "t1", "Bash", { command: "ls" }, "Run ls");

      // User approves
      s.resolveToolApproval("sess-1", "t1", true);
      s.setToolResult("sess-1", "t1", "file1.txt\nfile2.txt", false);

      // Assistant responds
      s.appendText("sess-1", "I found 2 files: file1.txt and file2.txt");
      s.finishAssistantMessage("sess-1");

      const state = useChatStore.getState();
      expect(state.activeSessionId).toBe("sess-1");
      const chat = activeChat(state);
      expect(chat.messages).toHaveLength(2);
      expect(chat.messages[0].role).toBe("user");
      expect(chat.messages[1].role).toBe("assistant");
      expect(chat.messages[1].thinking).toContain("check the files");
      expect(chat.messages[1].toolCalls).toHaveLength(1);
      expect(chat.messages[1].toolCalls[0].status).toBe("complete");
      expect(chat.messages[1].content).toContain("2 files");
      expect(chat.isStreaming).toBe(false);
    });
  });
});

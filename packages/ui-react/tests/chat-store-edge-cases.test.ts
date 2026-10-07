import { describe, test, expect, beforeEach } from "bun:test";
import { useChatStore } from "../src/stores/chat-store";

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

describe("chat store edge cases", () => {
  test("requestToolApproval overwrites existing streaming tool call", () => {
    const s = useChatStore.getState();
    s.startAssistantMessage(null);
    // Start a tool call via streaming
    s.startToolCall(null, "t1", "Bash");
    s.appendToolInput(null, '{"command":"ls"}');

    // Now the approval request arrives with the same tool name
    s.requestToolApproval(null, "t1", "Bash", { command: "ls" }, "Run ls");

    const msg = draftMessages()[0];
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls[0].status).toBe("pending_approval");
    expect(msg.toolCalls[0].id).toBe("t1");
    expect(msg.toolCalls[0].input).toEqual({ command: "ls" });
  });

  test("requestToolApproval adds new tool if no matching streaming tool", () => {
    const s = useChatStore.getState();
    s.startAssistantMessage(null);

    // Approval request without prior streaming start
    s.requestToolApproval(null, "t-new", "Write", { file_path: "/test" });

    const msg = draftMessages()[0];
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls[0].id).toBe("t-new");
    expect(msg.toolCalls[0].status).toBe("pending_approval");
  });

  test("requestToolApproval keeps the request's description with a command approval", () => {
    // What a confirmed command will do, in words (#112): the card draws it.
    const s = useChatStore.getState();
    s.startAssistantMessage(null);
    s.requestToolApproval(
      null,
      "t-rm",
      "Bash",
      { command: "rm -rf notes" },
      "delete a directory and everything inside it",
      "command"
    );

    const call = draftMessages()[0].toolCalls[0];
    expect(call.approvalKind).toBe("command");
    expect(call.approvalDescription).toBe("delete a directory and everything inside it");
  });

  test("completeToolCall matches by toolUseId", () => {
    const s = useChatStore.getState();
    s.startAssistantMessage(null);
    s.startToolCall(null, "t1", "Read");
    s.startToolCall(null, "t2", "Grep");

    s.completeToolCall(null, "t2", "Grep", { pattern: "foo" });

    const msg = draftMessages()[0];
    expect(msg.toolCalls[0].status).toBe("streaming"); // t1 unchanged
    expect(msg.toolCalls[1].status).toBe("complete"); // t2 completed
    expect(msg.toolCalls[1].input).toEqual({ pattern: "foo" });
  });

  test("resolveToolApproval only affects matching toolUseId", () => {
    const s = useChatStore.getState();
    s.startAssistantMessage(null);
    s.requestToolApproval(null, "t1", "Bash", { command: "rm" });
    s.requestToolApproval(null, "t2", "Write", { file_path: "/x" });

    s.resolveToolApproval(null, "t1", true);

    const msg = draftMessages()[0];
    expect(msg.toolCalls[0].status).toBe("approved");
    expect(msg.toolCalls[1].status).toBe("pending_approval");
  });

  test("setToolResult only affects matching toolUseId", () => {
    const s = useChatStore.getState();
    s.startAssistantMessage(null);
    s.startToolCall(null, "t1", "Read");
    s.startToolCall(null, "t2", "Grep");

    s.setToolResult(null, "t1", "file contents", false);

    const msg = draftMessages()[0];
    expect(msg.toolCalls[0].output).toBe("file contents");
    expect(msg.toolCalls[0].status).toBe("complete");
    expect(msg.toolCalls[1].output).toBeUndefined();
    expect(msg.toolCalls[1].status).toBe("streaming");
  });

  test("appendThinking on user message is no-op", () => {
    useChatStore.getState().addUserMessage(null, "Hello");
    useChatStore.getState().appendThinking(null, "should not appear");
    expect(draftMessages()[0].thinking).toBeUndefined();
  });

  test("startToolCall on user message is no-op", () => {
    useChatStore.getState().addUserMessage(null, "Hello");
    useChatStore.getState().startToolCall(null, "t1", "Bash");
    expect(draftMessages()[0].toolCalls).toHaveLength(0);
  });

  test("multiple assistant messages accumulate independently", () => {
    const s = useChatStore.getState();

    // First exchange
    s.addUserMessage(null, "Q1");
    s.startAssistantMessage(null);
    s.appendText(null, "A1");
    s.finishAssistantMessage(null);

    // Second exchange
    s.addUserMessage(null, "Q2");
    s.startAssistantMessage(null);
    s.appendText(null, "A2");
    s.finishAssistantMessage(null);

    const msgs = draftMessages();
    expect(msgs).toHaveLength(4);
    expect(msgs[1].content).toBe("A1");
    expect(msgs[3].content).toBe("A2");
  });

  test("appendText continues the last assistant after a follow-up without changing the user", () => {
    const s = useChatStore.getState();
    s.addUserMessage(null, "Q1");
    s.startAssistantMessage(null);
    s.appendText(null, "First ");
    s.addUserMessage(null, "Q2"); // user sends another while streaming
    s.appendText(null, "then the return route.");
    expect(draftMessages()[1].content).toBe("First then the return route.");
    // The user message should be unchanged
    expect(draftMessages()[2].content).toBe("Q2");
  });

  test("setStreaming is independent of message state", () => {
    useChatStore.getState().setStreaming(null, true);
    expect(useChatStore.getState().draft?.isStreaming).toBe(true);
    useChatStore.getState().setStreaming(null, false);
    expect(useChatStore.getState().draft?.isStreaming).toBe(false);
  });
});

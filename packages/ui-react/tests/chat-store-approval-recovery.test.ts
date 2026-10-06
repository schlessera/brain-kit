import { beforeEach, describe, expect, test } from "bun:test";
import type { ServerMessage, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { useChatStore } from "../src/stores/chat-store";
import { flushChatDeltas, handleServerMessage } from "../src/hooks/use-websocket";

// Approval recovery in the client (#964, D52 §4): a pending approval the host
// re-delivers after a replay lands on its own turn, as one card, marked
// restored, even when the replay ends on the user's message.

const SID = "odysseus-sirens";

function reset() {
  flushChatDeltas();
  useChatStore.setState({ buffers: {}, draft: null, pendingDraftId: null, activeSessionId: null, runStates: {} });
  useChatStore.getState().setActiveSession(SID);
}

function replay(messages: SessionHistoryMessage[]) {
  handleServerMessage({ type: "session_history", sessionId: SID, messages });
}

function approval(toolUseId: string, turnId: string) {
  handleServerMessage({
    type: "tool_approval_request", sessionId: SID, turnId, toolUseId, toolName: "Bash",
    input: { command: "seal --ears crew" }, description: "Seal the crew's ears with wax.", kind: "command",
  } as ServerMessage);
}

const messages = () => useChatStore.getState().buffers[SID]!.messages;
const cards = () => messages().flatMap((m) => m.toolCalls.filter((t) => t.status === "pending_approval").map((t) => ({ ...t, turnId: m.turnId })));

describe("a re-delivered approval after a replay", () => {
  beforeEach(reset);

  test("a replay ending on the user's message gets a turn shell holding only the card, restored", () => {
    replay([{ role: "user", content: "Row past the Sirens", toolCalls: [] }]);
    approval("tool-wax", "turn-2");
    expect(messages().map((m) => [m.role, m.content])).toEqual([["user", "Row past the Sirens"], ["assistant", ""]]);
    const shell = messages()[1]!;
    expect(shell).toMatchObject({ turnId: "turn-2", isStreaming: false, parts: [{ kind: "tool", toolIndex: 0 }] });
    expect(shell.toolCalls).toHaveLength(1);
    expect(shell.toolCalls[0]).toMatchObject({ id: "tool-wax", status: "pending_approval", approvalKind: "command", restored: true });
  });

  test("an earlier turn's answer never receives a later turn's card", () => {
    replay([
      { role: "user", content: "Count the crew", toolCalls: [] },
      { role: "assistant", content: "Forty-four aboard.", toolCalls: [], turnId: "turn-1" },
      { role: "user", content: "Row past the Sirens", toolCalls: [] },
    ]);
    approval("tool-wax", "turn-2");
    expect(messages()[1]!.toolCalls).toEqual([]);
    expect(messages().map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(cards()).toMatchObject([{ id: "tool-wax", turnId: "turn-2", restored: true }]);
  });

  test("a card for a linked answer lands on that answer", () => {
    replay([
      { role: "user", content: "Row past the Sirens", toolCalls: [] },
      { role: "assistant", content: "Sealing their ears.", toolCalls: [], turnId: "turn-2" },
      { role: "user", content: "And mine?", toolCalls: [] },
    ]);
    approval("tool-wax", "turn-2");
    expect(messages()).toHaveLength(3);
    expect(messages()[1]!.toolCalls).toMatchObject([{ id: "tool-wax", restored: true }]);
  });

  test("repeated re-delivery keeps one card, and a second replay rebuilds exactly one", () => {
    replay([{ role: "user", content: "Row past the Sirens", toolCalls: [] }]);
    approval("tool-wax", "turn-2");
    approval("tool-wax", "turn-2");
    expect(cards()).toHaveLength(1);
    replay([{ role: "user", content: "Row past the Sirens", toolCalls: [] }]);
    approval("tool-wax", "turn-2");
    expect(cards()).toHaveLength(1);
    expect(messages()).toHaveLength(2);
  });

  test("a card raised while the turn streams is live, not restored", () => {
    useChatStore.getState().setMessages(SID, []);
    handleServerMessage({ type: "text_delta", sessionId: SID, turnId: "turn-3", text: "Sealing their ears." } as ServerMessage);
    flushChatDeltas();
    approval("tool-wax", "turn-3");
    expect(cards()).toHaveLength(1);
    expect(cards()[0]!.restored).toBeUndefined();
  });

  test("the decision and the result reach a shell's card after the turn streams on into a new message", () => {
    replay([{ role: "user", content: "Row past the Sirens", toolCalls: [] }]);
    approval("tool-wax", "turn-2");
    useChatStore.getState().resolveToolApproval(SID, "tool-wax", true);
    handleServerMessage({ type: "text_delta", sessionId: SID, turnId: "turn-2", text: "Ears sealed." } as ServerMessage);
    flushChatDeltas();
    handleServerMessage({ type: "tool_result", sessionId: SID, turnId: "turn-2", toolUseId: "tool-wax", output: "sealed", isError: false } as ServerMessage);
    const shell = messages()[1]!;
    expect(shell.toolCalls[0]).toMatchObject({ id: "tool-wax", status: "complete", output: "sealed" });
    expect(messages().at(-1)!.content).toBe("Ears sealed.");
  });
});

describe("replayed turn ids", () => {
  beforeEach(reset);

  test("an assistant message keeps the host-proven turn id; a user message never takes one", () => {
    replay([
      { role: "user", content: "Count the crew", toolCalls: [], turnId: "turn-1" } as SessionHistoryMessage,
      { role: "assistant", content: "Forty-four aboard.", toolCalls: [], turnId: "turn-1" },
      { role: "assistant", content: "Unlinked.", toolCalls: [] },
    ]);
    expect(messages().map((m) => m.turnId)).toEqual([undefined, "turn-1", undefined]);
  });
});

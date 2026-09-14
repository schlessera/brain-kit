import { describe, test, expect, beforeEach } from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { useChatStore, activeChat } from "../src/stores/chat-store";
import { runStateForFrame, handleServerMessage, flushChatDeltas } from "../src/hooks/use-websocket";

function reset() {
  // Text deltas are coalesced into the next animation frame when one exists;
  // these assertions read the store directly, so force the frame.
  flushChatDeltas();
  useChatStore.setState({
    buffers: {},
    draft: null,
    pendingDraftId: null,
    activeSessionId: null,
    runStates: {},
  });
}

describe("runStateForFrame", () => {
  test("maps frames to session run states", () => {
    expect(runStateForFrame({ type: "text_delta", text: "x" } as ServerMessage)).toBe("streaming");
    expect(runStateForFrame({ type: "status", status: "queued" } as ServerMessage)).toBe("queued");
    expect(runStateForFrame({ type: "status", status: "idle" } as ServerMessage)).toBe("idle");
    expect(
      runStateForFrame({ type: "result", sessionId: "s", costUsd: 0, durationMs: 0, numTurns: 1, isError: false } as ServerMessage)
    ).toBe("idle");
  });
});

describe("session demux (handleServerMessage)", () => {
  beforeEach(reset);

  test("a pending draft binds only to its own announcement, never another session's result", () => {
    const store = useChatStore.getState();
    const draftId = store.startDraftTurn();
    store.addUserMessage(null, "My new topic");
    handleServerMessage({ type: "session_info", sessionId: "other", isNew: true, draftId: "foreign-draft" });
    handleServerMessage({ type: "result", sessionId: "other", costUsd: 0, durationMs: 1, numTurns: 1, isError: false });
    expect(useChatStore.getState().pendingDraftId).toBe(draftId);
    expect(useChatStore.getState().buffers.other).toBeUndefined();
    handleServerMessage({ type: "session_info", sessionId: "mine", isNew: true, draftId });
    expect(useChatStore.getState().buffers.mine.messages.some(message => message.content === "My new topic")).toBe(true);
    expect(useChatStore.getState().pendingDraftId).toBeNull();
  });

  test("a background session's deltas accumulate in its own buffer, not the active transcript", () => {
    const store = useChatStore.getState();
    // Session B has a buffer (opened earlier), session A is in view.
    store.setMessages("B", []);
    store.setActiveSession("A");
    store.startAssistantMessage("A");
    store.appendText("A", "hello from A");

    // A frame for the BACKGROUND session B must not touch A's transcript...
    handleServerMessage({ type: "text_delta", text: "B intrudes", sessionId: "B" } as ServerMessage);
    flushChatDeltas();

    const state = useChatStore.getState();
    const assistant = activeChat(state).messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("hello from A");
    expect(state.runStates["B"]).toBe("streaming"); // badge updated
    // ...but it DOES accumulate into B's own buffer.
    const bAssistant = state.buffers["B"].messages.find((m) => m.role === "assistant");
    expect(bAssistant?.content).toBe("B intrudes");
    expect(state.buffers["B"].isStreaming).toBe(true);
  });

  test("a scoped frame for a session with no buffer only updates its badge", () => {
    useChatStore.getState().setActiveSession("A");
    handleServerMessage({ type: "text_delta", text: "ghost", sessionId: "Z" } as ServerMessage);
    flushChatDeltas();

    const state = useChatStore.getState();
    expect(state.buffers["Z"]).toBeUndefined(); // no partial transcript materialized
    expect(state.runStates["Z"]).toBe("streaming"); // badge still tracked
  });

  test("a frame for the active session updates the transcript", () => {
    const store = useChatStore.getState();
    store.setActiveSession("A");
    store.startAssistantMessage("A");

    handleServerMessage({ type: "text_delta", text: "more A", sessionId: "A" } as ServerMessage);
    flushChatDeltas();

    const state = useChatStore.getState();
    const assistant = activeChat(state).messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("more A");
  });

  test("a queued status for a background session shows the queued badge", () => {
    useChatStore.getState().setActiveSession("A");
    handleServerMessage({ type: "status", status: "queued", sessionId: "B" } as ServerMessage);
    expect(useChatStore.getState().runStates["B"]).toBe("queued");
  });

  test("an unscoped frame (legacy) applies to the active view", () => {
    const store = useChatStore.getState();
    store.setActiveSession("A");
    store.startAssistantMessage("A");
    handleServerMessage({ type: "text_delta", text: "legacy" } as ServerMessage);
    flushChatDeltas();

    const state = useChatStore.getState();
    const assistant = activeChat(state).messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("legacy");
  });

  test("an unscoped frame with no active session applies to the draft", () => {
    handleServerMessage({ type: "text_delta", text: "draft text" } as ServerMessage);
    flushChatDeltas();

    const state = useChatStore.getState();
    const assistant = state.draft?.messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("draft text");
    expect(state.activeSessionId).toBeNull();
  });

  test("a session_info for the ACTIVE session materializes its missing buffer (cold reattach)", () => {
    // PWA relaunch mid-turn: activeSessionId restored from storage, no buffer,
    // no draft. The server's snapshot may skip the history frame entirely
    // (first turn, empty history) — session_info alone must create the buffer
    // so the following deltas render instead of streaming into the void.
    useChatStore.setState({ buffers: {}, draft: null, activeSessionId: "S", runStates: {} });

    handleServerMessage({ type: "session_info", sessionId: "S" } as unknown as ServerMessage);
    handleServerMessage({ type: "text_delta", text: "live", sessionId: "S" } as ServerMessage);
    flushChatDeltas();

    const state = useChatStore.getState();
    expect(state.buffers["S"]).toBeDefined();
    const assistant = state.buffers["S"].messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("live");
  });

  test("a user message sent before the buffer exists creates it instead of being dropped", () => {
    useChatStore.setState({ buffers: {}, draft: null, activeSessionId: "S", runStates: {} });
    useChatStore.getState().addUserMessage("S", "typed fast");

    const state = useChatStore.getState();
    expect(state.buffers["S"].messages[0].content).toBe("typed fast");
  });

  test("a session_info frame binds an in-progress draft to its sessionId", () => {
    const store = useChatStore.getState();
    store.addUserMessage(null, "hi");

    handleServerMessage({ type: "session_info", sessionId: "S" } as unknown as ServerMessage);

    const state = useChatStore.getState();
    expect(state.activeSessionId).toBe("S");
    expect(state.draft).toBeNull();
    expect(state.buffers["S"].messages[0].content).toBe("hi");
  });
});

describe("chat store setRunState", () => {
  beforeEach(reset);

  test("streaming/queued are recorded; idle clears the entry", () => {
    const s = useChatStore.getState();
    s.setRunState("x", "streaming");
    expect(useChatStore.getState().runStates["x"]).toBe("streaming");
    s.setRunState("x", "queued");
    expect(useChatStore.getState().runStates["x"]).toBe("queued");
    s.setRunState("x", "idle");
    expect("x" in useChatStore.getState().runStates).toBe(false);
  });
});

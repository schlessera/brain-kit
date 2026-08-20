/**
 * The two chat-store races the extraction review named and nobody re-verified.
 *
 * Both were real. Both lose user-visible data silently, which is why they
 * survived: nothing errored, output just stopped appearing or appeared under
 * the wrong conversation.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { useChatStore } from "../src/stores/chat-store.js";

function reset() {
  useChatStore.setState({
    buffers: {},
    draft: null,
    pendingDraftId: null,
    activeSessionId: null,
    runStates: {},
    queueNotes: {},
  });
}

beforeEach(reset);

describe("a follow-up sent mid-stream", () => {
  test("does not swallow the deltas that follow it", () => {
    const store = useChatStore.getState();
    const key = "s1";

    store.addUserMessage(key, "first question");
    store.startAssistantMessage(key);
    store.appendText(key, "partial answer");

    // The user types again while the assistant is still streaming. This
    // appends a USER message to the end of the buffer.
    store.addUserMessage(key, "actually, also this");

    // The turn is still running, so more deltas arrive for the assistant
    // message that is now second-to-last. Indexing the END of the buffer
    // aimed them at the user's own message and discarded them.
    store.appendText(key, " continues here");

    const messages = useChatStore.getState().buffers[key].messages;
    const assistant = messages.filter((m) => m.role === "assistant");
    expect(assistant.length).toBe(1);
    expect(assistant[0].content).toBe("partial answer continues here");
  });

  test("tool calls opened after the follow-up land on the assistant too", () => {
    const store = useChatStore.getState();
    const key = "s1";

    store.addUserMessage(key, "q");
    store.startAssistantMessage(key);
    store.addUserMessage(key, "follow-up");
    store.startToolCall(key, "t1", "Read");

    const messages = useChatStore.getState().buffers[key].messages;
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.toolCalls.map((t) => t.id)).toEqual(["t1"]);
    // And not smuggled onto the user's message.
    expect(messages[messages.length - 1].role).toBe("user");
    expect(messages[messages.length - 1].toolCalls).toEqual([]);
  });

  test("the ordinary single-turn case is unchanged", () => {
    const store = useChatStore.getState();
    store.addUserMessage("s1", "q");
    store.startAssistantMessage("s1");
    store.appendText("s1", "a");
    store.appendThinking("s1", "t");

    const [, assistant] = useChatStore.getState().buffers["s1"].messages;
    expect(assistant.content).toBe("a");
    expect(assistant.thinking).toBe("t");
  });
});

describe("draft adoption", () => {
  test("binds to the session that echoes this client's own draft id", () => {
    const store = useChatStore.getState();
    store.addUserMessage(null, "starting a new conversation");
    const draftId = useChatStore.getState().startDraftTurn();
    expect(draftId).toBeString();

    // The matching announcement adopts the draft.
    useChatStore.getState().bindDraftSession("s-mine");

    const state = useChatStore.getState();
    expect(state.draft).toBeNull();
    expect(state.buffers["s-mine"].messages[0].content).toBe("starting a new conversation");
    // The pending id is cleared, so a later stray frame cannot re-match it.
    expect(state.pendingDraftId).toBeNull();
  });

  test("a draft turn mints a fresh id each time", () => {
    const first = useChatStore.getState().startDraftTurn();
    const second = useChatStore.getState().startDraftTurn();
    expect(first).not.toBe(second);
    expect(useChatStore.getState().pendingDraftId).toBe(second);
  });
});

import { describe, test, expect, beforeEach } from "bun:test";
import { useChatStore } from "../src/stores/chat-store";
import type { MessageBlock } from "@schlessera/brain-ui-sdk/protocol";

// Classified blocks (D42) arrive after a turn's result. By then a queued
// follow-up may have opened a newer assistant message, so the frame is
// targeted by the turn it belongs to, and never lands on a message that is
// still streaming.

const BLOCK: MessageBlock = {
  partIndex: 0,
  start: 0,
  end: 6,
  block: { kind: "quote", quote: "Words." },
  confidence: 0.9,
};

beforeEach(() => {
  useChatStore.setState({
    buffers: {},
    draft: null,
    activeSessionId: null,
    runStates: {},
  });
});

function messages() {
  return useChatStore.getState().draft!.messages;
}

describe("setMessageBlocks", () => {
  test("targets the assistant message of the frame's turn, not the newest one", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null, "turn-1");
    store.appendText(null, "Words.");
    store.finishAssistantMessage(null);
    store.startAssistantMessage(null, "turn-2");
    store.appendText(null, "Later.");

    store.setMessageBlocks(null, [BLOCK], "turn-1");
    const [first, second] = messages();
    expect(first.turnId).toBe("turn-1");
    expect(first.blocks).toEqual([BLOCK]);
    expect(second.blocks).toBeUndefined();
  });

  test("an unknown turn falls back to the last assistant message only once it has finished", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.appendText(null, "Words.");
    store.setMessageBlocks(null, [BLOCK]);
    expect(messages()[0].blocks).toBeUndefined();

    store.finishAssistantMessage(null);
    store.setMessageBlocks(null, [BLOCK]);
    expect(messages()[0].blocks).toEqual([BLOCK]);
  });

  test("a turn no message carries attaches nowhere", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null, "turn-1");
    store.finishAssistantMessage(null);
    store.setMessageBlocks(null, [BLOCK], "turn-9");
    expect(messages()[0].blocks).toBeUndefined();
  });
});

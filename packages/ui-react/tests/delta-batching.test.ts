// Text and thinking deltas are coalesced into one store write per animation
// frame. These tests pin the two properties that makes safe: a burst becomes a
// single write, and nothing ever reorders.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { useChatStore, activeChat } from "../src/stores/chat-store";
import { handleServerMessage, flushChatDeltas } from "../src/hooks/use-websocket";

/** Frame callbacks the handler queued, run only when a test says to. */
let frames: FrameRequestCallback[] = [];
const hadRaf = "requestAnimationFrame" in globalThis;
const originalRaf = globalThis.requestAnimationFrame;

function paint(): void {
  const due = frames;
  frames = [];
  for (const cb of due) cb(0);
}

beforeEach(() => {
  flushChatDeltas();
  frames = [];
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  }) as typeof requestAnimationFrame;
  useChatStore.setState({
    buffers: {},
    draft: null,
    activeSessionId: null,
    runStates: {},
  });
});

afterEach(() => {
  if (hadRaf) globalThis.requestAnimationFrame = originalRaf;
  else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
});

function delta(text: string): void {
  handleServerMessage({ type: "text_delta", text } as ServerMessage);
}

describe("delta batching", () => {
  test("a burst of deltas within one frame becomes a single store write", () => {
    delta("Hello");
    delta(" there");
    delta(", world");

    // The bubble opens immediately — the first token should show a message
    // starting — but the text has not landed yet.
    expect(activeChat(useChatStore.getState()).messages).toHaveLength(1);
    expect(activeChat(useChatStore.getState()).messages[0].content).toBe("");

    const writes: string[] = [];
    const unsubscribe = useChatStore.subscribe((state) => {
      writes.push(activeChat(state).messages[0].content);
    });
    try {
      paint();
      expect(writes).toEqual(["Hello there, world"]);
    } finally {
      unsubscribe();
    }

    const msg = activeChat(useChatStore.getState()).messages[0];
    expect(msg.content).toBe("Hello there, world");
    // The resulting part remains coalesced as well.
    expect(msg.parts).toEqual([{ kind: "text", text: "Hello there, world" }]);
  });

  test("thinking and text keep their arrival order through a batch", () => {
    handleServerMessage({ type: "thinking_delta", text: "let me " } as ServerMessage);
    handleServerMessage({ type: "thinking_delta", text: "check" } as ServerMessage);
    delta("The answer");
    handleServerMessage({ type: "thinking_delta", text: "hmm" } as ServerMessage);
    delta(" is 42");

    paint();

    const msg = activeChat(useChatStore.getState()).messages[0];
    expect(msg.parts).toEqual([
      { kind: "thinking", text: "let me check" },
      { kind: "text", text: "The answer" },
      { kind: "thinking", text: "hmm" },
      { kind: "text", text: " is 42" },
    ]);
    expect(msg.content).toBe("The answer is 42");
    expect(msg.thinking).toBe("let me checkhmm");
  });

  test("a non-delta frame lands after the text that preceded it, not before", () => {
    delta("Reading the file");
    // No paint: the text is still buffered when the tool call arrives.
    handleServerMessage({
      type: "tool_use_start",
      toolUseId: "t1",
      toolName: "Read",
    } as ServerMessage);
    delta("Done");
    paint();

    const msg = activeChat(useChatStore.getState()).messages[0];
    expect(msg.parts).toEqual([
      { kind: "text", text: "Reading the file" },
      { kind: "tool", toolIndex: 0 },
      { kind: "text", text: "Done" },
    ]);
  });

  test("deltas for different sessions stay in their own buffers", () => {
    const store = useChatStore.getState();
    store.setMessages("A", []);
    store.setMessages("B", []);

    handleServerMessage({ type: "text_delta", text: "for A", sessionId: "A" } as ServerMessage);
    handleServerMessage({ type: "text_delta", text: "for B", sessionId: "B" } as ServerMessage);
    handleServerMessage({ type: "text_delta", text: " more A", sessionId: "A" } as ServerMessage);
    paint();

    const state = useChatStore.getState();
    expect(state.buffers.A.messages[0].content).toBe("for A more A");
    expect(state.buffers.B.messages[0].content).toBe("for B");
  });

  test("any non-delta frame applies whatever was still buffered", () => {
    delta("half a sentence");
    // A hidden tab never gets an animation frame, so the buffer must not
    // depend on one to drain.
    handleServerMessage({ type: "status", status: "idle" } as ServerMessage);

    expect(activeChat(useChatStore.getState()).messages[0].content).toBe(
      "half a sentence"
    );
  });
});

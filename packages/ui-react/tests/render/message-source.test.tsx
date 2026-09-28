// Render test for a replayed message's source (#549): a user message the
// host replays with `source: "voice-dictate"` keeps its dictation badge, and
// one replayed without a source renders as typed. The frame goes through the
// real client handler into the store, and the stored message is rendered by
// the component the transcript uses. Queries come from `render()`, never
// `screen` — see tests/render/dom.ts for why.
import { unregisterMessageSourceDom } from "./message-source-dom.js";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import type { SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";

import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { flushChatDeltas, handleServerMessage } from "../../src/hooks/use-websocket.js";
import { useChatStore } from "../../src/stores/chat-store.js";

afterEach(cleanup);
afterAll(unregisterMessageSourceDom);

beforeEach(() => {
  flushChatDeltas();
  useChatStore.setState({
    buffers: {},
    draft: null,
    pendingDraftId: null,
    activeSessionId: null,
    runStates: {},
  });
});

const noop = () => {};

/** Replay `messages` as the host sends them, then render each stored user message. */
function replayAndRender(messages: SessionHistoryMessage[]) {
  useChatStore.getState().setActiveSession("s1");
  handleServerMessage({ type: "session_history", sessionId: "s1", messages });
  const stored = useChatStore.getState().buffers["s1"]!.messages.filter((m) => m.role === "user");
  // The frame reached the store: without this, a badge-free render would
  // pass for an empty transcript.
  expect(stored).toHaveLength(messages.filter((m) => m.role === "user").length);
  return stored.map((message) =>
    render(
      <MessageBubble
        message={message}
        onToolApproval={noop}
        onAskUserSubmit={noop}
        onAskUserCancel={noop}
      />
    )
  );
}

describe("a replayed user message keeps its source", () => {
  test("a dictated message shows the dictation badge after replay", () => {
    const [dictated] = replayAndRender([
      { role: "user", content: "Buy oat milk", toolCalls: [], source: "voice-dictate" },
      { role: "assistant", content: "Added.", toolCalls: [] },
    ]);
    expect(dictated!.container.textContent).toContain("Buy oat milk");
    expect(dictated!.getByRole("img", { name: "Voice dictation" })).toBeTruthy();
  });

  test("a message replayed without a source renders as typed, with no badge", () => {
    const [typed] = replayAndRender([{ role: "user", content: "Buy oat milk", toolCalls: [] }]);
    expect(typed!.container.textContent).toContain("Buy oat milk");
    expect(typed!.queryByRole("img", { name: /^Voice/ })).toBeNull();
    expect(useChatStore.getState().buffers["s1"]!.messages[0]!.source).toBe("typed");
  });
});

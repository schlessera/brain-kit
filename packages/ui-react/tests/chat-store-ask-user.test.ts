import { describe, test, expect, beforeEach } from "bun:test";
import { useChatStore } from "../src/stores/chat-store";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk/protocol";

const Q: AskUserQuestion[] = [
  {
    question: "Which approach?",
    header: "Approach",
    multiSelect: false,
    options: [
      { label: "Inline", description: "Inline UI" },
      { label: "Modal", description: "Modal overlay" },
    ],
  },
];

beforeEach(() => {
  useChatStore.setState({
    buffers: {},
    draft: null,
    activeSessionId: null,
    runStates: {},
  });
});

/** The draft buffer (all mutations below use the null / draft key). */
function draft() {
  return useChatStore.getState().draft!;
}

describe("chat store askUser state", () => {
  test("setAskUserRequest attaches exchange to the streaming assistant message", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-1", Q);

    const chat = draft();
    expect(chat.askUser).toEqual({ requestId: "req-1", questions: Q });
    const last = chat.messages[chat.messages.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.askUserExchanges).toEqual([{ requestId: "req-1", questions: Q }]);
  });

  test("submitAskUserAnswers fills both the buffer state and the message exchange", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-2", Q);
    store.submitAskUserAnswers(null, "req-2", { "Which approach?": "Inline" });

    const chat = draft();
    expect(chat.askUser?.answers).toEqual({ "Which approach?": "Inline" });
    const last = chat.messages[chat.messages.length - 1];
    expect(last.askUserExchanges?.[0].answers).toEqual({
      "Which approach?": "Inline",
    });
  });

  test("cancelAskUser marks the exchange cancelled", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-3", Q);
    store.cancelAskUser(null, "req-3");

    const chat = draft();
    expect(chat.askUser?.cancelled).toBe(true);
    const last = chat.messages[chat.messages.length - 1];
    expect(last.askUserExchanges?.[0].cancelled).toBe(true);
  });

  test("submitAskUserAnswers with a mismatched requestId is a no-op", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-4", Q);
    store.submitAskUserAnswers(null, "other-id", { foo: "bar" });

    const chat = draft();
    expect(chat.askUser?.answers).toBeUndefined();
    expect(
      chat.messages[chat.messages.length - 1].askUserExchanges?.[0].answers
    ).toBeUndefined();
  });

  test("multiple requests append exchanges in order", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-a", Q);
    store.submitAskUserAnswers(null, "req-a", { "Which approach?": "Inline" });
    store.setAskUserRequest(null, "req-b", Q);

    const chat = draft();
    const last = chat.messages[chat.messages.length - 1];
    expect(last.askUserExchanges).toHaveLength(2);
    expect(last.askUserExchanges?.[0].answers).toEqual({ "Which approach?": "Inline" });
    expect(last.askUserExchanges?.[1].answers).toBeUndefined();
  });

  test("clearMessages wipes askUser state", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-z", Q);
    store.clearMessages();

    const state = useChatStore.getState();
    expect(state.draft).toBeNull();
  });

  test("clearAskUser drops only the pending exchange pointer", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserRequest(null, "req-c", Q);
    store.clearAskUser(null);

    const chat = draft();
    expect(chat.askUser).toBeNull();
    // The exchange stays on the message for transcript rendering.
    const last = chat.messages[chat.messages.length - 1];
    expect(last.askUserExchanges).toHaveLength(1);
  });
});

describe("chat store ask_user_list state (#583)", () => {
  const LIST = {
    prompt: "Rate?",
    scale: [{ label: "loved" }, { label: "meh" }],
    items: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
    allowSkip: true,
    notes: true,
  };

  test("a list request opens the same exchange slot, holding the list", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserListRequest(null, "list-1", LIST);
    const chat = draft();
    expect(chat.askUser).toEqual({ requestId: "list-1", questions: [], list: LIST });
    expect(chat.messages.at(-1)!.askUserExchanges).toEqual([
      { requestId: "list-1", questions: [], list: LIST },
    ]);
  });

  test("submitting records answers and notes by item id on both copies", () => {
    const store = useChatStore.getState();
    store.startAssistantMessage(null);
    store.setAskUserListRequest(null, "list-2", LIST);
    store.submitAskUserListAnswers(null, "list-2", { a: "loved" }, { b: "later" });
    const chat = draft();
    expect(chat.askUser?.answers).toEqual({ a: "loved" });
    expect(chat.askUser?.notes).toEqual({ b: "later" });
    const exchange = chat.messages.at(-1)!.askUserExchanges![0]!;
    expect(exchange.answers).toEqual({ a: "loved" });
    expect(exchange.notes).toEqual({ b: "later" });
    expect(typeof exchange.answeredAt).toBe("number");
  });

  test("a list exchange is never bound to a composer message", async () => {
    const { questionForTypedAnswer } = await import("../src/components/chat/ask-user-typed");
    expect(questionForTypedAnswer({ requestId: "x", questions: [], list: LIST })).toBeNull();
  });
});

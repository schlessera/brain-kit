// Render tests for the ask_user_list exchange (#583): partial submit,
// bulk-fill, the no-skip gate, and replay after a reload. Props-only and
// keyless, mounted in happy-dom; the replay case sends the host's own
// `session_history` frame through the real client handler into the store and
// renders what the store holds. Queries come from `render()`, never `screen`
// — see tests/render/dom.ts for why.
import { unregisterAskUserListDom } from "./ask-user-list-dom.js";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { AskUserListSpec, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";

import {
  AskUserListExchangeCard,
  listReaskMessage,
} from "../../src/components/chat/ask-user-list-card.js";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { flushChatDeltas, handleServerMessage } from "../../src/hooks/use-websocket.js";
import { useChatStore } from "../../src/stores/chat-store.js";

afterEach(cleanup);
afterAll(unregisterAskUserListDom);

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

const LIST: AskUserListSpec = {
  prompt: "How did these land?",
  scale: ["loved", "liked", "meh", "hated", "not seen", "not interested"].map((label) => ({ label })),
  items: Array.from({ length: 10 }, (_, i) => ({ id: `f${i + 1}`, label: `Film ${i + 1}` })),
  allowSkip: true,
  notes: false,
};

type Submitted = [string, Record<string, string>, Record<string, string> | undefined];

function mount(list: AskUserListSpec, submitted: Submitted[] = []) {
  return render(
    <AskUserListExchangeCard
      requestId="req-1"
      list={list}
      onSubmit={(id, answers, notes) => submitted.push([id, answers, notes])}
      onCancel={noop}
    />
  );
}

describe("AskUserListExchangeCard · pending", () => {
  test("one card for the whole list: one radiogroup per item, one Submit", () => {
    const { getAllByRole } = mount(LIST);
    expect(getAllByRole("radiogroup")).toHaveLength(10);
    expect(getAllByRole("button").filter((b) => (b.textContent ?? "").startsWith("Submit"))).toHaveLength(1);
    expect(getAllByRole("button", { name: "Dismiss" })).toHaveLength(1);
  });

  test("a partial submit sends only the answered ids, keyed by id", () => {
    const submitted: Submitted[] = [];
    const { getByRole } = mount(LIST, submitted);
    fireEvent.click(getByRole("radio", { name: "loved, Film 1" }));
    fireEvent.click(getByRole("radio", { name: "not seen, Film 4" }));
    fireEvent.click(getByRole("button", { name: "Submit 2 · skip 8" }));
    expect(submitted).toEqual([["req-1", { f1: "loved", f4: "not seen" }, undefined]]);
  });

  test("set-all-remaining fills only the open rows and never overwrites a choice", () => {
    const submitted: Submitted[] = [];
    const { getByRole } = mount(LIST, submitted);
    fireEvent.click(getByRole("radio", { name: "loved, Film 1" }));
    fireEvent.click(getByRole("radio", { name: "hated, Film 2" }));
    fireEvent.click(getByRole("button", { name: "Set the 8 unanswered items to…" }));
    fireEvent.click(getByRole("button", { name: "Set 8 to meh" }));
    fireEvent.click(getByRole("button", { name: "Submit 10" }));
    const [, answers] = submitted[0]!;
    expect(answers.f1).toBe("loved");
    expect(answers.f2).toBe("hated");
    for (let i = 3; i <= 10; i++) expect(answers[`f${i}`]).toBe("meh");
  });

  test("with allowSkip false, Submit says what remains and never sends short", () => {
    const submitted: Submitted[] = [];
    const { getByRole, container } = mount({ ...LIST, allowSkip: false }, submitted);
    fireEvent.click(getByRole("radio", { name: "liked, Film 3" }));
    const gate = getByRole("button", { name: "9 left to answer" });
    expect(gate.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      fireEvent.click(gate);
    });
    expect(submitted).toEqual([]);
    // Not a silent no-op: the open rows are flagged, and the counter says so.
    expect(container.querySelectorAll('[role="radiogroup"][aria-invalid="true"]')).toHaveLength(9);
    expect(container.textContent).toContain("9 need an answer");
    // Answering everything opens the gate.
    fireEvent.click(getByRole("button", { name: /Set the 9 unanswered/ }));
    fireEvent.click(getByRole("button", { name: "Set 9 to meh" }));
    fireEvent.click(getByRole("button", { name: "Submit 10" }));
    expect(submitted).toHaveLength(1);
    expect(Object.keys(submitted[0]![1])).toHaveLength(10);
  });

  test("notes travel beside the answers, and a skipped item keeps its note", () => {
    const submitted: Submitted[] = [];
    const { getByRole } = mount({ ...LIST, notes: true }, submitted);
    fireEvent.click(getByRole("button", { name: "Add note, Film 2" }));
    const note = getByRole("textbox", { name: "Note on Film 2" });
    // Under happy-dom, React's change plugin falls back to polling the
    // focused field's value on key events, as it would for an old browser.
    act(() => note.focus());
    fireEvent.change(note, { target: { value: "rewatch first" } });
    fireEvent.keyUp(note, { key: "t" });
    fireEvent.click(getByRole("radio", { name: "loved, Film 1" }));
    fireEvent.click(getByRole("button", { name: "Submit 1 · skip 9" }));
    expect(submitted).toEqual([["req-1", { f1: "loved" }, { f2: "rewatch first" }]]);
  });
});

describe("AskUserListExchangeCard · dismissed and asked again", () => {
  test("a reopened card answers by composer message, not by a response nobody awaits", () => {
    const reasks: string[] = [];
    const submitted: Submitted[] = [];
    const { getByRole } = render(
      <AskUserListExchangeCard
        requestId="req-9"
        list={{ ...LIST, items: LIST.items.slice(0, 2) }}
        cancelled
        onSubmit={(id, a, n) => submitted.push([id, a, n])}
        onCancel={noop}
        onReask={(text) => reasks.push(text)}
      />
    );
    fireEvent.click(getByRole("button", { name: "Ask again" }));
    fireEvent.click(getByRole("radio", { name: "meh, Film 2" }));
    fireEvent.click(getByRole("button", { name: "Submit 1 · skip 1" }));
    expect(submitted).toEqual([]);
    expect(reasks).toEqual([
      "Answering \u201CHow did these land?\u201D:\n- Film 2: meh\nSkipped: Film 1",
    ]);
  });

  test("the reask message lists answers in item order, then the skipped", () => {
    expect(listReaskMessage(LIST, { f2: "loved" }, { f3: "later" }).split("\n")).toEqual([
      "Answering \u201CHow did these land?\u201D:",
      "- Film 2: loved",
      "Skipped: Film 1, Film 3 (later), Film 4, Film 5, Film 6, Film 7, Film 8, Film 9, Film 10",
    ]);
  });
});

describe("replay after a reload", () => {
  /** Both backends persist the tool call's input and its JSON result. */
  function history(output: string | undefined, isError = false): SessionHistoryMessage[] {
    return [
      { role: "user", content: "rate these", toolCalls: [] },
      {
        role: "assistant",
        content: "Noted.",
        toolCalls: [
          {
            id: "tool-q",
            name: "mcp__brain-ui__ask_user",
            input: {
              questions: [
                {
                  question: "Which list?",
                  header: "List",
                  multiSelect: false,
                  options: [
                    { label: "Films", description: "" },
                    { label: "Shows", description: "" },
                  ],
                },
              ],
            },
            output: JSON.stringify({ questions: [], answers: { "Which list?": "Films" } }),
          },
          {
            id: "tool-l",
            name: "ask_user_list",
            input: {
              prompt: LIST.prompt,
              scale: LIST.scale,
              items: LIST.items.slice(0, 4),
              notes: true,
            },
            ...(output !== undefined ? { output } : {}),
            ...(isError ? { isError: true } : {}),
          },
        ],
        parts: [
          { kind: "tool", toolIndex: 0 },
          { kind: "tool", toolIndex: 1 },
          { kind: "text", text: "Noted." },
        ],
      },
    ] as SessionHistoryMessage[];
  }

  function replay(messages: SessionHistoryMessage[]) {
    useChatStore.getState().setActiveSession("s1");
    handleServerMessage({ type: "session_history", sessionId: "s1", messages });
    const last = useChatStore.getState().buffers["s1"]!.messages.at(-1)!;
    return {
      last,
      view: render(
        <MessageBubble
          message={last}
          onToolApproval={noop}
          onAskUserSubmit={noop}
          onAskUserCancel={noop}
          onAskUserListSubmit={noop}
        />
      ),
    };
  }

  test("an answered list comes back as its compact summary, next to the question before it", () => {
    const { last, view } = replay(
      history(JSON.stringify({ answers: { f1: "loved", f3: "loved", f2: "meh" }, skipped: ["f4"], notes: { f4: "later" } }))
    );
    // Two exchanges, in call order, each drawn by its own card.
    expect(last.askUserExchanges?.map((e) => Boolean(e.list))).toEqual([false, true]);
    const text = view.container.textContent ?? "";
    expect(text).toContain("Films");
    expect(text).toContain("loved (2)");
    expect(text).toContain("meh (1)");
    expect(text).toContain("skipped (1)");
    expect(text).toContain("\u201Clater\u201D");
    // At its call's place in the turn, before the text that followed it — not
    // trailing the message as an exchange with no tool part would.
    expect(text.indexOf("loved (2)")).toBeLessThan(text.indexOf("Noted."));
    // The record, not the controls.
    expect(view.queryAllByRole("radio")).toHaveLength(0);
    expect(view.container.querySelectorAll('[data-group]')).toHaveLength(3);
  });

  test("a dismissed list comes back dismissed, not pending", () => {
    const { view } = replay(history("User dismissed", true));
    expect(view.queryAllByRole("radio")).toHaveLength(0);
    expect(view.container.textContent).toContain("Unanswered");
  });
});

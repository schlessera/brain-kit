import { unregisterAskUserFormDom } from "./ask-user-form-dom.js";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { act, cleanup, fireEvent, render as renderDom } from "@testing-library/react";
import type { ReactNode } from "react";
import { AskUserFormCard } from "@schlessera/brain-ui-kit";
import { AskUserFormExchangeCard } from "../../src/components/chat/ask-user-form-card.js";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
let root: BrainUiRoot;
let useChatStore: BrainUiRoot["stores"]["chat"];
let useUIStore: BrainUiRoot["stores"]["ui"];
const render = (node: ReactNode) => renderDom(<BrainUiProvider root={root}>{node}</BrainUiProvider>);
const handleServerMessage: BrainUiRoot["connection"]["handleServerMessage"] = (message) => root.connection.handleServerMessage(message);
import type {
  AskUserFormSpec,
  AskUserFormAnswers,
} from "@schlessera/brain-ui-sdk/protocol";
afterEach(cleanup);
afterEach(() => root.dispose());
afterAll(unregisterAskUserFormDom);
beforeEach(() => {
  root = createBrainUiRoot({ storage: null });
  useChatStore = root.stores.chat; useUIStore = root.stores.ui;
  useChatStore.setState({
    buffers: {},
    draft: null,
    pendingDraftId: null,
    activeSessionId: null,
    runStates: {},
  });
  useUIStore.setState({ singleKeyShortcuts: true });
});
const noop = () => {};
const FORM: AskUserFormSpec = {
  prompt: "What shall we do?",
  nodes: [
    {
      id: "activity",
      kind: "single",
      header: "Evening",
      prompt: "Which activity?",
      options: [{ label: "Film" }, { label: "Game" }, { label: "Walk" }],
    },
    {
      id: "genres",
      kind: "multi",
      prompt: "Which genres?",
      showIf: { node: "activity", anyOf: ["Film"] },
      options: [{ label: "Adventure" }, { label: "Comedy" }],
    },
    {
      id: "games",
      kind: "rank",
      prompt: "Which game first?",
      showIf: { node: "activity", anyOf: ["Game"] },
      items: [
        { id: "voyage", label: "Voyage" },
        { id: "harbor", label: "Harbor" },
      ],
    },
    {
      id: "distance",
      kind: "single",
      prompt: "How far?",
      showIf: { node: "activity", anyOf: ["Walk"] },
      options: [{ label: "Short" }, { label: "Long" }],
    },
  ],
};
function mount(form = FORM) {
  const sent: { answers: AskUserFormAnswers; visibleNodes: string[] }[] = [];
  return {
    ...render(
      <AskUserFormExchangeCard
        requestId="form-1"
        form={form}
        onSubmit={(_, answers, visibleNodes) =>
          sent.push({ answers, visibleNodes })
        }
        onCancel={noop}
      />,
    ),
    sent,
  };
}
describe("conditional form exchange", () => {
  test("switching a filled branch hides it, retains parent focus, and submits only the new visible path", () => {
    const view = mount();
    fireEvent.click(view.getByRole("radio", { name: "Film" }));
    fireEvent.click(view.getByRole("checkbox", { name: "Adventure" }));
    fireEvent.click(view.getByRole("checkbox", { name: "Comedy" }));
    const game = view.getByRole("radio", { name: "Game" });
    act(() => game.focus());
    fireEvent.click(game);
    expect(document.activeElement).toBe(game);
    expect(view.queryByRole("checkbox", { name: "Adventure" })).toBeNull();
    expect(
      view.container.querySelector("[data-form-live]")?.textContent,
    ).toContain("2 answers set aside");
    expect(view.container.querySelectorAll("[data-form-head]")).toHaveLength(1);
    expect(view.container.querySelectorAll("[data-form-actions]")).toHaveLength(
      1,
    );
    expect(
      view.container.querySelectorAll(
        "[data-rank-head],.bk-rank-actions,[data-list-head],[data-list-foot]",
      ),
    ).toHaveLength(0);
    fireEvent.click(
      view.getByRole("button", { name: "Harbor, position 2 of 2" }),
    );
    fireEvent.click(
      view.getByRole("button", { name: "Voyage, position 1 of 2" }),
    );
    fireEvent.click(view.getByRole("button", { name: "Submit" }));
    expect(view.sent).toEqual([
      {
        answers: {
          activity: { value: "Game" },
          games: { order: ["harbor", "voyage"], unchanged: false },
        },
        visibleNodes: ["activity", "games"],
      },
    ]);
  });
  test("Undo and reselect restore held values; held answers never count toward progress", () => {
    const view = mount();
    fireEvent.click(view.getByRole("radio", { name: "Film" }));
    fireEvent.click(view.getByRole("checkbox", { name: "Adventure" }));
    fireEvent.click(view.getByRole("radio", { name: "Walk" }));
    expect(
      view.getByRole("button", { name: "1 left to answer" }),
    ).toBeDefined();
    fireEvent.click(view.getByRole("button", { name: /Undo/ }));
    expect(
      view.getByRole("radio", { name: "Film" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      view
        .getByRole("checkbox", { name: "Adventure" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(view.getByRole("radio", { name: "Game" }));
    fireEvent.click(view.getByRole("radio", { name: "Film" }));
    expect(
      view
        .getByRole("checkbox", { name: "Adventure" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(view.queryByRole("button", { name: /Undo/ })).toBeNull();
  });
  test("required gaps are announced and marked, then a picked rank blocks Submit with feedback", () => {
    const view = mount();
    fireEvent.click(view.getByRole("button", { name: "1 left to answer" }));
    expect(view.sent).toHaveLength(0);
    expect(
      view.container
        .querySelector('[data-form-node="activity"]')
        ?.getAttribute("aria-invalid"),
    ).toBe("true");
    expect(document.activeElement).toBe(
      view.getByRole("radio", { name: "Film" }),
    );
    fireEvent.click(view.getByRole("radio", { name: "Game" }));
    fireEvent.click(
      view.getByRole("button", { name: "Voyage, position 1 of 2" }),
    );
    const submit = view.getByRole("button", { name: "Finish moving Voyage" });
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(submit);
    expect(view.sent).toHaveLength(0);
    expect(
      view.container.querySelector("[data-form-live]")?.textContent,
    ).toContain("Finish moving Voyage");
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    fireEvent.click(view.getByRole("button", { name: "Submit" }));
    expect(view.sent[0]?.answers.games).toEqual({
      order: ["voyage", "harbor"],
      unchanged: true,
    });
  });
  test("Other matching a label never reveals, and optional empty text is skipped", () => {
    const view = mount({
      ...FORM,
      nodes: [
        ...FORM.nodes,
        { id: "note", kind: "text", prompt: "Any notes?", required: false },
      ],
    });
    fireEvent.click(view.getByRole("radio", { name: /Other/ }));
    fireEvent.input(view.getByRole("textbox", { name: /Other answer/ }), {
      target: { value: "Film" },
    });
    expect(view.queryByRole("checkbox", { name: "Adventure" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Submit" }));
    expect(view.sent[0]).toEqual({
      answers: { activity: { value: "Film", other: true } },
      visibleNodes: ["activity", "note"],
    });
  });
  test("a required scale counts as one question and a text field completes separately", () => {
    const view = mount({
      prompt: "Preferences",
      nodes: [
        {
          id: "rate",
          kind: "scale",
          prompt: "Rate these",
          scale: [{ label: "Keep" }, { label: "Pass" }],
          items: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        },
        { id: "text", kind: "text", prompt: "Why?" },
      ],
    });
    fireEvent.click(view.getByRole("radio", { name: "Keep, A" }));
    expect(
      view.getByRole("button", { name: "2 left to answer" }),
    ).toBeDefined();
    fireEvent.click(view.getByRole("radio", { name: "Pass, B" }));
    fireEvent.input(view.getByRole("textbox", { name: "Why?" }), {
      target: { value: "  Good fit  " },
    });
    fireEvent.click(view.getByRole("button", { name: "Submit" }));
    expect(view.sent[0]?.answers).toEqual({
      rate: { answers: { a: "Keep", b: "Pass" }, skipped: [] },
      text: "Good fit",
    });
  });
  test("a persisted answer replays through the real history handler and bubble without hidden answers", () => {
    act(() =>
      handleServerMessage({
        type: "session_history",
        sessionId: "s",
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tool-1",
                name: "mcp__brain-ui__ask_user_form",
                input: FORM as unknown as Record<string, unknown>,
                output: JSON.stringify({
                  answers: {
                    activity: { value: "Game" },
                    genres: { values: ["Adventure"] },
                    games: { order: ["harbor", "voyage"], unchanged: false },
                  },
                  visibleNodes: ["activity", "games"],
                }),
              },
            ],
          },
        ],
      }),
    );
    const message = useChatStore.getState().buffers.s!.messages[0]!;
    expect(message.askUserExchanges?.[0]?.formAnswers).not.toHaveProperty(
      "genres",
    );
    const view = render(
      <MessageBubble
        message={message}
        onToolApproval={noop}
        onAskUserSubmit={noop}
        onAskUserListSubmit={noop}
        onAskUserCancel={noop}
      />,
    );
    expect(
      view.container.querySelector('[data-state="answered"]'),
    ).not.toBeNull();
    expect(view.container.textContent).toContain("1. Harbor");
    expect(view.container.textContent).not.toContain("Adventure");
    expect(view.queryByRole("button", { name: "Submit" })).toBeNull();
  });
});

describe("form path records", () => {
  test("breadcrumbs name selected answers even when node headers differ", () => {
    const view = render(
      <AskUserFormCard
        question="Evening"
        nodes={FORM.nodes}
        answers={{ activity: { value: "Walk" } }}
      />,
    );
    const path = view.container.querySelector(
      '[data-form-node="distance"] > .bk-form-path',
    )!;
    expect(path.textContent).toBe("Evening › Walk");
    fireEvent.click(view.getByRole("button", { name: "Go to Evening" }));
    expect(document.activeElement).toBe(
      view.getByRole("radio", { name: "Walk" }),
    );
  });
  test("single chains omit questions, and ranking retains five entries before its own disclosure", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      id: `r${i}`,
      label: `Crossing ${i + 1}`,
    }));
    const view = render(
      <AskUserFormCard
        state="answered"
        question="Evening"
        nodes={[
          FORM.nodes[0]!,
          FORM.nodes[3]!,
          {
            id: "games",
            kind: "rank",
            prompt: "Which game first?",
            items,
            showIf: { node: "activity", anyOf: ["Game"] },
          },
        ]}
        answers={{
          activity: { value: "Game" },
          games: { order: items.map((item) => item.id), unchanged: true },
        }}
      />,
    );
    expect(view.container.textContent).toContain("5. Crossing 5");
    expect(view.container.textContent).not.toContain("6. Crossing 6");
    fireEvent.click(view.getByRole("button", { name: "+3 more, in order" }));
    expect(view.container.textContent).toContain("8. Crossing 8");
    view.rerender(
      <AskUserFormCard
        state="answered"
        question="Evening"
        nodes={FORM.nodes}
        answers={{ activity: { value: "Walk" }, distance: { value: "Long" } }}
      />,
    );
    expect(view.container.textContent).toContain("Walk → Long");
    expect(view.container.textContent).not.toContain("How far?");
  });
  test("a cutoff shows only counted entries before disclosing unranked items", () => {
    const view = render(
      <AskUserFormCard
        state="answered"
        question="Rank"
        nodes={[
          {
            id: "games",
            kind: "rank",
            prompt: "Which game first?",
            items: [
              { id: "voyage", label: "Voyage" },
              { id: "harbor", label: "Harbor" },
            ],
            cutoff: 1,
          },
        ]}
        answers={{ games: { order: ["harbor", "voyage"], unchanged: false } }}
      />,
    );
    expect(view.container.textContent).toContain("1. Harbor");
    expect(view.container.textContent).not.toContain("Voyage");
    fireEvent.click(view.getByRole("button", { name: "+1 not ranked" }));
    expect(view.container.textContent).toContain("– Voyage");
    expect(view.container.textContent).not.toContain("2. Voyage");
  });
  test("long forms collapse complete answer records, and optional empty nodes say skipped", () => {
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      kind: "text" as const,
      prompt: `Recollection ${i + 1}`,
      required: false,
    }));
    const view = render(
      <AskUserFormCard
        state="answered"
        question="Notes"
        nodes={nodes}
        answers={{ t0: "First" }}
      />,
    );
    expect(view.container.querySelectorAll("[data-form-answer]")).toHaveLength(
      4,
    );
    expect(view.container.textContent).toContain("Recollection 2 — skipped");
    fireEvent.click(view.getByRole("button", { name: "4 more answers" }));
    expect(view.container.querySelectorAll("[data-form-answer]")).toHaveLength(
      8,
    );
  });
});

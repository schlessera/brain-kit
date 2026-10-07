// Render tests for the ask_user exchange and the image-mask receipt (D38 §1,
// §2): props-only, keyless, mounted in happy-dom. Queries come from `render()`,
// never `screen` — see tests/render/dom.ts for why.
import { unregisterAskUserDom } from "./ask-user-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk/protocol";
import type { ToolCallView } from "@schlessera/brain-ui-sdk/client";

import {
  AskUserCard,
  DISMISSED_NOTE,
  TYPED_META,
  answeredMeta,
  recordedAnswers,
} from "../../src/components/chat/ask-user-card.js";
import { reaskMessage, takeComposerTextAsAnswer } from "../../src/components/chat/ask-user-typed.js";
import { createBrainUiRoot } from "../../src/root.js";
import {
  ImageMaskFallback,
  ImageMaskResultCard,
  MASK_NOT_RENDERED,
  REGION_NOT_RECORDED,
  maskReceiptRows,
} from "../../src/components/chat/tool-cards/image-mask-card.js";

afterEach(cleanup);
afterAll(unregisterAskUserDom);

const QUESTION = "Which draft should I keep?";
const single: AskUserQuestion[] = [
  {
    question: QUESTION,
    header: "Draft",
    multiSelect: false,
    options: [
      { label: "Alpha", description: "the longer draft" },
      { label: "Beta", description: "the shorter draft" },
    ],
  },
];
const multi: AskUserQuestion[] = [
  {
    question: "Which sections stay?",
    header: "Sections",
    multiSelect: true,
    options: [
      { label: "Intro", description: "" },
      { label: "Method", description: "" },
      { label: "Notes", description: "" },
    ],
  },
];

describe("AskUserCard · pending", () => {
  test("renders the options as one radiogroup and submits the chosen one", () => {
    const submitted: unknown[] = [];
    const { getByText, getAllByRole } = render(
      <AskUserCard
        requestId="req-1"
        questions={single}
        onSubmit={(id, answers, annotations) => submitted.push([id, answers, annotations])}
        onCancel={() => {}}
      />
    );
    expect(getAllByRole("radiogroup")).toHaveLength(1);
    // Two options plus "Other".
    expect(getAllByRole("radio")).toHaveLength(3);
    fireEvent.click(getByText("Alpha"));
    fireEvent.click(getByText("Submit"));
    expect(submitted).toEqual([["req-1", { [QUESTION]: "Alpha" }, undefined]]);
  });

  test("Submit with nothing chosen is a no-op, never a partial answer", () => {
    let calls = 0;
    const { getByText } = render(
      <AskUserCard requestId="req-2" questions={single} onSubmit={() => calls++} onCancel={() => {}} />
    );
    fireEvent.click(getByText("Submit"));
    expect(calls).toBe(0);
  });

  test("Dismiss calls onCancel with the request id", () => {
    const cancelled: string[] = [];
    const { getByText } = render(
      <AskUserCard requestId="req-3" questions={single} onSubmit={() => {}} onCancel={(id) => cancelled.push(id)} />
    );
    fireEvent.click(getByText("Dismiss"));
    expect(cancelled).toEqual(["req-3"]);
  });

  test("'Other' opens the kit's field and Enter submits the typed text as the answer", () => {
    const submitted: unknown[] = [];
    const { getByText, getByLabelText, queryByLabelText } = render(
      <AskUserCard
        requestId="req-4"
        questions={single}
        onSubmit={(id, answers) => submitted.push([id, answers])}
        onCancel={() => {}}
      />
    );
    expect(queryByLabelText("Your own answer")).toBeNull();
    fireEvent.click(getByText("Other"));
    const field = getByLabelText("Your own answer") as HTMLInputElement;
    // Focus first, as a typing user has. react-dom is CommonJS and reads
    // `canUseDOM` when it is first evaluated, which can precede this file's
    // DOM registration; it then takes its input-event polyfill, which
    // resolves a keydown through the focused element and throws on none.
    fireEvent.focus(field);
    field.value = "neither, merge them";
    fireEvent.keyDown(field, { key: "Enter" });
    expect(submitted).toEqual([["req-4", { [QUESTION]: "neither, merge them" }]]);
  });

  test("a chosen option with a preview travels as an annotation and shows below the card", () => {
    const submitted: unknown[] = [];
    const withPreview: AskUserQuestion[] = [
      {
        ...single[0],
        options: [{ label: "Alpha", description: "d", preview: "# Alpha draft" }],
      },
    ];
    const { getByText } = render(
      <AskUserCard
        requestId="req-5"
        questions={withPreview}
        onSubmit={(_id, answers, annotations) => submitted.push([answers, annotations])}
        onCancel={() => {}}
      />
    );
    fireEvent.click(getByText("Alpha"));
    expect(getByText("Preview")).toBeTruthy();
    fireEvent.click(getByText("Submit"));
    expect(submitted).toEqual([[{ [QUESTION]: "Alpha" }, { [QUESTION]: { preview: "# Alpha draft" } }]]);
  });

  test("multi-select rides the kit card: checkboxes in a group, the picks joined", () => {
    const submitted: unknown[] = [];
    const { getByText, getAllByRole, getByRole, queryAllByRole, queryByRole } = render(
      <AskUserCard
        requestId="req-6"
        questions={multi}
        onSubmit={(_id, answers) => submitted.push(answers)}
        onCancel={() => {}}
      />
    );
    expect(queryAllByRole("radio")).toHaveLength(0);
    expect(queryByRole("radiogroup")).toBeNull();
    // The kit's group, labelled by the question; three options plus "Other".
    expect(getByRole("group").getAttribute("aria-labelledby")).toBe("req-6-0-question");
    const boxes = getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    // Square marks: the shape is the affordance.
    for (const box of boxes) expect((box.firstElementChild as HTMLElement).style.borderRadius).toBe("5px");
    // No native checkbox left behind.
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    fireEvent.click(getByText("Submit"));
    expect(submitted).toHaveLength(0);
    fireEvent.click(getByText("Intro"));
    fireEvent.click(getByText("Notes"));
    expect(boxes[0]!.getAttribute("aria-checked")).toBe("true");
    expect(boxes[1]!.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(getByText("Submit"));
    expect(submitted).toEqual([{ "Which sections stay?": "Intro, Notes" }]);
  });

  test("multi-select: Other toggles like any row, opens the field, and a focused option previews", () => {
    const withPreview: AskUserQuestion[] = [
      {
        ...multi[0],
        options: [
          { label: "Intro", description: "", preview: "# Intro draft" },
          { label: "Method", description: "" },
        ],
      },
    ];
    const { getByText, getAllByRole, queryByText, queryByLabelText } = render(
      <AskUserCard requestId="req-7" questions={withPreview} onSubmit={() => {}} onCancel={() => {}} />
    );
    const boxes = getAllByRole("checkbox");
    const other = boxes[boxes.length - 1]!;
    fireEvent.click(getByText("Other"));
    expect(other.getAttribute("aria-checked")).toBe("true");
    expect(queryByLabelText("Your own answer")).not.toBeNull();
    fireEvent.click(getByText("Other"));
    expect(other.getAttribute("aria-checked")).toBe("false");
    expect(queryByLabelText("Your own answer")).toBeNull();

    // The contract's preview follows FOCUS, not selection.
    expect(queryByText("Preview")).toBeNull();
    fireEvent.focus(boxes[0]!);
    expect(getByText("Preview")).toBeTruthy();
    fireEvent.focus(boxes[1]!);
    expect(queryByText("Preview")).toBeNull();
  });

  test("multi-select: a typed Other answer joins the other picks", () => {
    const submitted: unknown[] = [];
    const { getByText, getByLabelText } = render(
      <AskUserCard
        requestId="req-6b"
        questions={multi}
        onSubmit={(_id, answers) => submitted.push(answers)}
        onCancel={() => {}}
      />
    );
    fireEvent.click(getByText("Method"));
    fireEvent.click(getByText("Other"));
    const field = getByLabelText("Your own answer") as HTMLInputElement;
    field.value = "the appendix";
    fireEvent.focus(field);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(submitted).toEqual([{ "Which sections stay?": "Method, the appendix" }]);
  });

  test("single-select: arrowing focus over an option previews it before it is picked", () => {
    const withPreview: AskUserQuestion[] = [
      {
        ...single[0],
        options: [
          { label: "Alpha", description: "d", preview: "# Alpha draft" },
          { label: "Beta", description: "e" },
        ],
      },
    ];
    const { getAllByRole, getByText, queryByText } = render(
      <AskUserCard requestId="req-8" questions={withPreview} onSubmit={() => {}} onCancel={() => {}} />
    );
    const radios = getAllByRole("radio");
    expect(queryByText("Preview")).toBeNull();
    fireEvent.focus(radios[0]!);
    expect(getByText("Preview")).toBeTruthy();
    fireEvent.focus(radios[1]!);
    expect(queryByText("Preview")).toBeNull();
  });

  test("several questions share one header and action row, and answers gather", () => {
    const submitted: unknown[] = [];
    const two: AskUserQuestion[] = [
      single[0],
      { question: "And the title?", header: "Title", multiSelect: false, options: [{ label: "Keep", description: "" }] },
    ];
    const { getByText, getAllByText } = render(
      <AskUserCard
        requestId="req-7"
        questions={two}
        onSubmit={(_id, answers) => submitted.push(answers)}
        onCancel={() => {}}
      />
    );
    expect(getAllByText(/needs your input/)).toHaveLength(1);
    expect(getAllByText("Go to unanswered")).toHaveLength(1);
    fireEvent.click(getByText("Beta"));
    fireEvent.click(getByText("Go to unanswered"));
    expect(submitted).toHaveLength(0);
    fireEvent.click(getByText("Keep"));
    fireEvent.click(getByText("Submit"));
    expect(submitted).toEqual([{ [QUESTION]: "Beta", "And the title?": "Keep" }]);
  });
});

describe("AskUserCard · answered, typed, dismissed — all stay in the transcript", () => {
  test("answered shows the chosen answer with when; the alternatives are gone", () => {
    const { getByText, queryByText, queryByRole } = render(
      <AskUserCard
        requestId="req-8"
        questions={single}
        answered={{ [QUESTION]: "Alpha" }}
        answeredAt={Date.now()}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(getByText("Alpha")).toBeTruthy();
    expect(getByText("you chose this · just now")).toBeTruthy();
    expect(queryByText("Beta")).toBeNull();
    expect(queryByRole("radiogroup")).toBeNull();
    expect(queryByText("Submit")).toBeNull();
  });

  test("a resumed answer shows no time it does not have", () => {
    const { getByText } = render(
      <AskUserCard
        requestId="req-9"
        questions={single}
        answered={{ [QUESTION]: "Beta" }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(getByText("you chose this")).toBeTruthy();
    expect(answeredMeta(undefined)).toBe("you chose this");
  });

  test("typed quotes what it took and says where it came from", () => {
    const { getByText, queryByText } = render(
      <AskUserCard
        requestId="req-10"
        questions={single}
        answered={{ [QUESTION]: "merge both drafts" }}
        typed
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(getByText("\u201Cmerge both drafts\u201D")).toBeTruthy();
    expect(getByText(TYPED_META)).toBeTruthy();
    expect(getByText("Answered in the composer")).toBeTruthy();
    expect(queryByText("Alpha")).toBeNull();
  });

  test("a multi-select answer lists every pick, with the count in the head", () => {
    const { getByText, queryByText } = render(
      <AskUserCard
        requestId="req-10b"
        questions={multi}
        answered={{ "Which sections stay?": "Intro, Notes" }}
        answeredAt={Date.now()}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(getByText("Answered · 2 chosen")).toBeTruthy();
    expect(getByText("Intro")).toBeTruthy();
    expect(getByText("Notes")).toBeTruthy();
    expect(queryByText("Method")).toBeNull();
    expect(getByText("you chose 2 · just now")).toBeTruthy();
    expect(recordedAnswers(multi[0]!, { "Which sections stay?": "Intro, Notes" })).toEqual(["Intro", "Notes"]);
    expect(answeredMeta(undefined, 2)).toBe("you chose 2");
  });

  test("dismissed is the kit's gold fourth state: the fact, no options, no Ask again without a handler", () => {
    const { getByText, queryByText, queryByRole } = render(
      <AskUserCard requestId="req-11" questions={single} cancelled onSubmit={() => {}} onCancel={() => {}} />
    );
    expect(getByText(QUESTION)).toBeTruthy();
    expect(getByText("Unanswered — the turn ended")).toBeTruthy();
    expect(getByText(DISMISSED_NOTE)).toBeTruthy();
    expect(queryByText("Alpha")).toBeNull();
    expect(queryByText("Submit")).toBeNull();
    expect(queryByRole("button")).toBeNull();
  });

  test("Ask again reopens the card locally, and its Submit sends a composer message, not an ask_user_response", () => {
    const submitted: unknown[] = [];
    const cancelled: string[] = [];
    const reasked: string[] = [];
    const { getByText, getByRole, queryByText, getAllByRole } = render(
      <AskUserCard
        requestId="req-12"
        questions={single}
        cancelled
        onSubmit={(...args) => submitted.push(args)}
        onCancel={(id) => cancelled.push(id)}
        onReask={(text) => reasked.push(text)}
      />
    );
    fireEvent.click(getByRole("button", { name: "Ask again" }));
    // Pending again: the options are back, the lapsed row is gone.
    expect(getAllByRole("radio")).toHaveLength(3);
    expect(queryByText(DISMISSED_NOTE)).toBeNull();
    fireEvent.click(getByText("Beta"));
    fireEvent.click(getByText("Submit"));
    expect(submitted).toEqual([]);
    expect(reasked).toEqual([`Answering \u201C${QUESTION}\u201D: Beta`]);
    expect(reasked[0]).toContain(QUESTION);
    expect(reasked[0]).toContain("Beta");
    // Dismiss on a reopened card closes it again without a cancel nobody can take.
    expect(cancelled).toEqual([]);
  });

  test("Dismiss on a reopened card goes back to dismissed, and sends nothing", () => {
    const cancelled: string[] = [];
    const { getByText, getByRole, queryByRole } = render(
      <AskUserCard
        requestId="req-13"
        questions={single}
        cancelled
        onSubmit={() => {}}
        onCancel={(id) => cancelled.push(id)}
        onReask={() => {}}
      />
    );
    fireEvent.click(getByRole("button", { name: "Ask again" }));
    fireEvent.click(getByText("Dismiss"));
    expect(getByText(DISMISSED_NOTE)).toBeTruthy();
    expect(queryByRole("radio")).toBeNull();
    expect(cancelled).toEqual([]);
  });

  test("reaskMessage quotes each question with its answer", () => {
    expect(reaskMessage([{ question: "A?" }, { question: "B?" }], { "A?": "x", "B?": "y, z" })).toBe(
      "Answering \u201CA?\u201D: x\n\nAnswering \u201CB?\u201D: y, z"
    );
  });
});

const grouped: AskUserQuestion[] = [single[0]!, multi[0]!, {
  question: "When should the digest arrive?", header: "Delivery", multiSelect: false,
  options: [{ label: "Dawn", description: "" }, { label: "Evening", description: "" }],
}];

describe("AskUserCard · grouped exchange", () => {
  test.each([2, 3, 4])("%i questions render exactly one surface and primary", (count) => {
    const questions = [...grouped, { ...single[0]!, header: "Fourth", question: "Fourth question?" }].slice(0, count);
    const view = render(<AskUserCard requestId="group" questions={questions} onSubmit={() => {}} onCancel={() => {}} />);
    expect(view.getAllByText(/needs your input/)).toHaveLength(1);
    expect(view.container.querySelectorAll("[data-ask-group]")).toHaveLength(1);
    expect(view.getAllByRole("button", { name: "Go to unanswered" })).toHaveLength(1);
    expect(view.getAllByRole("button", { name: "Dismiss" })).toHaveLength(1);
    expect(view.container.querySelectorAll("[data-question-index]")).toHaveLength(count);
  });

  test("incomplete activation sends nothing, flags every gap and focuses the first", () => {
    const submitted: unknown[] = [];
    const view = render(<AskUserCard requestId="group" questions={grouped} onSubmit={(...args) => submitted.push(args)} onCancel={() => {}} />);
    fireEvent.click(view.getByText("Alpha"));
    const primary = view.getByRole("button", { name: "Go to unanswered" });
    expect(primary.hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(primary);
    expect(submitted).toEqual([]);
    const gaps = view.container.querySelectorAll('[aria-invalid="true"]');
    expect(gaps).toHaveLength(2);
    expect(document.activeElement?.closest("[data-question-index]")).toBe(gaps[0]!);
    expect(view.container.querySelector("[data-group-live]")!.textContent).toBe("2 questions still need an answer. Moved to Sections.");
    fireEvent.click(view.getByText("Intro"));
    expect(view.container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(1);
    fireEvent.click(view.getByText("Dawn"));
    expect(view.container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0);
    expect(view.container.querySelector("[data-group-live]")!.textContent).toBe("All 3 answered. Submit is ready.");
    fireEvent.click(view.getByRole("button", { name: "Submit" }));
    expect(submitted).toEqual([["group", { [QUESTION]: "Alpha", "Which sections stay?": "Intro", "When should the digest arrive?": "Dawn" }, undefined]]);
  });

  test("Other text survives blur, rerender and validation; previews travel per question", () => {
    const submitted: unknown[] = [];
    const questions = [{ ...grouped[0]!, options: [{ label: "Alpha", description: "", preview: "# First preview" }, single[0]!.options[1]!] }, ...grouped.slice(1)];
    const props = { requestId: "group", questions, onSubmit: (...args: unknown[]) => submitted.push(args), onCancel: () => {} };
    const view = render(<AskUserCard {...props} />);
    const delivery = view.getByRole("radiogroup", { name: questions[2]!.question });
    fireEvent.click(within(delivery).getByText("Other"));
    const field = view.getByRole("textbox", { name: "Your own answer, Delivery" });
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "after landfall" } });
    fireEvent.keyUp(field, { key: "l" });
    fireEvent.blur(field);
    view.rerender(<AskUserCard {...props} questions={[...questions]} />);
    expect((view.getByRole("textbox") as HTMLInputElement).value).toBe("after landfall");
    fireEvent.click(view.getByRole("button", { name: "Go to unanswered" }));
    expect(delivery.hasAttribute("aria-invalid")).toBe(false);
    fireEvent.click(view.getByText("Alpha"));
    fireEvent.click(view.getByText("Method"));
    fireEvent.click(view.getByText("Notes"));
    fireEvent.click(view.getByRole("button", { name: "Submit" }));
    expect(submitted).toEqual([["group", { [QUESTION]: "Alpha", "Which sections stay?": "Method, Notes", "When should the digest arrive?": "after landfall" }, { [QUESTION]: { preview: "# First preview" } }]]);
    view.rerender(<AskUserCard {...props} requestId="new-group" />);
    expect(view.queryByRole("textbox")).toBeNull();
    expect(view.getByText("0 of 3 answered")).toBeTruthy();
  });

  test("answered and dismissed retain one record, wrapping rows and one meta or lapsed row", () => {
    const view = render(<AskUserCard requestId="group" questions={grouped} answered={{ [QUESTION]: "Alpha", "Which sections stay?": "Intro, Notes", "When should the digest arrive?": "after landfall" }} onSubmit={() => {}} onCancel={() => {}} />);
    expect(view.getAllByText("Answered · 3 questions")).toHaveLength(1);
    expect(view.container.querySelectorAll("[data-group-record-row]")).toHaveLength(3);
    expect(view.getByText("Intro · Notes")).toBeTruthy();
    expect(view.getByText("\u201Cafter landfall\u201D")).toBeTruthy();
    expect(view.getAllByText("you answered")).toHaveLength(1);
    expect(view.queryByRole("radio")).toBeNull();
    view.rerender(<AskUserCard requestId="group" questions={grouped} cancelled onSubmit={() => {}} onCancel={() => {}} onReask={() => {}} />);
    expect(view.getAllByText("Unanswered — the turn ended")).toHaveLength(1);
    expect(view.getAllByText(DISMISSED_NOTE)).toHaveLength(1);
    expect(view.getAllByRole("button", { name: "Ask again" })).toHaveLength(1);
    expect(view.container.querySelectorAll("[data-group-record-row]")).toHaveLength(3);
  });

  test("Other Enter commits only its section and multi-select keeps focus there", () => {
    const submitted: unknown[] = [];
    const view = render(<AskUserCard requestId="group" questions={grouped} onSubmit={(...args) => submitted.push(args)} onCancel={() => {}} />);
    const first = view.getByRole("radiogroup", { name: QUESTION });
    fireEvent.click(within(first).getByText("Other"));
    const firstField = view.getByRole("textbox", { name: "Your own answer, Draft" }) as HTMLInputElement;
    act(() => firstField.focus());
    firstField.value = "keep both accounts";
    fireEvent.keyDown(firstField, { key: "Enter", isComposing: true });
    expect(view.getByRole("textbox", { name: "Your own answer, Draft" })).toBe(firstField);
    expect(submitted).toEqual([]);
    fireEvent.keyDown(firstField, { key: "Enter" });
    expect(submitted).toEqual([]);
    expect(view.queryByRole("textbox")).toBeNull();
    const middle = view.getByRole("group", { name: grouped[1]!.question });
    expect(document.activeElement?.closest('[role="group"]')).toBe(middle);
    fireEvent.click(within(middle).getByText("Other"));
    const middleField = view.getByRole("textbox", { name: "Your own answer, Sections" }) as HTMLInputElement;
    act(() => middleField.focus());
    middleField.value = "Charts";
    fireEvent.keyDown(middleField, { key: "Enter" });
    expect(submitted).toEqual([]);
    expect(view.queryByRole("textbox")).toBeNull();
    expect(document.activeElement?.closest('[role="group"]')).toBe(middle);
    fireEvent.click(view.getByText("Method"));
    fireEvent.click(view.getByText("Dawn"));
    fireEvent.click(view.getByRole("button", { name: "Submit" }));
    expect(submitted).toEqual([["group", { [QUESTION]: "keep both accounts", "Which sections stay?": "Charts, Method", "When should the digest arrive?": "Dawn" }, undefined]]);
  });

  test("reopened group submits one ordinary reask message and closes locally", () => {
    const submitted: unknown[] = [], reasked: string[] = [], cancelled: string[] = [];
    const view = render(<AskUserCard requestId="group" questions={grouped} cancelled onSubmit={(...args) => submitted.push(args)} onCancel={(id) => cancelled.push(id)} onReask={(text) => reasked.push(text)} />);
    fireEvent.click(view.getByRole("button", { name: "Ask again" }));
    fireEvent.click(view.getByText("Beta"));
    fireEvent.click(view.getByText("Intro"));
    fireEvent.click(view.getByText("Dawn"));
    fireEvent.click(view.getByRole("button", { name: "Submit" }));
    expect(reasked).toEqual([`Answering \u201C${QUESTION}\u201D: Beta\n\nAnswering \u201CWhich sections stay?\u201D: Intro\n\nAnswering \u201CWhen should the digest arrive?\u201D: Dawn`]);
    expect(submitted).toEqual([]);
    expect(view.queryByRole("radio")).toBeNull();
    expect(view.getByText(DISMISSED_NOTE)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Ask again" }));
    fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
    expect(cancelled).toEqual([]);
    expect(reasked).toHaveLength(1);
    expect(view.queryByRole("radio")).toBeNull();
  });

  test("a composer send does not consume or mutate a pending group", () => {
    const root = createBrainUiRoot({ storage: null });
    root.stores.chat.getState().startAssistantMessage(null);
    root.stores.chat.getState().setAskUserRequest(null, "group", grouped);
    const exchange = root.stores.chat.getState().draft!.askUser!;
    const sent: unknown[] = [];
    const view = render(<AskUserCard requestId={exchange.requestId} questions={exchange.questions} onSubmit={() => {}} onCancel={() => {}} />);
    fireEvent.click(view.getByText("Alpha"));
    expect(takeComposerTextAsAnswer(root.stores.chat.getState(), null, "ordinary message", (message) => sent.push(message))).toBe(false);
    expect(root.stores.chat.getState().draft!.askUser).toBe(exchange);
    expect(exchange.questions).toHaveLength(3);
    expect(exchange.answers).toBeUndefined();
    expect(sent).toEqual([]);
    view.rerender(<AskUserCard requestId={exchange.requestId} questions={exchange.questions} onSubmit={() => {}} onCancel={() => {}} />);
    expect(view.getByText("1 of 3 answered")).toBeTruthy();
    expect(view.getByRole("button", { name: "Go to unanswered" })).toBeTruthy();
    root.dispose();
  });
});

describe("ImageMaskResultCard", () => {
  const payload = {
    maskPath: "assets/images/house-mask.png",
    imagePath: "assets/images/house.png",
    bytes: 2048,
    note: "Transparent pixels mark the editable region.",
  };

  test("is a receipt over a hatched thumb, from the fields the result carries", () => {
    const { getByText, container, queryByText } = render(<ImageMaskResultCard {...payload} />);
    expect(getByText("Mask drawn")).toBeTruthy();
    expect(getByText("by you")).toBeTruthy();
    expect(getByText("assets/images/house.png")).toBeTruthy();
    expect(getByText("assets/images/house-mask.png · 2 KB")).toBeTruthy();
    expect(container.querySelector("[data-mask-thumb]")).not.toBeNull();
    // The source is never loaded inline; the MASK is drawn over the hatch
    // whenever its bytes exist.
    const overlay = container.querySelector("img[data-mask-overlay]") as HTMLImageElement;
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute("src")).toContain(encodeURIComponent("assets/images/house-mask.png"));
    expect(overlay.getAttribute("src")).toContain("raw=1");
    // The DOM here cannot fetch the PNG (it reports an error for the URL);
    // the load event stands in for the browser having it.
    fireEvent.load(overlay);
    expect(queryByText(MASK_NOT_RENDERED)).toBeNull();
    // No region in the payload: no drawn rectangle, no coverage claim — and
    // the absence is STATED on the receipt, in gold, never omitted.
    expect(container.querySelector("[data-mask-region]")).toBeNull();
    expect(getByText(REGION_NOT_RECORDED)).toBeTruthy();
    expect(maskReceiptRows(payload).map((r) => [r.k, r.v, r.tone])).toEqual([
      ["region", REGION_NOT_RECORDED, "gold"],
      ["source", "assets/images/house.png", undefined],
      ["mask", "assets/images/house-mask.png · 2 KB", undefined],
    ]);
  });

  test("the teal fill appears only once the mask PNG has loaded, and a failed load says so", () => {
    const { container, queryByText } = render(<ImageMaskResultCard {...payload} />);
    const overlay = container.querySelector("img[data-mask-overlay]") as HTMLImageElement;
    // Until the browser has the bytes there is no fill and no claim of one.
    expect(overlay.hasAttribute("data-mask-shown")).toBe(false);
    fireEvent.load(overlay);
    expect((container.querySelector("img[data-mask-overlay]") as HTMLImageElement).hasAttribute("data-mask-shown")).toBe(true);
    expect(queryByText(MASK_NOT_RENDERED)).toBeNull();

    // A mask the files route cannot serve — removed since, or a path it
    // refuses — is stated, not dressed up as a whole-image mask.
    const failed = render(<ImageMaskResultCard {...payload} maskPath="assets/images/gone-mask.png" />);
    const gone = failed.container.querySelector("img[data-mask-overlay]") as HTMLImageElement;
    fireEvent.error(gone);
    expect(failed.container.querySelector("[data-mask-shown]")).toBeNull();
    expect(failed.getByText(MASK_NOT_RENDERED)).toBeTruthy();
  });

  test("without mask bytes the thumb shows the source alone and says the mask was not rendered", () => {
    const { getByText, container } = render(<ImageMaskResultCard {...payload} bytes={0} />);
    expect(container.querySelector("[data-mask-thumb]")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(getByText(MASK_NOT_RENDERED)).toBeTruthy();
    expect(getByText(REGION_NOT_RECORDED)).toBeTruthy();
    expect(getByText("assets/images/house-mask.png · 0 B")).toBeTruthy();
  });

  test("draws the region and the coverage only when a region is supplied", () => {
    const region = { x: 0.25, y: 0.1, w: 0.5, h: 0.4 };
    const { container } = render(<ImageMaskResultCard {...payload} region={region} />);
    const drawn = container.querySelector("[data-mask-region]") as HTMLElement;
    expect(drawn).not.toBeNull();
    expect(drawn.style.left).toBe("25%");
    expect(drawn.style.width).toBe("50%");
    expect(maskReceiptRows(payload, region).map((r) => [r.k, r.v])).toEqual([
      ["region", "25%,10% → 75%,50%"],
      ["covers", "20% of the image"],
      ["source", "assets/images/house.png"],
      ["mask", "assets/images/house-mask.png · 2 KB"],
    ]);
  });

  test("a declined mask is a red fact from the result's own words", () => {
    const tool: ToolCallView = {
      id: "t1",
      name: "request_image_mask",
      input: { imagePath: "assets/images/house.png" },
      output: "Mask request cancelled: User declined",
      isError: true,
    };
    const { getByText } = render(<ImageMaskFallback tool={tool} />);
    expect(
      getByText("no mask drawn on assets/images/house.png · Mask request cancelled: User declined")
    ).toBeTruthy();
  });

  test("a sentence from an older server is shown as the text it is", () => {
    const tool: ToolCallView = {
      id: "t2",
      name: "request_image_mask",
      input: {},
      output: "Mask written to assets/images/house-mask.png",
    };
    const { container } = render(<ImageMaskFallback tool={tool} />);
    // `ClampedPre` linkifies the path, so match the text across its nodes.
    expect(container.textContent).toContain("Mask written to assets/images/house-mask.png");
    expect(container.querySelector("pre")).not.toBeNull();
  });
});

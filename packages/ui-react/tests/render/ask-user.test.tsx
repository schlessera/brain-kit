// Render tests for the ask_user exchange and the image-mask receipt (D38 §1,
// §2): props-only, keyless, mounted in happy-dom. Queries come from `render()`,
// never `screen` — see tests/render/dom.ts for why.
import { unregisterAskUserDom } from "./ask-user-dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk/protocol";
import type { ToolCallView } from "@schlessera/brain-ui-sdk/client";

import {
  AskUserCard,
  DISMISSED_NOTE,
  TYPED_META,
  answeredMeta,
  quoted,
  recordedAnswers,
} from "../../src/components/chat/ask-user-card.js";
import { reaskMessage } from "../../src/components/chat/ask-user-typed.js";
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

  test("with several questions only the last card carries the actions and answers gather", () => {
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
    expect(getAllByText("Submit")).toHaveLength(1);
    fireEvent.click(getByText("Beta"));
    fireEvent.click(getByText("Submit"));
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
    expect(getByText(quoted("merge both drafts"))).toBeTruthy();
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
    expect(reasked).toEqual([reaskMessage(single, { [QUESTION]: "Beta" })]);
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

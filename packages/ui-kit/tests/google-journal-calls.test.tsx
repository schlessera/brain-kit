import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";

import { GoogleJournalCalls, googleOperationWords, type GoogleJournalCall, type GoogleJournalCallsProps } from "../src/google/GoogleJournalCalls.js";

const call = (overrides: Partial<GoogleJournalCall> = {}): GoogleJournalCall => ({
  id: 1, operation: "gmail.modify", target: null, tainted: false, decision: "allowed", admission: null, ...overrides,
});

function draw(props: GoogleJournalCallsProps) {
  const { document } = new Window();
  document.body.innerHTML = renderToStaticMarkup(<GoogleJournalCalls {...props} />);
  return document as unknown as Document;
}

const TAINT = "Review recommended: the chat had read text other people wrote.";

describe("googleOperationWords", () => {
  test.each([
    ["gmail.modify", { text: "Gmail label change" }],
    ["gmail.draft.save", { text: "Gmail draft save" }],
    ["gmail.draft.send", { text: "Gmail send" }],
    ["gmail.draft.delete", { text: "Gmail draft delete" }],
    ["gmail.trash", { text: "Gmail trash" }],
    ["calendar.event.create", { text: "Google call", mono: "calendar.event.create" }],
    ["toString", { text: "Google call", mono: "toString" }],
  ])("%s has operation words", (operation, expected) => {
    expect(googleOperationWords(operation as string)).toEqual(expected);
  });
});

describe("GoogleJournalCalls", () => {
  test.each([
    ["approved", null, "Approved on its card"],
    ["allowed", "policy", "Allowed by policy"],
    ["allowed", "remembered_approval", "Allowed by your Google approvals"],
    ["allowed", "session_allowance", "Allowed for this chat"],
    ["allowed", null, "Allowed"],
    ["declined", null, "Declined"],
    ["refused", null, "Refused"],
  ] as const)("%s with %s reads %s", (decision, admission, words) => {
    const doc = draw({ calls: [call({ decision, admission })] });
    expect(doc.querySelector("li")?.textContent).toBe(`Gmail label change · ${words}`);
  });

  test.each([null, "gmail.modify"])("hides a redundant target %p", (target) => {
    const doc = draw({ calls: [call({ target })] });
    expect(doc.querySelector("li")?.textContent).toBe("Gmail label change · Allowed");
    expect(doc.querySelector("[data-google-journal-target]")).toBeNull();
  });

  test("shows a distinct target in wrapping mono", () => {
    const doc = draw({ calls: [call({ operation: "gmail.draft.save", target: "r-8f2c41d9e0b7a6c5" })] });
    expect(doc.querySelector("li")?.textContent).toBe("Gmail draft save · Allowed · r-8f2c41d9e0b7a6c5");
    const target = doc.querySelector<HTMLElement>("[data-google-journal-target]")!;
    // The paint is `.bk-google-mono-id` in tokens.css; the stories measure it.
    expect(target.className).toBe("bk-google-mono-id");
  });

  for (const decision of ["allowed", "approved", "declined", "refused"] as const) {
    test.each([false, true])(`tainted=%p on ${decision} only prompts admitted calls`, (tainted) => {
      const doc = draw({ calls: [call({ decision, tainted })] });
      expect(doc.querySelectorAll("li")).toHaveLength(1);
      const expected = tainted && (decision === "allowed" || decision === "approved") ? [TAINT] : [];
      expect([...doc.querySelectorAll("[data-google-journal-taint]")].map((el) => el.textContent)).toEqual(expected);
    });
  }

  test.each([false, true])("truncated=%p reports retained extra rows only when requested", (truncated) => {
    const doc = draw({ calls: [call()], truncated });
    expect(doc.querySelector("li")?.textContent).toBe("Gmail label change · Allowed");
    expect([...doc.querySelectorAll("section > p")].map((el) => el.textContent)).toEqual([
      "These record each decision, not that Google applied it. Brain recorded how to reverse each admitted change, but restoring local files does not reverse them. Undo is not available here yet.",
      ...(truncated ? ["Showing the first 1,000 reversible Google calls. More remain in the retained governance records."] : []),
    ]);
  });

  test.each([false, true])("empty calls render nothing, truncated=%p", (truncated) => {
    expect(renderToStaticMarkup(<GoogleJournalCalls calls={[]} truncated={truncated} />)).toBe("");
  });

  test.each([undefined, 2, 3, 4] as const)("heading level %p is semantic", (headingLevel) => {
    const doc = draw({ calls: [call()], headingLevel });
    const headings = doc.querySelectorAll("h2, h3, h4");
    expect(headings).toHaveLength(1);
    expect(headings[0]!.tagName).toBe(`H${headingLevel ?? 3}`);
    expect(headings[0]!.textContent).toBe("Reversible Google calls");
  });

  test("an unknown operation draws its id in mono", () => {
    const doc = draw({ calls: [call({ operation: "calendar.event.create" })] });
    expect(doc.querySelector("li")?.textContent).toBe("Google call calendar.event.create · Allowed");
    const id = doc.querySelector<HTMLElement>("[data-google-operation-id]")!;
    expect(id.textContent).toBe("calendar.event.create");
    expect(id.className).toBe("bk-google-mono-id");
  });
});

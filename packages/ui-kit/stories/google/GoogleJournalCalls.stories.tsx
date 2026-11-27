import preview from "#.storybook/preview";
import { expect, within } from "storybook/test";

import { GoogleJournalCalls, type GoogleJournalCall } from "../../src/index.js";
import { viewportAt } from "../_viewports.js";

const HEADING = "Reversible Google calls";
const TAINT = "Review recommended: the chat had read text other people wrote.";
const DRAFT_ID = "r-8f2c41d9e0b7a6c5";
const LONG_ID = `r-${"8f2c41d9e0b7a6c5".repeat(13).slice(0, 198)}`;
const row = (id: number, overrides: Partial<GoogleJournalCall> = {}): GoogleJournalCall => ({
  id, operation: "gmail.modify", target: "gmail.modify", decision: "allowed", admission: null, tainted: false, ...overrides,
});
const MIXED = [
  row(1, { admission: "session_allowance", tainted: true }),
  row(2, { operation: "gmail.draft.save", target: DRAFT_ID, decision: "approved" }),
  row(3, { decision: "declined" }),
  row(4, { admission: "policy" }),
];
const MIXED_WORDS = ["Gmail label change · Allowed for this chat", `Gmail draft save · Approved on its card · ${DRAFT_ID}`, "Gmail label change · Declined", "Gmail label change · Allowed by policy"];

const meta = preview.meta({
  title: "Google/Journal calls",
  component: GoogleJournalCalls,
  decorators: [(Story, context) => (
    <div data-google-journal-frame="" style={{ width: (context.parameters.journalWidth as number | undefined) ?? 680, minHeight: 20, flex: "none", fontSize: 14, lineHeight: 1.43 }}>
      <Story />
    </div>
  )],
  args: { calls: MIXED },
  parameters: { journalWidth: 680 },
});
const narrow = { globals: viewportAt(320), parameters: { journalWidth: 320 } };

/** The same receipt claims at both widths; Storybook's projects own theme parity. */
function check(rows: readonly string[], taints: number, truncated = false) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: HEADING, level: 3 })).toBeVisible();
    const root = canvasElement.querySelector<HTMLElement>("[data-google-journal-calls]")!;
    await expect([...root.querySelectorAll("[data-google-journal-row]")].map((el) => el.textContent)).toEqual(rows);
    await expect(canvas.getAllByRole("listitem")).toHaveLength(rows.length);
    await expect(canvas.queryAllByText(TAINT)).toHaveLength(taints);
    await expect(canvas.queryAllByText("Showing the first 1,000 reversible Google calls. More remain in the retained governance records.")).toHaveLength(truncated ? 1 : 0);
    await expect(root.scrollWidth, "the journal has no horizontal overflow").toBeLessThanOrEqual(root.clientWidth);
    const heading = canvas.getByRole("heading", { name: HEADING });
    await expect(getComputedStyle(root).fontSize, "inherits the journal's body size").toBe("14px");
    await expect(getComputedStyle(heading).fontSize).toBe("14px");
    await expect(getComputedStyle(heading).fontWeight).toBe("500");
    const list = canvas.getByRole("list");
    await expect(getComputedStyle(list).rowGap).toBe(matchMedia("(any-pointer: coarse)").matches ? "16px" : "8px");
    await expect(getComputedStyle(list).marginTop).toBe("8px");
    await expect(getComputedStyle(root.querySelector("p")!).marginTop).toBe("8px");
    await expect(getComputedStyle(list).listStyleType).toBe("none");
    await expect(root.querySelectorAll("button, a, [tabindex], svg"), "receipts are not interactive and have no icons").toHaveLength(0);
  };
}

export const Mixed = meta.story({ play: check(MIXED_WORDS, 1) });
export const MixedNarrow = Mixed.extend(narrow);

export const EveryDecision = meta.story({
  args: { calls: [
    row(1, { decision: "approved" }),
    row(2, { admission: "policy" }),
    row(3, { admission: "remembered_approval" }),
    row(4, { admission: "session_allowance" }),
    row(5), row(6, { decision: "declined" }), row(7, { decision: "refused" }),
  ] },
  play: check([
    "Gmail label change · Approved on its card", "Gmail label change · Allowed by policy", "Gmail label change · Allowed by your Google approvals",
    "Gmail label change · Allowed for this chat", "Gmail label change · Allowed", "Gmail label change · Declined", "Gmail label change · Refused",
  ], 0),
});
export const EveryDecisionNarrow = EveryDecision.extend(narrow);

export const TaintedDeclined = meta.story({
  args: { calls: [row(1, { tainted: true, decision: "declined" }), row(2, { tainted: true, decision: "refused" })] },
  play: check(["Gmail label change · Declined", "Gmail label change · Refused"], 0),
});
export const TaintedDeclinedNarrow = TaintedDeclined.extend(narrow);

export const LongTarget = meta.story({
  args: { calls: [row(1, { operation: "gmail.draft.save", target: LONG_ID, decision: "approved" })] },
  play: async (context) => {
    await check([`Gmail draft save · Approved on its card · ${LONG_ID}`], 0)(context);
    const target = context.canvasElement.querySelector<HTMLElement>("[data-google-journal-target]")!;
    await expect(target.textContent).toHaveLength(200);
    await expect(getComputedStyle(target).overflowWrap).toBe("anywhere");
    await expect(getComputedStyle(target).fontFamily).toMatch(/JetBrains Mono/);
    await expect(getComputedStyle(target).fontSize).toBe("11.5px");
    await expect(target.getClientRects().length, "the long id wraps").toBeGreaterThan(1);
  },
});
export const LongTargetNarrow = LongTarget.extend(narrow);

export const UnknownOperation = meta.story({
  args: { calls: [row(1, { operation: "calendar.event.create", target: null })] },
  play: async (context) => {
    await check(["Google call calendar.event.create · Allowed"], 0)(context);
    const id = context.canvasElement.querySelector<HTMLElement>("[data-google-operation-id]")!;
    await expect(id.textContent).toBe("calendar.event.create");
    await expect(getComputedStyle(id).fontFamily).toMatch(/JetBrains Mono/);
  },
});
export const UnknownOperationNarrow = UnknownOperation.extend(narrow);

export const Truncated = meta.story({ args: { calls: MIXED.slice(0, 3), truncated: true }, play: check(MIXED_WORDS.slice(0, 3), 1, true) });
export const TruncatedNarrow = Truncated.extend(narrow);

export const Empty = meta.story({
  args: { calls: [] },
  play: async ({ canvasElement }) => {
    const frame = canvasElement.querySelector<HTMLElement>("[data-google-journal-frame]")!;
    await expect(frame, "the story mounted its frame").not.toBeNull();
    await expect(frame.innerHTML, "empty input renders nothing").toBe("");
    await expect(within(canvasElement).queryByRole("heading")).toBeNull();
    await expect(within(canvasElement).queryAllByRole("listitem")).toHaveLength(0);
    await expect(within(canvasElement).queryAllByText(TAINT)).toHaveLength(0);
    await expect(frame.scrollWidth).toBeLessThanOrEqual(frame.clientWidth);
  },
});
export const EmptyNarrow = Empty.extend(narrow);

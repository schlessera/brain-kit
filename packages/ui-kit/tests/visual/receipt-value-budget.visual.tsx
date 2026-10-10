/**
 * The Receipt value budget on a 320px phone, measured in a real browser (#315).
 *
 * A toned row draws its tone's glyph inline before the value (#309), and the
 * glyph takes width the value used to have. How much is a question about
 * layout — the glyph's box, its margin, the mono advance at 11px — so the
 * figures below are what Chromium lays out, not arithmetic over tokens. The
 * `receipt` line of `show_block`'s description states the toned figure to
 * the model (`packages/ui-sdk/src/tool-contracts/blocks.ts`), so a change
 * that moves it moves that sentence too.
 *
 * Measured in the box a drawn receipt gets in the chat on a 320px phone,
 * with the component's own key column, the default 56px. The chat's message
 * list pads its scroller `px-4` below `md` and centres a `max-w-3xl` reading
 * column inside it (`scrollRef`,
 * `packages/ui-react/src/components/chat/chat-page.tsx:670-676`); below
 * `tablet` the side rail is hidden and the tab bar is fixed to the bottom,
 * so neither takes width. Between that column and the receipt sit the
 * message's `py-4`, the answer's `space-y-3` and `BlockCard`'s bare `div`
 * (`packages/ui-react/src/components/chat/tool-cards/block-card.tsx`), none
 * of them horizontal. So the receipt box is 320 - 2 x 16 = 288px, and its
 * value column 288 - 2 (border) - 24 (row padding) - 56 - 10 (gap) = 196px.
 * A phone's overlay scrollbar takes none of it.
 *
 * ## The font
 *
 * The shared browser setup loads the checksum-pinned JetBrains Mono faces.
 * The first assertion measures their advance in the pinned Chromium image.
 * Budgets remain conservative fit guarantees for the chat's 288px box;
 * changing chat gutters or the locked mono face requires remeasurement.
 *
 * It lives in the visual project because that is the runner with a layout
 * engine; it takes no screenshot.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import "../../src/styles.css";
import { Receipt, type ReceiptRow } from "../../src/evidence/Receipt.js";

/** The receipt box in the chat at a 320px viewport, derived above. */
const WIDTH = 288;
/** The longest value that stays on one line, per row kind. */
const UNTONED_BUDGET = 28;
const TONED_BUDGET = 25;

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

/** Digits only: a `·` or `%` can fall back to another face with another
 * advance, and the budget is a count of mono characters. */
function value(length: number): string {
  return Array.from({ length }, (_, i) => String((i + 1) % 10)).join("");
}

/** Renders one row in the chat's 288px box and returns its value element. */
function renderRow(row: ReceiptRow): HTMLElement {
  host?.remove();
  host = document.createElement("div");
  host.style.width = `${WIDTH}px`;
  document.body.append(host);
  const root = host;
  flushSync(() => createRoot(root).render(<Receipt title="" footnote="" rows={[row]} />));
  const cell = root.querySelector<HTMLElement>("[data-tone]");
  if (!cell) throw new Error("the receipt rendered no value cell");
  return cell;
}

function textRange(cell: HTMLElement): Range {
  const text = [...cell.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
  if (!text) throw new Error("the value cell has no text node");
  const range = document.createRange();
  range.selectNodeContents(text);
  return range;
}

/** How many lines the value's TEXT occupies: one client rect per line box
 * the text sits on. Counted on the text rather than the cell's height,
 * because the inline glyph is pulled down 1.5px and could grow a line box
 * without adding a line. */
function lines(cell: HTMLElement): number {
  return new Set([...textRange(cell).getClientRects()].map((rect) => Math.round(rect.top))).size;
}

describe("receipt: the value budget in the chat at a 320px viewport", () => {
  test("the value column is 196px and the mono advance is 7px", () => {
    const cell = renderRow({ k: "path", v: value(10) });
    expect(cell.getBoundingClientRect().width).toBe(196);
    expect(textRange(cell).getBoundingClientRect().width).toBe(70);
  });

  // Split in four, so each "one more wraps" assertion is the first thing
  // its test checks: the glyph's presence is asserted in the at-budget test,
  // and deleting the glyph fails the toned "wraps" test on the wrap itself.
  test(`an untoned value of ${UNTONED_BUDGET} characters stays on one line`, () => {
    const cell = renderRow({ k: "path", v: value(UNTONED_BUDGET) });
    expect(cell.querySelector("[data-cue]")).toBeNull();
    expect(lines(cell)).toBe(1);
  });

  test(`an untoned value of ${UNTONED_BUDGET + 1} characters wraps`, () => {
    expect(lines(renderRow({ k: "path", v: value(UNTONED_BUDGET + 1) }))).toBe(2);
  });

  // Red, because it draws a glyph; teal is the one accent that does not.
  test(`a toned value of ${TONED_BUDGET} characters stays on one line`, () => {
    const cell = renderRow({ k: "coverage", v: value(TONED_BUDGET), tone: "red" });
    expect(cell.querySelector("[data-cue]")).not.toBeNull();
    expect(lines(cell)).toBe(1);
  });

  test(`a toned value of ${TONED_BUDGET + 1} characters wraps`, () => {
    expect(lines(renderRow({ k: "coverage", v: value(TONED_BUDGET + 1), tone: "red" }))).toBe(2);
  });
});

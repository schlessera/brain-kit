/**
 * The Receipt value budget at 320px, measured in a real browser (#315).
 *
 * A toned row draws its tone's glyph inline before the value (#309), and the
 * glyph takes width the value used to have. How much is a question about
 * layout — the glyph's box, its margin, the mono advance at 11px — so the
 * figures below are what Chromium lays out, not arithmetic over tokens. The
 * `receipt` line of `show_block`'s description states the toned figure to
 * the model (`packages/ui-sdk/src/tool-contracts/blocks.ts`), so a change
 * that moves it moves that sentence too.
 *
 * Measured in a 320px box with the component's own key column, the default
 * 56px, which leaves the value 228px.
 *
 * ## The font
 *
 * The kit bundles no fonts (`docs/decisions/design-kit.md`) and this project
 * loads none, so `'JetBrains Mono'` falls through the stack to the image's
 * `monospace`: WenQuanYi Zen Hei Mono, a CJK face whose Latin advance is
 * 0.5em, which measured budgets a fifth too generous for the face a reader
 * gets. A monospace font's line breaks depend on one number, its advance,
 * so the test names Liberation Mono (in the image, 1229/2048 em) as
 * `JetBrains Mono` (600/1000 em). No network, no new dependency.
 *
 * Chromium in the pinned image lays that advance out on whole pixels: 6.6px
 * at 11px becomes 7. A renderer with subpixel positioning keeps 6.6 and fits
 * about two characters more, so the figures measured here are the lower
 * ones and hold on both. The first assertion pins the 7px advance, so a
 * stand-in or a renderer that moves it says so before the budgets do.
 *
 * It lives in the visual project because that is the runner with a layout
 * engine; it takes no screenshot.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import "../../src/styles.css";
import { Receipt, type ReceiptRow } from "../../src/evidence/Receipt.js";

const WIDTH = 320;
/** The longest value that stays on one line, per row kind. */
const UNTONED_BUDGET = 32;
const TONED_BUDGET = 30;

let host: HTMLDivElement | null = null;

beforeAll(async () => {
  const face = new FontFace("JetBrains Mono", 'local("Liberation Mono"), local("LiberationMono")', { weight: "400 600" });
  document.fonts.add(await face.load());
});

afterEach(() => {
  host?.remove();
  host = null;
});

/** Digits only: a `·` or `%` can fall back to another face with another
 * advance, and the budget is a count of mono characters. */
function value(length: number): string {
  return Array.from({ length }, (_, i) => String((i + 1) % 10)).join("");
}

/** Renders one row at 320px and returns its value element. */
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

describe("receipt: the value budget at 320px", () => {
  test("the value column is 228px and the mono advance is 7px", () => {
    const cell = renderRow({ k: "path", v: value(10) });
    expect(cell.getBoundingClientRect().width).toBe(228);
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
